const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { adminAuth, requireAdminRole } = require("../middleware/auth");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Property = require("../models/Property");
const Draft = require("../models/Draft");
const ProspectEmail = require("../models/ProspectEmail");
const Report = require("../models/Report");
const SupportTicket = require("../models/SupportTicket");
const { geocodeAddress } = require("../utils/geocode");
const Payment = require("../models/Payment");
const Review = require("../models/Review");
const Market = require("../models/Market");
const Category = require("../models/Category");
const Broadcast = require("../models/Broadcast");
const BroadcastTemplate = require("../models/BroadcastTemplate");
const PlatformSettings = require("../models/PlatformSettings");
const { generateOTP, storeOTP, verifyOTP } = require("../utils/otp");
const SupportAccessLog = require("../models/SupportAccessLog");
const SupportAccessRequest = require("../models/SupportAccessRequest");
const { generateInvoicePDF } = require("../utils/generateInvoice");
const sendEmail = require("../utils/sendEmail");
const sendSMS = require("../utils/sendSMS");
const createNotification = require("../utils/notify");
const { client: redisClient } = require("../utils/redisClient");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

const signAdminToken = async (user) => {
  const settings = await PlatformSettings.getSettings();
  return jwt.sign(
    { id: user._id, isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: `${settings.sessionTimeoutMinutes}m` }
  );
};

const adminUserPayload = (user) => ({
  _id: user._id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  isAdmin: user.isAdmin,
});

// ─── Admin login (separate from regular user login) ──────────────────────────
// Second factor (email OTP) is gated by PlatformSettings.requireAdmin2FA —
// Settings -> Security tab. Defaults on: admin accounts are the most
// sensitive tier on the platform and previously had NO 2FA at all, unlike
// every regular user, who already goes through this same OTP step on every
// login (see routes/auth.js /login + /verify-login).
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: "Invalid admin credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(403).json({ error: "Invalid admin credentials" });
    }

    const settings = await PlatformSettings.getSettings();
    if (!settings.requireAdmin2FA) {
      const token = await signAdminToken(user);
      return res.json({ success: true, token, user: adminUserPayload(user) });
    }

    const otp = generateOTP();
    await storeOTP(`admin:${user.email}`, otp);
    await sendEmail({
      to: user.email,
      subject: "Admin Login Verification Code",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
          <p>An admin login was attempted for this account. Use the code below to complete it:</p>
          <p style="font-size:28px;font-weight:800;letter-spacing:4px;color:#0A1628;">${otp}</p>
          <p style="font-size:13px;color:#9CA3AF;">Expires in 10 minutes. If this wasn't you, ignore this email.</p>
        </div>
      `,
    });

    res.json({ requiresVerification: true, message: "OTP sent to email" });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/verify-login", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: "Email and OTP are required" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.isAdmin) return res.status(403).json({ error: "Invalid admin credentials" });

    const valid = await verifyOTP(`admin:${user.email}`, otp);
    if (!valid) return res.status(400).json({ error: "Invalid or expired code" });

    const token = await signAdminToken(user);
    res.json({ success: true, token, user: adminUserPayload(user) });
  } catch (err) {
    console.error("Admin verify-login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// All admin routes require adminAuth
router.use(adminAuth);

// Tiered access on top of adminAuth — full_admin always passes every gate.
// /stats and /overview-analytics are intentionally left ungated (every tier
// sees the dashboard home). Team management stays full_admin-only below.
router.use(["/users", "/verifications", "/reports", "/properties", "/bookings", "/support-tickets", "/drafts", "/prospect-emails"], requireAdminRole("support"));
router.use(["/payments", "/payouts", "/invoices", "/commission"], requireAdminRole("finance"));
router.use(["/markets", "/categories", "/broadcast"], requireAdminRole("content"));
router.use(["/team", "/settings"], requireAdminRole());

// ─── Dashboard stats ──────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const [users, properties, bookings, reports, pendingVerifications, escrowPending, activeUsers, pendingListings] = await Promise.all([
      User.countDocuments(),
      Property.countDocuments({ isActive: true }),
      Booking.countDocuments(),
      Report.countDocuments({ status: "open" }),
      User.countDocuments({ "businessVerification.status": "under_review" }),
      Booking.find({ isPaid: true, escrowReleased: false, status: "completed" }).select("hostAmount"),
      // Platform-wide, unlike the client's old page-scoped filter (which
      // only ever looked at whatever 20 users / 50 listings happened to be
      // on the currently-fetched page, silently under-reporting once there
      // was more than one page of either).
      User.countDocuments({ isBanned: { $ne: true } }),
      Property.countDocuments({ isActive: false }),
    ]);
    const totalEscrow = escrowPending.reduce((s, b) => s + b.hostAmount, 0);
    res.json({
      users,
      properties,
      bookings,
      openReports: reports,
      pendingVerifications,
      totalEscrowPending: totalEscrow,
      activeUsers,
      pendingListings,
    });
  } catch { res.status(500).json({ error: "Server error" }); }
});

router.get("/overview-analytics", async (req, res) => {
  try {
    const Booking = require("../models/Booking");
    const Property = require("../models/Property");

    // Revenue & bookings by month, last 12 months
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyBookings = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: twelveMonthsAgo },
          status: { $in: ["confirmed", "completed"] },
        },
      },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          revenue: { $sum: "$totalPrice" },
          bookings: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const chartData = monthlyBookings.map((m) => ({
      month: monthNames[m._id.month - 1],
      revenue: m.revenue || 0,
      bookings: m.bookings || 0,
    }));

    // Listings by category
    const categoryBreakdown = await Property.aggregate([
      { $group: { _id: "$category", count: { $sum: 1 } } },
      {
        $lookup: {
          from: "categories",
          localField: "_id",
          foreignField: "_id",
          as: "categoryInfo",
        },
      },
      { $unwind: { path: "$categoryInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: { $ifNull: ["$categoryInfo.name", "Uncategorized"] },
          count: 1,
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      chartData,
      categoryData: categoryBreakdown.map((c) => ({ name: c.name, count: c.count })),
    });
  } catch (err) {
    console.error("Error fetching overview analytics:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Users ────────────────────────────────────────────────────────────────────
router.get("/users", async (req, res) => {
  const { page = 1, limit = 20, q, role } = req.query;
  const filter = {};
  if (q) filter.$or = [{ email: { $regex: q, $options: "i" } }, { firstName: { $regex: q, $options: "i" } }];
  if (role === "host") filter.isHost = true;
  if (role === "customer") filter.isHost = { $ne: true };
  if (role === "admin") filter.isAdmin = true;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [users, total] = await Promise.all([
    User.find(filter).select("-password -otp -otpExpires").sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    User.countDocuments(filter),
  ]);
  res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

router.patch("/users/:id/ban", async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isBanned: req.body.ban ?? true }, { new: true }).select("-password");
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

// Full-admin-only even though the broader /users prefix is support-tier —
// granting/revoking admin access is a privilege-escalation-sensitive action.
router.patch("/users/:id/admin", requireAdminRole(), async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isAdmin: req.body.isAdmin ?? true }, { new: true }).select("-password");
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

// Admin-triggered password reset — sends the same OTP email used by the
// self-service "forgot password" flow, so the user finishes it themselves
// on /forgot-password. Admin never sees or sets the new password.
// Creates a host account directly, bypassing OTP signup entirely -- hosts
// keep asking staff to build their listing for them, and waiting on OTP
// codes back and forth isn't practical for that workflow. isVerified is set
// true up front so /auth/login logs straight in with the returned password,
// no OTP step (see the isVerified branch in that route). createdByAdmin is
// the audit trail for this account not having gone through normal signup.
router.post("/users/create-host", async (req, res) => {
  try {
    const { email, firstName, lastName, phoneNumber } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    const tempPassword = crypto.randomBytes(9).toString("base64url");
    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    const user = new User({
      email: normalizedEmail,
      password: hashedPassword,
      firstName: firstName || "",
      lastName: lastName || "",
      phoneNumber: phoneNumber || "",
      isHost: true,
      isVerified: true,
      createdByAdmin: req.user.id,
    });
    await user.save();

    res.status(201).json({
      success: true,
      tempPassword,
      user: { id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    });
  } catch (err) {
    console.error("Admin create-host error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/users/:id/reset-password", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("email displayName firstName");
    if (!user) return res.status(404).json({ error: "User not found" });

    const otp = generateOTP();
    await redisClient.setEx(`otp:pwd:${user.email.toLowerCase().trim()}`, 600, otp);

    const name = user.displayName || user.firstName || "there";
    await sendEmail({
      to: user.email,
      subject: "Password Reset OTP",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#0A1628;">Password Reset Requested</h2>
          <p>Hi ${name}, a VenCome admin has started a password reset for your account. Use the code below on the password reset page:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#0A1628;">${otp}</p>
          <p style="color:#6B7280;font-size:13px;">This code expires in 10 minutes. If you didn't expect this, you can ignore it and your password will stay the same.</p>
        </div>
      `,
    });

    res.json({ success: true, message: "Reset code emailed to the user" });
  } catch (err) {
    console.error("Admin reset password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Consent-based Account Access (also powers the Technical Support panel
// and the password-reset admin-assist option — one system, three entry
// points; see routes/supportAccess.js for the user-facing grant/deny side).

// POST /users/:id/support-access/request — admin requests access, with an
// optional reason/ticket reference. Emails the user a secure grant/deny
// link, branded as VenCome Support only — JetherVerse never appears here.
router.post("/users/:id/support-access/request", async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await User.findById(req.params.id).select("isAdmin email firstName lastName displayName");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.isAdmin) return res.status(403).json({ error: "Cannot request access to an admin account" });

    const existing = await SupportAccessRequest.findOne({ user: user._id, status: "pending" });
    if (existing) return res.status(409).json({ error: "There's already a pending request for this user." });

    const token = crypto.randomBytes(32).toString("hex");
    const request = await SupportAccessRequest.create({
      user: user._id,
      admin: req.user.id,
      reason: reason || "",
      token,
    });

    await SupportAccessLog.create({
      user: user._id,
      admin: req.user.id,
      request: request._id,
      reason: reason || "",
      action: "requested",
    });

    const link = `${process.env.CLIENT_URL}/support-access/${token}`;
    const name = user.firstName || user.displayName || "there";
    await sendEmail({
      to: user.email,
      subject: "VenCome Support is requesting access to your account",
      text: `Hi ${name},\n\nVenCome Support would like to view your account to help with: ${reason || "a support request"}.\n\nYou can review and decide here: ${link}\n\nThis request expires in 24 hours if you don't respond, and you can decline at any time.\n\n— VenCome Support`,
      html: `<p>Hi ${name},</p><p>VenCome Support would like to view your account to help with: <strong>${reason || "a support request"}</strong>.</p><p><a href="${link}">Review this request</a></p><p>This request expires in 24 hours if you don't respond, and you can decline at any time.</p><p>— VenCome Support</p>`,
    }).catch((err) => console.error("Support access request email failed:", err.message));

    res.json({ success: true, requestId: request._id });
  } catch (err) {
    console.error("Support access request error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /users/:id/support-access/status — current state for the admin Users
// row action menu: none, pending, granted (active), or expired/denied.
router.get("/users/:id/support-access/status", async (req, res) => {
  try {
    const request = await SupportAccessRequest.findOne({ user: req.params.id }).sort({ createdAt: -1 });
    if (!request) return res.json({ status: "none" });

    const isActiveSession =
      request.status === "granted" &&
      !request.sessionEndedAt &&
      request.sessionExpiresAt &&
      new Date(request.sessionExpiresAt) > new Date();

    res.json({
      status: isActiveSession ? "active" : request.status,
      sessionExpiresAt: request.sessionExpiresAt,
      requestedAt: request.requestedAt,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Log in as a user with an active, granted, unexpired access session.
// Admins cannot reach this without the user having granted it first.
router.post("/users/:id/impersonate", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("isAdmin email firstName lastName displayName isHost");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.isAdmin) return res.status(403).json({ error: "Cannot log in as an admin account" });

    const request = await SupportAccessRequest.findOne({
      user: user._id,
      status: "granted",
      sessionEndedAt: { $exists: false },
    }).sort({ createdAt: -1 });

    if (!request || !request.sessionExpiresAt || new Date(request.sessionExpiresAt) < new Date()) {
      return res.status(403).json({ error: "This user has not granted active support access" });
    }

    const token = jwt.sign(
      { id: user._id, impersonatedBy: req.user.id, supportRequestId: request._id.toString() },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    await SupportAccessLog.create({
      user: user._id,
      admin: req.user.id,
      request: request._id,
      action: "accessed",
    });

    res.json({
      token,
      sessionExpiresAt: request.sessionExpiresAt,
      userName: user.displayName || [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
    });
  } catch (err) {
    console.error("Impersonate error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /users/:id/support-access/end-session — admin ends an active session
// early, from the persistent "Viewing as X" banner's Return to Admin button.
router.post("/users/:id/support-access/end-session", async (req, res) => {
  try {
    const request = await SupportAccessRequest.findOne({
      user: req.params.id,
      status: "granted",
      sessionEndedAt: { $exists: false },
    }).sort({ createdAt: -1 });

    if (request) {
      request.sessionEndedAt = new Date();
      await request.save();
      await SupportAccessLog.create({
        user: request.user,
        admin: req.user.id,
        request: request._id,
        action: "ended",
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Audit trail for the flow above — every request/grant/deny/expiry/access/
// end for a given user.
router.get("/users/:id/support-access-logs", async (req, res) => {
  try {
    const logs = await SupportAccessLog.find({ user: req.params.id })
      .populate("admin", "firstName lastName displayName email")
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Delete a user — guarded the same way as self-service account deletion
// (DELETE /auth/account) so admins can't silently orphan live listings,
// pending bookings, or payouts still sitting in escrow.
router.delete("/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.isAdmin) return res.status(400).json({ error: "Remove admin access before deleting this user" });

    const [activeListings, unresolvedBookings, unpaidOutBookings] = await Promise.all([
      Property.countDocuments({ host: userId, isActive: true }),
      Booking.countDocuments({
        $or: [{ host: userId }, { guest: userId }],
        status: { $in: ["pending", "confirmed"] },
      }),
      Booking.countDocuments({ host: userId, isPaid: true, escrowReleased: false }),
    ]);

    if (activeListings > 0) {
      return res.status(400).json({ error: `This user has ${activeListings} active listing(s). Deactivate them first.` });
    }
    if (unresolvedBookings > 0) {
      return res.status(400).json({ error: `This user has ${unresolvedBookings} pending or confirmed booking(s). Resolve them first.` });
    }
    if (unpaidOutBookings > 0) {
      return res.status(400).json({ error: `This user has ${unpaidOutBookings} booking(s) with a payout still in escrow.` });
    }

    await User.findByIdAndDelete(userId);
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    console.error("Admin delete user error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// General account-detail editor for admin -- deliberately scoped to plain
// identity fields only. Role/permission changes (isAdmin, isHost, ban)
// already have their own dedicated endpoints above; phoneNumber is
// excluded on purpose since it's only ever meant to be set through the
// OTP-verified change flow (see routes/settings.js) -- letting admin set
// it directly here would create an unverified-looking number with no way
// to tell it apart from a real verified one.
router.patch("/users/:id", async (req, res) => {
  try {
    const { firstName, lastName, displayName, email } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (email && email.trim().toLowerCase() !== user.email) {
      const normalizedEmail = email.trim().toLowerCase();
      const duplicate = await User.exists({ email: normalizedEmail, _id: { $ne: user._id } });
      if (duplicate) return res.status(400).json({ error: "That email is already in use" });
      user.email = normalizedEmail;
    }
    if (firstName !== undefined) user.firstName = firstName.trim();
    if (lastName !== undefined) user.lastName = lastName.trim();
    if (displayName !== undefined) user.displayName = displayName.trim();

    await user.save();
    res.json({
      success: true,
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        displayName: user.displayName,
        email: user.email,
      },
    });
  } catch (err) {
    console.error("Admin edit user error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Verifications ────────────────────────────────────────────────────────────
router.get("/verifications", async (req, res) => {
  const users = await User.find({ "businessVerification.status": "under_review" })
    .select("firstName lastName email businessVerification")
    .sort({ "businessVerification.submittedAt": 1 });
  res.json(users);
});

router.patch("/verifications/:userId", async (req, res) => {
  const { status, notes } = req.body; // status: "verified" | "rejected"
  if (!["verified", "rejected"].includes(status))
    return res.status(400).json({ error: "Status must be verified or rejected" });

  const user = await User.findByIdAndUpdate(
    req.params.userId,
    {
      "businessVerification.status": status,
      businessVerified: status === "verified",
      "businessVerification.resolvedAt": new Date(),
      "businessVerification.notes": notes,
    },
    { new: true }
  ).select("firstName lastName email businessVerification businessVerified");

  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

// ─── Reports ─────────────────────────────────────────────────────────────────
router.get("/reports", async (req, res) => {
  const { status = "open", page = 1, limit = 20 } = req.query;
  const filter = status !== "all" ? { status } : {};
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [reports, total] = await Promise.all([
    Report.find(filter).populate("reporter", "firstName lastName email").sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Report.countDocuments(filter),
  ]);

  // Enrich each report with a lightweight "target" summary depending on its type,
  // so the admin UI can show what's actually being disputed without extra round-trips.
  const enriched = await Promise.all(
    reports.map(async (report) => {
      const obj = report.toObject();
      try {
        if (report.type === "booking") {
          const booking = await Booking.findById(report.targetId)
            .populate("property", "title")
            .populate("guest", "firstName lastName displayName")
            .populate("host", "firstName lastName displayName");
          if (booking) {
            obj.target = {
              label: booking.property?.title || "Booking",
              amount: booking.totalPrice,
              customer: booking.guest?.displayName || `${booking.guest?.firstName || ""} ${booking.guest?.lastName || ""}`.trim(),
              host: booking.host?.displayName || `${booking.host?.firstName || ""} ${booking.host?.lastName || ""}`.trim(),
              bookingId: booking._id,
            };
          }
        } else if (report.type === "property") {
          const property = await Property.findById(report.targetId).populate("host", "firstName lastName displayName");
          if (property) {
            obj.target = {
              label: property.title,
              host: property.host?.displayName || `${property.host?.firstName || ""} ${property.host?.lastName || ""}`.trim(),
            };
          }
        } else if (report.type === "user") {
          const user = await User.findById(report.targetId);
          if (user) {
            obj.target = { label: user.displayName || `${user.firstName || ""} ${user.lastName || ""}`.trim() };
          }
        } else if (report.type === "review") {
          const review = await Review.findById(report.targetId).populate("property", "title");
          if (review) {
            obj.target = { label: review.property?.title || "Review", host: undefined };
          }
        }
      } catch {
        // Target may have been deleted since the report was filed — leave obj.target undefined
      }
      return obj;
    })
  );

  res.json({ reports: enriched, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

router.patch("/reports/:id", async (req, res) => {
  const { status, notes } = req.body;
  const report = await Report.findByIdAndUpdate(
    req.params.id,
    { status, notes, resolvedBy: req.user.id, resolvedAt: new Date() },
    { new: true }
  );
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json(report);
});

// ─── Support tickets ────────────────────────────────────────────────────────
// GET /support-tickets — all tickets (not scoped to one user), paginated + filtered.
// Sort is lastMessageAt desc with priority used only as a filter, not a sort
// key: Mongo sorts strings lexicographically, so sorting directly by the
// `priority` enum string wouldn't order low/normal/high/urgent correctly. A
// dedicated numeric sort-order field would fix that but is unneeded scope for
// this pass, so priority ordering is left to the `priority` filter param instead.
router.get("/support-tickets", async (req, res) => {
  const { status, category, priority, assignedToMe, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (priority) filter.priority = priority;
  if (assignedToMe === "true") filter.assignedAdmin = req.user.id;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter)
      .populate("user", "displayName firstName lastName email")
      .populate("assignedAdmin", "displayName firstName lastName")
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    SupportTicket.countDocuments(filter),
  ]);

  res.json({ tickets, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// PATCH /support-tickets/:id — update status/priority/assignedAdmin.
router.patch("/support-tickets/:id", async (req, res) => {
  const { status, priority, assignedAdmin } = req.body;
  const update = {};
  if (status !== undefined) update.status = status;
  if (priority !== undefined) update.priority = priority;
  if (assignedAdmin !== undefined) update.assignedAdmin = assignedAdmin;
  if (status === "resolved") {
    update.resolvedAt = new Date();
    update.resolvedBy = req.user.id;
  }

  const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  if (status !== undefined) {
    const io = req.app.get("io");
    io?.to(`ticket_${ticket._id}`).emit("ticket_status_changed", { status: ticket.status });
    await createNotification(io, {
      userId: ticket.user,
      type: "ticket_status_changed",
      title: `Ticket ${ticket.ticketNumber} updated`,
      body: `Status changed to ${ticket.status}`,
      link: `/support/tickets/${ticket._id}`,
      meta: { ticketId: ticket._id },
    }).catch((err) => console.error("Failed to notify ticket status change:", err.message));
  }

  res.json(ticket);
});

// ─── Properties ───────────────────────────────────────────────────────────────
router.get("/properties", async (req, res) => {
  const { page = 1, limit = 20, q } = req.query;
  const filter = {};
  if (q) filter.title = { $regex: q, $options: "i" };
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [properties, total] = await Promise.all([
    Property.find(filter).populate("host", "firstName lastName email displayName").populate("category", "name").sort({ order: 1, createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Property.countDocuments(filter),
  ]);
  res.json({ properties, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// Lists saved-but-unpublished listing drafts across all hosts, oldest
// first -- these are what the hourly reminder cron (server.js) emails
// hosts about. A draft that's stuck here despite the host having already
// published the listing (see the draftId fix in POST /properties) can be
// removed with DELETE below.
router.get("/drafts", async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [drafts, total] = await Promise.all([
    Draft.find({})
      .populate("host", "firstName lastName email displayName")
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Draft.countDocuments({}),
  ]);
  res.json({ drafts, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

router.delete("/drafts/:id", async (req, res) => {
  const draft = await Draft.findByIdAndDelete(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  res.json({ success: true });
});

// Prospect emails left on ServiceLocationPage.jsx's "coming soon" state,
// grouped by territory (location + subcategory) so admin can see at a
// glance which territories have enough interest to prioritize opening,
// and pull the email list for outreach once one does.
router.get("/prospect-emails", async (req, res) => {
  const prospects = await ProspectEmail.find({}).sort({ location: 1, createdAt: -1 });

  const grouped = {};
  for (const p of prospects) {
    const key = `${p.location}${p.subcategory ? ` — ${p.subcategory}` : ""}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ email: p.email, category: p.category, createdAt: p.createdAt });
  }

  res.json({ total: prospects.length, territories: grouped });
});

// One-off fix for listings created before coordinates were reliably
// captured (or before the create/update routes gained their own
// geocoding fallback) -- finds every property still missing coordinates
// and geocodes it from its saved address, so a host never has to
// manually re-save just to get a map pin.
router.post("/properties/backfill-coordinates", async (req, res) => {
  try {
    const properties = await Property.find({
      $or: [
        { "coordinates.latitude": { $exists: false } },
        { "coordinates.latitude": null },
        { "coordinates.latitude": 0 },
      ],
    });

    const results = [];
    for (const property of properties) {
      const geocoded = await geocodeAddress(property.location || {});
      if (geocoded) {
        property.coordinates = geocoded;
        await property.save();
        results.push({ id: property._id, title: property.title, status: "updated", coordinates: geocoded });
      } else {
        results.push({ id: property._id, title: property.title, status: "failed" });
      }
    }

    res.json({ success: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: "Backfill failed", details: err.message });
  }
});

// Bulk-sets Property.order from a drag-reordered list -- must be registered
// before the /:id route below, or Express would match "reorder" as an :id.
router.patch("/properties/reorder", async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: "order must be a non-empty array of property IDs" });
    }
    await Promise.all(
      order.map((id, index) => Property.updateOne({ _id: id }, { $set: { order: index } }))
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Approve/reject (isActive) is the original purpose of this route; the
// other fields below were added so admin can also correct or backfill a
// listing's core details directly -- most importantly location.neighborhood
// and subcategory, which power the /:subcategorySlug/:locationSlug SEO
// pages and are otherwise only ever set by the host themselves.
router.patch("/properties/:id", async (req, res) => {
  const {
    isActive, rejectionReason, title, subcategory, address, city, country, neighborhood,
    description, whatsIncluded, capacity, unitsCount, pricing, discounts, availability,
    instantBook, rules, listingTerms,
  } = req.body;

  const update = {};
  if (isActive !== undefined) update.isActive = isActive;
  if (title !== undefined) update.title = title.trim();
  if (subcategory !== undefined) update.subcategory = subcategory.trim();
  if (address !== undefined) update["location.address"] = address.trim();
  if (city !== undefined) update["location.city"] = city.trim();
  if (country !== undefined) update["location.country"] = country.trim();
  if (neighborhood !== undefined) update["location.neighborhood"] = neighborhood.trim();
  if (description !== undefined) update.description = description;
  if (whatsIncluded !== undefined) update.whatsIncluded = whatsIncluded;
  if (capacity !== undefined) update["features.capacity"] = Number(capacity) || 0;
  if (unitsCount !== undefined) update.unitsCount = Math.max(1, Number(unitsCount) || 1);
  if (pricing) {
    for (const tier of ["hourly", "daily", "weekly", "monthly", "annual"]) {
      if (pricing[tier] !== undefined) update[`pricing.${tier}`] = Number(pricing[tier]) || 0;
    }
  }
  if (discounts) {
    for (const key of ["newListing", "lastMinute", "weekly", "monthly"]) {
      if (discounts[key] !== undefined) update[`pricing.discounts.${key}`] = Boolean(discounts[key]);
    }
    if (discounts.extendedHours !== undefined) {
      update["pricing.discounts.extendedHours"] = Math.min(100, Math.max(0, Number(discounts.extendedHours) || 0));
    }
  }
  if (availability) {
    if (availability.openDays !== undefined) update["availability.openDays"] = availability.openDays;
    if (availability.openTime !== undefined) update["availability.openTime"] = availability.openTime;
    if (availability.closeTime !== undefined) update["availability.closeTime"] = availability.closeTime;
  }
  if (instantBook !== undefined) update["bookingSettings.instantBook"] = Boolean(instantBook);
  if (rules !== undefined) update["features.houseRules"] = rules;
  if (listingTerms !== undefined) update.listingTerms = listingTerms;

  const property = await Property.findByIdAndUpdate(req.params.id, update, { new: true })
    .populate("host", "email displayName firstName");
  if (!property) return res.status(404).json({ error: "Property not found" });

  // Rejecting a pending listing (isActive explicitly set to false with a
  // reason) — let the host know why, since the listing otherwise just sits
  // silently inactive with no other signal.
  if (isActive === false && rejectionReason && property.host?.email) {
    const name = property.host.displayName || property.host.firstName || "there";
    sendEmail({
      to: property.host.email,
      subject: `Your listing "${property.title}" needs changes`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#0A1628;">Listing not approved yet</h2>
          <p>Hi ${name}, your listing <strong>${property.title}</strong> wasn't approved during review:</p>
          <p style="background:#F8F6F0;border-radius:8px;padding:16px;color:#111827;">${rejectionReason}</p>
          <p>Make the changes and resubmit from your host dashboard.</p>
        </div>
      `,
    }).catch(console.error);
  }

  res.json(property);
});

// ─── Payouts (escrow) ─────────────────────────────────────────────────────────
router.get("/payouts/pending", async (req, res) => {
  const bookings = await Booking.find({ isPaid: true, escrowReleased: false, status: "completed" })
    .populate("host", "firstName lastName email stripeAccountId")
    .populate("property", "title")
    .sort({ checkOut: 1 });
  res.json(bookings);
});

// GET /admin/bookings — all bookings across the platform
router.get("/bookings", async (req, res) => {
  try {
    const Booking = require("../models/Booking");
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const status = req.query.status;

    const query = status && status !== "all" ? { status } : {};

    const [bookings, total] = await Promise.all([
      Booking.find(query)
        .populate("property", "title location coverImage")
        .populate("guest", "firstName lastName displayName email")
        .populate("host", "firstName lastName displayName email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Booking.countDocuments(query),
    ]);

    res.json({ success: true, bookings, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Admin bookings error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/payments — payment overview from bookings
router.get("/payments", async (req, res) => {
  try {
    const range = req.query.range || "30";
    const days = parseInt(range) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const bookings = await Booking.find({ isPaid: true, createdAt: { $gte: since } })
      .populate("property", "title location")
      .populate("guest", "firstName lastName displayName email")
      .populate("host", "firstName lastName displayName email")
      .sort({ createdAt: -1 })
      .limit(100);

    const allPaid = await Booking.find({ isPaid: true });
    const gmv = allPaid.reduce((sum, b) => sum + (b.totalPrice || 0), 0);
    const platformRevenue = allPaid.reduce((sum, b) => sum + (b.platformFee || 0), 0);
    const inEscrow = await Booking.find({ isPaid: true, escrowReleased: false, status: { $in: ["confirmed", "pending"] } });
    const escrowTotal = inEscrow.reduce((sum, b) => sum + (b.hostAmount || 0), 0);
    const awaitingPayout = await Booking.find({ isPaid: true, escrowReleased: false, status: "completed" });
    const awaitingTotal = awaitingPayout.reduce((sum, b) => sum + (b.hostAmount || 0), 0);

    res.json({
      success: true,
      stats: { gmv, platformRevenue, inEscrow: escrowTotal, awaitingPayout: awaitingTotal },
      transactions: bookings.map((b) => ({
        id: b._id.toString().slice(-8).toUpperCase(),
        bookingId: b._id.toString(),
        bookingRef: b._id.toString().slice(-8).toUpperCase(),
        customer: b.guest?.displayName || [b.guest?.firstName, b.guest?.lastName].filter(Boolean).join(" ") || b.guest?.email || "—",
        host: b.host?.displayName || [b.host?.firstName, b.host?.lastName].filter(Boolean).join(" ") || b.host?.email || "—",
        space: b.property?.title || "—",
        amount: b.totalPrice || 0,
        commission: b.platformFee || 0,
        hostPayout: b.hostAmount || 0,
        status: b.escrowReleased ? "completed" : b.status === "cancelled" ? "refunded" : "escrow_held",
        bookingStatus: b.status,
        disputeFrozen: !!b.disputeFrozen,
        date: b.createdAt,
        currency: "GBP",
      })),
    });
  } catch (err) {
    console.error("Admin payments error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/payments/:bookingId/release — manually release escrow to host,
// bypassing the automated 24h-post-checkout cron (utils/releaseEscrow.js).
// Same eligibility rules as the cron, minus the time wait, so this can't
// release a booking that isn't actually checked out or is dispute-frozen.
router.post("/payments/:bookingId/release", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId).populate("host");
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!booking.isPaid) return res.status(400).json({ error: "Booking was never paid" });
    if (booking.escrowReleased) return res.status(400).json({ error: "Funds already released for this booking" });
    if (booking.disputeFrozen) return res.status(400).json({ error: "Booking is frozen pending dispute review" });
    if (booking.status !== "completed") return res.status(400).json({ error: "Booking hasn't checked out yet" });
    if (!booking.host?.stripeAccountId) return res.status(400).json({ error: "Host has no connected Stripe account" });

    const amountToHost = Math.round((booking.hostAmount || 0) * 100);
    if (amountToHost <= 0) return res.status(400).json({ error: "Nothing to release for this booking" });

    const transfer = await stripe.transfers.create({
      amount: amountToHost,
      currency: "gbp",
      destination: booking.host.stripeAccountId,
      transfer_group: booking._id.toString(),
      description: `Manual admin payout release for booking ${booking._id}`,
    });

    booking.escrowReleased = true;
    booking.stripeTransferId = transfer.id;
    await booking.save();

    if (booking.host.phoneNumber && booking.host.isPhoneVerified) {
      sendSMS({
        to: booking.host.phoneNumber,
        body: `VenCome: You've been paid £${(amountToHost / 100).toFixed(2)} for booking ${booking._id.toString().slice(-8).toUpperCase()}.`,
      }).catch((err) => {
        if (err.code !== "SMS_NOT_CONFIGURED") console.error("Admin-release payout SMS to host failed:", err.message);
      });
    }

    res.json({ success: true, transferId: transfer.id });
  } catch (err) {
    console.error("Admin release funds error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Shared by the immediate-send path here and the scheduled-broadcast cron
// (utils/sendScheduledBroadcasts.js) — resolves recipients, emails them, and
// stamps the Broadcast doc as sent/failed.
async function sendBroadcastNow(broadcast) {
  const query =
    broadcast.target === "hosts" ? { isHost: true } :
    broadcast.target === "customers" ? { isHost: false } :
    broadcast.target === "specific" ? { _id: { $in: broadcast.recipientUsers } } :
    {};
  const users = await User.find(query).select("email firstName displayName").lean();

  if (!users.length) {
    broadcast.status = "failed";
    await broadcast.save();
    throw new Error("No users found for this target");
  }

  const emailPromises = users.map((user) => {
    const name = user.displayName || user.firstName || "there";
    return sendEmail({
      to: user.email,
      subject: broadcast.subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
          <p>Hi ${name},</p>
          <div style="font-size:15px;line-height:1.7;color:#374151;">
            ${broadcast.message.replace(/\n/g, "<br/>")}
          </div>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;" />
          <p style="font-size:12px;color:#9CA3AF;">You received this email because you are a registered VenCome user. © ${new Date().getFullYear()} VenCome</p>
        </div>
      `,
    }).catch((err) => console.error(`Failed to send to ${user.email}:`, err.message));
  });

  await Promise.allSettled(emailPromises);

  broadcast.status = "sent";
  broadcast.sentAt = new Date();
  broadcast.recipientCount = users.length;
  await broadcast.save();
  return users.length;
}
// Attached to the router (not module.exports directly) since module.exports
// gets reassigned to `router` at the bottom of this file — see
// utils/sendScheduledBroadcasts.js for the consumer.
router.sendBroadcastNow = sendBroadcastNow;

// POST /admin/broadcast — send (or schedule) an email to all/hosts/customers/specific users
router.post("/broadcast", async (req, res) => {
  try {
    const { subject, message, target, userIds, scheduledFor } = req.body;
    if (!subject || !message) return res.status(400).json({ error: "Subject and message are required" });
    if (target === "specific" && (!Array.isArray(userIds) || !userIds.length)) {
      return res.status(400).json({ error: "Select at least one recipient" });
    }

    const scheduledDate = scheduledFor ? new Date(scheduledFor) : null;
    const isFutureSend = scheduledDate && scheduledDate.getTime() > Date.now();

    const broadcast = new Broadcast({
      subject,
      message,
      target: target || "all",
      recipientUsers: target === "specific" ? userIds : [],
      status: isFutureSend ? "scheduled" : "sent",
      scheduledFor: scheduledDate || null,
      sentBy: req.user.id,
    });

    if (isFutureSend) {
      await broadcast.save();
      return res.json({ success: true, scheduled: true, scheduledFor: broadcast.scheduledFor });
    }

    await broadcast.save();
    const sent = await sendBroadcastNow(broadcast);
    res.json({ success: true, sent });
  } catch (err) {
    console.error("Broadcast error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// GET /admin/broadcast/history — past + scheduled broadcasts, newest first
router.get("/broadcast/history", async (req, res) => {
  try {
    const broadcasts = await Broadcast.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("sentBy", "displayName firstName lastName email");
    res.json({ broadcasts });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /admin/broadcast/:id — cancel a not-yet-sent scheduled broadcast
router.delete("/broadcast/:id", async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);
    if (!broadcast) return res.status(404).json({ error: "Broadcast not found" });
    if (broadcast.status !== "scheduled") {
      return res.status(400).json({ error: "Only scheduled broadcasts that haven't sent yet can be cancelled" });
    }
    broadcast.status = "cancelled";
    await broadcast.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Broadcast templates ────────────────────────────────────────────────────
router.get("/broadcast/templates", async (req, res) => {
  try {
    const templates = await BroadcastTemplate.find().sort({ createdAt: -1 });
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/broadcast/templates", async (req, res) => {
  try {
    const { name, subject, message } = req.body;
    if (!name || !subject || !message) return res.status(400).json({ error: "Name, subject and message are required" });
    const template = await BroadcastTemplate.create({ name, subject, message });
    res.status(201).json({ success: true, template });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/broadcast/templates/:id", async (req, res) => {
  try {
    await BroadcastTemplate.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/users/:id/verify — grant or revoke VenCome Verified
router.post("/users/:id/verify", async (req, res) => {
  try {
    const { action } = req.body; // "grant" or "revoke"
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (action === "grant") {
      user.venComeVerified = true;
      user.venComeVerifiedAt = new Date();
    } else {
      user.venComeVerified = false;
      user.venComeVerifiedAt = null;
    }
    await user.save();

    const sendEmail = require("../utils/sendEmail");
    const name = user.displayName || user.firstName || "there";
    if (action === "grant") {
      sendEmail({
        to: user.email,
        subject: "You are now VenCome Verified ✓",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
            <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
            <h2 style="color:#0A1628;">Congratulations, ${name}! 🎉</h2>
            <p>Your VenCome account has been officially verified. You will now display the <strong>VenCome Verified ✓</strong> badge on your profile and listings.</p>
            <p>This badge shows customers that you are a trusted, professional host on the platform.</p>
            <a href="https://www.vencome.com" style="display:inline-block;padding:14px 28px;background:#305CDE;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">View Your Profile</a>
            <p style="color:#6B7280;font-size:13px;margin-top:24px;">The VenCome Team</p>
          </div>
        `,
      }).catch(console.error);
    }

    res.json({ success: true, user: { _id: user._id, venComeVerified: user.venComeVerified } });
  } catch (err) {
    console.error("Verify user error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/users/:id/apply-verified — host applies for verified status
router.post("/users/:id/apply-verified", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.venComeVerifiedAppliedAt = new Date();
    await user.save();
    res.json({ success: true, message: "Application submitted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Markets ──────────────────────────────────────────────────────────────────
router.get("/markets", async (req, res) => {
  try {
    const markets = await Market.find().sort({ order: 1, createdAt: 1 });
    res.json({ markets });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/markets", async (req, res) => {
  try {
    const { name, flag, cities, status, phase, order, currency, primaryLanguage } = req.body;
    if (!name) return res.status(400).json({ error: "Market name is required" });

    const existing = await Market.findOne({ name });
    if (existing) return res.status(400).json({ error: "A market with that name already exists" });

    const market = await Market.create({
      name,
      flag: flag || "🌍",
      cities: Array.isArray(cities) ? cities : [],
      status: status || "planned",
      phase: phase || "",
      order: Number.isFinite(order) ? order : 0,
      currency: currency || "GBP",
      primaryLanguage: primaryLanguage || "English",
    });
    res.status(201).json({ success: true, market });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/markets/:id", async (req, res) => {
  try {
    const { name, flag, cities, status, phase, order, currency, primaryLanguage } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (flag !== undefined) update.flag = flag;
    if (cities !== undefined) update.cities = Array.isArray(cities) ? cities : [];
    if (status !== undefined) update.status = status;
    if (phase !== undefined) update.phase = phase;
    if (order !== undefined) update.order = order;
    if (currency !== undefined) update.currency = currency;
    if (primaryLanguage !== undefined) update.primaryLanguage = primaryLanguage;

    const market = await Market.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!market) return res.status(404).json({ error: "Market not found" });
    res.json({ success: true, market });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/markets/:id", async (req, res) => {
  try {
    const market = await Market.findByIdAndDelete(req.params.id);
    if (!market) return res.status(404).json({ error: "Market not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Commission ─────────────────────────────────────────────────────────────────
// Finance-tier, unlike /markets (content-tier) — commission math is real-money-
// adjacent, so per-market rate overrides live here even though the markets
// themselves are managed on the Markets page.
router.get("/commission", async (req, res) => {
  try {
    const [settings, markets] = await Promise.all([
      PlatformSettings.getSettings(),
      Market.find().sort({ order: 1, createdAt: 1 }).select("name flag cities commissionRate commissionOverrideActive"),
    ]);
    res.json({ defaultCommissionRate: settings.defaultCommissionRate, markets });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/commission", async (req, res) => {
  try {
    const { defaultCommissionRate } = req.body;
    if (defaultCommissionRate === undefined) return res.status(400).json({ error: "defaultCommissionRate is required" });
    const rate = Number(defaultCommissionRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: "defaultCommissionRate must be between 0 and 100" });
    }
    const settings = await PlatformSettings.getSettings();
    settings.defaultCommissionRate = rate;
    await settings.save();
    res.json({ success: true, defaultCommissionRate: settings.defaultCommissionRate });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/commission/markets/:id", async (req, res) => {
  try {
    const { commissionRate, commissionOverrideActive } = req.body;
    const update = {};
    if (commissionRate !== undefined) {
      const rate = commissionRate === null ? null : Number(commissionRate);
      if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
        return res.status(400).json({ error: "commissionRate must be between 0 and 100" });
      }
      update.commissionRate = rate;
    }
    if (commissionOverrideActive !== undefined) update.commissionOverrideActive = !!commissionOverrideActive;

    const market = await Market.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .select("name flag cities commissionRate commissionOverrideActive");
    if (!market) return res.status(404).json({ error: "Market not found" });
    res.json({ success: true, market });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Invoices ─────────────────────────────────────────────────────────────────
// Invoices aren't stored separately — every paid booking has everything needed
// to regenerate its invoice PDF on demand, so we build the list/download/resend
// endpoints straight off the Booking data instead of duplicating it.
router.get("/invoices", async (req, res) => {
  try {
    const { page = 1, limit = 20, q } = req.query;
    const filter = { isPaid: true };
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let bookings = await Booking.find(filter)
      .populate("property", "title location")
      .populate("guest", "firstName lastName displayName email")
      .populate("host", "firstName lastName displayName email")
      .sort({ createdAt: -1 });

    if (q) {
      const needle = q.toLowerCase();
      bookings = bookings.filter((b) => {
        const invoiceNumber = `VC-${b._id.toString().slice(-8).toUpperCase()}`;
        const guestName = b.guest?.displayName || `${b.guest?.firstName || ""} ${b.guest?.lastName || ""}`.trim();
        const hostName = b.host?.displayName || `${b.host?.firstName || ""} ${b.host?.lastName || ""}`.trim();
        return (
          invoiceNumber.toLowerCase().includes(needle) ||
          guestName.toLowerCase().includes(needle) ||
          hostName.toLowerCase().includes(needle) ||
          (b.property?.title || "").toLowerCase().includes(needle)
        );
      });
    }

    const total = bookings.length;
    const page_ = bookings.slice(skip, skip + parseInt(limit));

    const invoices = page_.map((b) => ({
      bookingId: b._id,
      invoiceNumber: `VC-${b._id.toString().slice(-8).toUpperCase()}`,
      issuedAt: b.createdAt,
      guestName: b.guest?.displayName || `${b.guest?.firstName || ""} ${b.guest?.lastName || ""}`.trim() || b.guest?.email,
      hostName: b.host?.displayName || `${b.host?.firstName || ""} ${b.host?.lastName || ""}`.trim() || b.host?.email,
      propertyTitle: b.property?.title || "Deleted listing",
      amount: b.totalPrice,
      status: b.status === "cancelled" ? "refunded" : "paid",
    }));

    res.json({ invoices, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error("List invoices error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/invoices/:bookingId/download", async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.bookingId, isPaid: true }).populate("property");
    if (!booking) return res.status(404).json({ error: "Invoice not found" });

    const [guest, host] = await Promise.all([
      User.findById(booking.guest),
      User.findById(booking.host),
    ]);
    if (!guest || !host) return res.status(404).json({ error: "Guest or host no longer exists" });

    const pdfBuffer = await generateInvoicePDF(booking, booking.property, guest, host);
    const invoiceNumber = `VC-${booking._id.toString().slice(-8).toUpperCase()}`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="VenCome-Invoice-${invoiceNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Download invoice error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/invoices/:bookingId/resend", async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.bookingId, isPaid: true }).populate("property");
    if (!booking) return res.status(404).json({ error: "Invoice not found" });

    const [guest, host] = await Promise.all([
      User.findById(booking.guest),
      User.findById(booking.host),
    ]);
    if (!guest || !host) return res.status(404).json({ error: "Guest or host no longer exists" });

    const pdfBuffer = await generateInvoicePDF(booking, booking.property, guest, host);
    const invoiceNumber = `VC-${booking._id.toString().slice(-8).toUpperCase()}`;

    await sendEmail({
      to: guest.email,
      subject: `Your VenCome invoice ${invoiceNumber}`,
      attachments: [
        {
          filename: `VenCome-Invoice-${invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
          <h2 style="color:#0A1628;">Your invoice, resent</h2>
          <p>Hi ${guest.displayName || guest.firstName || "there"},</p>
          <p>Attached is your invoice <strong>${invoiceNumber}</strong> for ${booking.property?.title || "your booking"}.</p>
          <p style="color:#6B7280;font-size:13px;margin-top:24px;">The VenCome Team</p>
        </div>
      `,
    });

    res.json({ success: true, message: "Invoice resent" });
  } catch (err) {
    console.error("Resend invoice error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

const ADMIN_ROLES = ["full_admin", "finance", "support", "content"];

// ─── Team ─────────────────────────────────────────────────────────────────────
router.get("/team", async (req, res) => {
  try {
    const team = await User.find({ isAdmin: true })
      .select("firstName lastName displayName email profileImage adminTitle adminRole createdAt")
      .sort({ createdAt: 1 });
    res.json({ team });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/team/:id/title", async (req, res) => {
  try {
    const { adminTitle } = req.body;
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, isAdmin: true },
      { adminTitle: adminTitle || "" },
      { new: true }
    ).select("firstName lastName displayName email profileImage adminTitle adminRole createdAt");
    if (!user) return res.status(404).json({ error: "Admin user not found" });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/team/:id/role", async (req, res) => {
  try {
    const { adminRole } = req.body;
    if (!ADMIN_ROLES.includes(adminRole)) {
      return res.status(400).json({ error: `adminRole must be one of: ${ADMIN_ROLES.join(", ")}` });
    }
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, isAdmin: true },
      { adminRole },
      { new: true }
    ).select("firstName lastName displayName email profileImage adminTitle adminRole createdAt");
    if (!user) return res.status(404).json({ error: "Admin user not found" });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Grant admin access to an existing user by email (adds them to the team)
router.post("/team/invite", async (req, res) => {
  try {
    const { email, adminTitle, adminRole } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (adminRole && !ADMIN_ROLES.includes(adminRole)) {
      return res.status(400).json({ error: `adminRole must be one of: ${ADMIN_ROLES.join(", ")}` });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ error: "No VenCome user found with that email — they need an account first" });
    if (user.isAdmin) return res.status(400).json({ error: "This user is already a team member" });

    user.isAdmin = true;
    user.adminTitle = adminTitle || "";
    user.adminRole = adminRole || "full_admin";
    await user.save();

    res.json({ success: true, user: { _id: user._id, email: user.email, displayName: user.displayName, adminTitle: user.adminTitle, adminRole: user.adminRole } });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Categories ───────────────────────────────────────────────────────────────
router.get("/categories", async (req, res) => {
  try {
    const categories = await Category.find().sort({ order: 1 });
    const withCounts = await Promise.all(
      categories.map(async (cat) => {
        const listingCount = await Property.countDocuments({
          $or: [{ category: cat._id }, { categories: cat._id }],
        });
        return { ...cat.toObject(), listingCount };
      })
    );
    res.json({ categories: withCounts });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/categories", async (req, res) => {
  try {
    const { name, description, image, status, subcategories } = req.body;
    if (!name || !description) return res.status(400).json({ error: "Name and description are required" });

    const existing = await Category.findOne({ name });
    if (existing) return res.status(400).json({ error: "A category with that name already exists" });

    const cleanSubcategories = Array.isArray(subcategories)
      ? subcategories
          .filter((s) => s?.name && s?.description)
          .map((s) => ({ name: s.name, description: s.description, image: s.image || image || undefined }))
      : [];

    const category = await Category.create({
      name,
      description,
      image: image || undefined,
      status: status === "draft" ? "draft" : "published",
      subcategories: cleanSubcategories,
    });
    res.status(201).json({ success: true, category });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Bulk-sets Category.order from a drag-reordered list -- must be registered
// before the /:id route below, or Express would match "reorder" as an :id.
router.patch("/categories/reorder", async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: "order must be a non-empty array of category IDs" });
    }
    await Promise.all(
      order.map((id, index) => Category.updateOne({ _id: id }, { $set: { order: index } }))
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

router.patch("/categories/:id", async (req, res) => {
  try {
    const { name, description, image, status } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (image !== undefined) update.image = image;
    if (status !== undefined) update.status = status;

    const category = await Category.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ success: true, category });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/categories/:id", async (req, res) => {
  try {
    const listingCount = await Property.countDocuments({
      $or: [{ category: req.params.id }, { categories: req.params.id }],
    });
    if (listingCount > 0) {
      return res.status(400).json({
        error: `${listingCount} listing(s) use this category. Reassign or remove them before deleting it.`,
      });
    }
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Subcategories (embedded on Category) ──────────────────────────────────────
router.post("/categories/:id/subcategories", async (req, res) => {
  try {
    const { name, description, image } = req.body;
    if (!name || !description) return res.status(400).json({ error: "Name and description are required" });

    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });

    category.subcategories.push({ name, description, image: image || category.image });
    await category.save();
    res.status(201).json({ success: true, category });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/categories/:id/subcategories/:subId", async (req, res) => {
  try {
    const { name, description, image } = req.body;
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });

    const sub = category.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ error: "Subcategory not found" });

    if (name !== undefined) sub.name = name;
    if (description !== undefined) sub.description = description;
    if (image !== undefined) sub.image = image;
    await category.save();
    res.json({ success: true, category });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/categories/:id/subcategories/:subId", async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });

    const sub = category.subcategories.id(req.params.subId);
    if (!sub) return res.status(404).json({ error: "Subcategory not found" });

    sub.deleteOne();
    await category.save();
    res.json({ success: true, category });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Platform Settings ──────────────────────────────────────────────────────────
router.get("/settings", async (req, res) => {
  try {
    const settings = await PlatformSettings.getSettings();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const fields = [
      "platformName", "supportEmail", "currency", "maintenanceMode",
      "registrationsEnabled", "hostApplicationsEnabled", "requireAdmin2FA",
      "sessionTimeoutMinutes",
    ];
    const update = {};
    for (const field of fields) {
      if (req.body[field] !== undefined) update[field] = req.body[field];
    }
    if (update.sessionTimeoutMinutes !== undefined) {
      const minutes = Number(update.sessionTimeoutMinutes);
      if (!Number.isFinite(minutes) || minutes < 5) {
        return res.status(400).json({ error: "Session timeout must be at least 5 minutes" });
      }
      update.sessionTimeoutMinutes = minutes;
    }

    const settings = await PlatformSettings.getSettings();
    Object.assign(settings, update);
    await settings.save();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
