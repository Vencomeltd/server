const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const Property = require("../models/Property");
const Booking = require("../models/Booking");
const sendEmail = require("../utils/sendEmail");
const auth = require("../middleware/auth");
const { authLimiter, otpLimiter } = require("../middleware/rateLimiter");
const { OAuth2Client } = require("google-auth-library");
const { client: redisClient } = require("../utils/redisClient");
const { generateOTP, storeOTP, verifyOTP } = require("../utils/otp");
const router = express.Router();

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "-password -otp -otpExpires"
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /auth/signup ────────────────────────────────────────────────────────
router.post("/signup", authLimiter, async (req, res) => {
  const { email, password, isHost, newsletterOptIn, firstName } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });
  if (password.length < 8)
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });
  // Without a real name, the public-facing display name silently fell back
  // to the part of the email before the "@" (see PropertyDetails.jsx's
  // HostSection), which could leak a host's business/salon name they never
  // intended to make public. The explicit /signup form now requires this
  // client-side; kept optional here (not a hard 400) because the
  // passwordless combined /login flow also calls this endpoint to
  // auto-create an account and doesn't collect a name.
  const trimmedFirstName = (firstName || "").trim();

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing)
      return res
        .status(409)
        .json({ error: "An account with this email already exists" });

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({
      email: normalizedEmail,
      password: hashedPassword,
      ...(trimmedFirstName && { firstName: trimmedFirstName, displayName: trimmedFirstName }),
      isVerified: false,
      isHost: !!isHost,
      newsletterOptIn: !!newsletterOptIn,
    });
    await user.save();

    // Admin "new signup" notification fires once identity is actually
    // verified (see /auth/verify-login), not here on bare record creation —
    // otherwise an email-only entry that never completes OTP still reports
    // as a signup.
    const otp = generateOTP();
    await storeOTP(normalizedEmail, otp);

    await sendEmail({
      to: normalizedEmail,
      subject: "Verify Your Email Address",
      html: emailTemplate(
        "Welcome! Verify Your Email",
        `Your verification code is:`,
        otp
      ),
    });

    res.json({
      message: "Account created. OTP sent to email.",
      requiresVerification: true,
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Server error, please try again later" });
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────
router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (user.authProvider === "google")
      return res
        .status(400)
        .json({ error: "This account uses Google sign-in" });

    if (password !== "otp-flow") {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

      if (!user.isVerified) {
        // Correct password, but this account never completed email
        // verification (e.g. signed up and never entered the OTP) -- fall
        // through to the same OTP step the passwordless path uses below,
        // instead of issuing a token straight away.
        const otp = generateOTP();
        await storeOTP(normalizedEmail, otp);

        await sendEmail({
          to: normalizedEmail,
          subject: "Verify Your Email Address",
          html: emailTemplate(
            "Verify Your Email",
            "Your account hasn't been verified yet. Your verification code is:",
            otp
          ),
        });

        return res.json({
          message: "Please verify your email to finish logging in. OTP sent.",
          requiresVerification: true,
        });
      }

      // Real password verified -- log in directly, no OTP step. The
      // "otp-flow" sentinel below is the existing passwordless path, which
      // still always requires OTP verification afterward.
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });
      const refreshToken = jwt.sign(
        { id: user._id },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: "30d" }
      );
      await redisClient.setEx(
        `refresh:${user._id}`,
        30 * 24 * 60 * 60,
        refreshToken
      );

      return res.json({
        token,
        refreshToken,
        message: "Login successful",
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          isVerified: user.isVerified,
          isHost: user.isHost,
        },
      });
    }

    const otp = generateOTP();
    await storeOTP(normalizedEmail, otp);

    await sendEmail({
      to: normalizedEmail,
      subject: "Login Verification Code",
      html: emailTemplate(
        "Login Verification",
        "Use the code below to complete your login:",
        otp
      ),
    });

    res.json({
      message: "OTP sent to email. Please verify to complete login.",
      requiresVerification: true,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error, please try again later" });
  }
});

// ─── POST /auth/verify-login ──────────────────────────────────────────────────
router.post("/verify-login", otpLimiter, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp)
    return res.status(400).json({ error: "Email and OTP are required" });

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const valid = await verifyOTP(normalizedEmail, otp);
    if (!valid)
      return res.status(400).json({ error: "Invalid or expired OTP" });

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(400).json({ error: "User not found" });

    const wasAlreadyVerified = user.isVerified;
    user.isVerified = true;
    await user.save();

    if (!wasAlreadyVerified) {
      const adminEmails = ["vencomeltd@gmail.com", "bashayr.alharthi@outlook.com"];
      const roleLabel = user.isHost ? "Host" : "Customer";
      sendEmail({
        to: adminEmails,
        subject: `New ${roleLabel} Signup — ${normalizedEmail}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
            <h2 style="color:#0A1628;">New ${roleLabel} Signup 🎉</h2>
            <p>A new ${roleLabel.toLowerCase()} has just verified their email and signed up on VenCome.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px 0;color:#666;">Email</td><td style="padding:8px 0;font-weight:700;">${normalizedEmail}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Role</td><td style="padding:8px 0;font-weight:700;">${roleLabel}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Time</td><td style="padding:8px 0;font-weight:700;">${new Date().toLocaleString("en-GB")}</td></tr>
            </table>
            <a href="https://www.vencome.com/admin" style="display:inline-block;padding:12px 24px;background:#305CDE;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">View in Admin Panel</a>
          </div>
        `,
      });

      // Welcome email -- client asked for this (Aug 26), never drafted.
      // First-draft copy, easy to revise -- differs slightly for host vs
      // customer since the two roles' first useful action differs.
      const welcomeName = user.displayName || user.firstName || "there";
      sendEmail({
        to: normalizedEmail,
        subject: "Welcome to VenCome 🎉",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
            <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="height:40px;margin-bottom:24px;" />
            <h2 style="color:#0A1628;">Welcome to VenCome, ${welcomeName} 🎉</h2>
            ${
              user.isHost
                ? `
            <p>You're in. VenCome is the easiest way to turn your commercial space into steady income -- list once, and start receiving booking requests from businesses looking for exactly what you've got.</p>
            <p>A few things to do next:</p>
            <ul style="color:#333;line-height:1.8;">
              <li>List your first space -- it takes a few minutes</li>
              <li>Add a payout method so you can get paid</li>
              <li>Connect your calendar so you never get double-booked</li>
            </ul>
            <a href="https://www.vencome.com/create-space" style="display:inline-block;padding:14px 28px;background:#305CDE;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">List Your Space</a>
            `
                : `
            <p>You're in. VenCome makes it simple to find and book commercial spaces -- offices, studios, event venues and more -- by the hour, day, or year.</p>
            <p>Whenever you're ready, browse spaces near you and book in a few clicks. Your payment stays protected until your booking is complete.</p>
            <a href="https://www.vencome.com/search" style="display:inline-block;padding:14px 28px;background:#305CDE;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">Find a Space</a>
            `
            }
            <p style="margin-top:24px;color:#6B7280;font-size:13px;">The VenCome Team</p>
          </div>
        `,
      });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    const refreshToken = jwt.sign(
      { id: user._id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "30d" }
    );

    // Store refresh token in Redis
    await redisClient.setEx(
      `refresh:${user._id}`,
      30 * 24 * 60 * 60,
      refreshToken
    );

    res.json({
      token,
      refreshToken,
      message: "Login successful",
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        isVerified: user.isVerified,
        isHost: user.isHost,
      },
    });
  } catch (err) {
    console.error("Verify login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /auth/resend-otp ────────────────────────────────────────────────────
router.post("/resend-otp", otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(400).json({ error: "User not found" });

    const otp = generateOTP();
    await storeOTP(normalizedEmail, otp);

    await sendEmail({
      to: normalizedEmail,
      subject: "Your new verification code",
      html: emailTemplate("New Verification Code", "Your new code is:", otp),
    });

    res.json({ message: "OTP resent" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /auth/refresh-token ─────────────────────────────────────────────────
router.post("/refresh-token", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken)
    return res.status(401).json({ error: "Refresh token required" });

  try {
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const stored = await redisClient.get(`refresh:${decoded.id}`);
    if (!stored || stored !== refreshToken)
      return res
        .status(401)
        .json({ error: "Invalid or expired refresh token" });

    const token = jwt.sign({ id: decoded.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ token });
  } catch {
    res.status(401).json({ error: "Invalid refresh token" });
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
router.post("/logout", auth, async (req, res) => {
  try {
    await redisClient.del(`refresh:${req.user.id}`);
    res.json({ message: "Logged out successfully" });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /auth/google ────────────────────────────────────────────────────────
router.post("/google", async (req, res) => {
  const { token, isHost, newsletterOptIn } = req.body;
  if (!token)
    return res.status(400).json({ error: "Google token is required" });

  try {
    const { email, firstName, lastName, picture, googleId } = req.body;
    const given_name = firstName;
    const family_name = lastName;

    if (!email || !googleId) {
      return res.status(400).json({ error: "Missing Google user data" });
    }

    let user = await User.findOne({ email });
    const isNewUser = !user;
    if (!user) {
      user = new User({
        email,
        firstName: given_name,
        lastName: family_name,
        profileImage: picture,
        googleId,
        authProvider: "google",
        password: await bcrypt.hash(googleId + process.env.JWT_SECRET, 12),
        isEmailVerified: true,
        isVerified: true,
        isHost: !!isHost,
        newsletterOptIn: !!newsletterOptIn,
      });
      await user.save();

      // Notify admins of new Google signup
      const adminEmails = ["vencomeltd@gmail.com", "bashayr.alharthi@outlook.com"];
      const roleLabel = isHost ? "Host" : "Customer";
      sendEmail({
        to: adminEmails,
        subject: `New ${roleLabel} Signup (Google) — ${email}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
            <h2 style="color:#0A1628;">New ${roleLabel} Signup via Google 🎉</h2>
            <p>A new ${roleLabel.toLowerCase()} has just signed up on VenCome using Google.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px 0;color:#666;">Name</td><td style="padding:8px 0;font-weight:700;">${given_name} ${family_name}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Email</td><td style="padding:8px 0;font-weight:700;">${email}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Role</td><td style="padding:8px 0;font-weight:700;">${roleLabel}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Time</td><td style="padding:8px 0;font-weight:700;">${new Date().toLocaleString("en-GB")}</td></tr>
            </table>
            <a href="https://www.vencome.com/admin" style="display:inline-block;padding:12px 24px;background:#305CDE;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">View in Admin Panel</a>
          </div>
        `,
      });
    } else if (isHost && !user.isHost) {
      user.isHost = true;
      await user.save();
    }

    const jwtToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    const refreshToken = jwt.sign(
      { id: user._id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "30d" }
    );
    await redisClient.setEx(
      `refresh:${user._id}`,
      30 * 24 * 60 * 60,
      refreshToken
    );

    res.json({
      token: jwtToken,
      refreshToken,
      isNewUser,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        isHost: user.isHost,
      },
    });
  } catch (err) {
    console.error("Google auth error:", err);
    res.status(401).json({ error: "Invalid Google token" });
  }
});

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
router.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // Always respond 200 to prevent email enumeration
    if (!user)
      return res.json({
        message: "If that email exists, an OTP has been sent",
      });

    const otp = generateOTP();
    await storeOTP(`pwd:${email.toLowerCase().trim()}`, otp);

    res.json({ message: "If that email exists, an OTP has been sent" });

    sendEmail({
      to: email,
      subject: "Password Reset OTP",
      html: emailTemplate(
        "Password Reset Request",
        "Use the code below to reset your password:",
        otp
      ),
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /auth/verify-otp ────────────────────────────────────────────────────
router.post("/verify-otp", otpLimiter, async (req, res) => {
  const { email, otp } = req.body;
  try {
    const valid = await verifyOTP(`pwd:${email.toLowerCase().trim()}`, otp);
    if (!valid)
      return res.status(400).json({ error: "Invalid or expired OTP" });
    // Issue a short-lived reset token
    const resetToken = jwt.sign(
      { email: email.toLowerCase().trim(), purpose: "reset" },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );
    res.json({ message: "OTP verified", resetToken });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /auth/reset-password ────────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  const { resetToken, password, confirmPassword } = req.body;
  if (!resetToken || !password || !confirmPassword)
    return res.status(400).json({ error: "All fields are required" });
  if (password !== confirmPassword)
    return res.status(400).json({ error: "Passwords do not match" });
  if (password.length < 8)
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });

  try {
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    if (decoded.purpose !== "reset")
      return res.status(400).json({ error: "Invalid reset token" });

    const user = await User.findOne({ email: decoded.email });
    if (!user) return res.status(400).json({ error: "User not found" });

    user.password = await bcrypt.hash(password, 12);
    await user.save();

    res.json({ message: "Password reset successful" });
    sendEmail({
      to: decoded.email,
      subject: "Password Reset Successful",
      html: emailTemplate(
        "Password Reset Successful",
        "Your password has been updated successfully.",
        null
      ),
    });
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(400).json({ error: "Reset link has expired" });
    res.status(500).json({ error: "Server error" });
  }
});

// ─── DELETE /auth/account ─────────────────────────────────────────────────────
router.delete("/account", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [activeListings, unresolvedBookings, unpaidOutBookings] = await Promise.all([
      Property.countDocuments({ host: userId, isActive: true }),
      Booking.countDocuments({
        $or: [{ host: userId }, { guest: userId }],
        status: { $in: ["pending", "confirmed"] },
      }),
      Booking.countDocuments({ host: userId, isPaid: true, escrowReleased: false }),
    ]);

    if (activeListings > 0) {
      return res.status(400).json({
        error: `You have ${activeListings} active listing(s). Deactivate or delete them before closing your account.`,
      });
    }
    if (unresolvedBookings > 0) {
      return res.status(400).json({
        error: `You have ${unresolvedBookings} pending or confirmed booking(s). These must be completed or cancelled before closing your account.`,
      });
    }
    if (unpaidOutBookings > 0) {
      return res.status(400).json({
        error: `You have ${unpaidOutBookings} booking(s) with a payout still in escrow. Your account can't be closed until those payouts have been released.`,
      });
    }

    await User.findByIdAndDelete(userId);
    await redisClient.del(`refresh:${userId}`);
    res.json({ message: "Account deleted successfully" });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── POST /auth/update-role ───────────────────────────────────────────────────
router.post("/update-role", auth, async (req, res) => {
  try {
    const { isHost } = req.body;
    await User.findByIdAndUpdate(req.user.id, { isHost: !!isHost });
    res.json({ message: "Role updated" });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Email template helper ────────────────────────────────────────────────────
function emailTemplate(title, body, otp) {
  return `
<div style="font-family:'Manrope',Arial,sans-serif;background:#f4f4f7;padding:20px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
    <div style="background:#f0f0f0;padding:20px;text-align:center;">
      <img src="${
        process.env.CLIENT_URL
      }/logo-blue.png" alt="VenCome" style="max-width:150px;height:auto;">
    </div>
    <div style="padding:30px;color:#333;">
      <h2 style="color:#305CDE;margin-top:0;text-align:center;">${title}</h2>
      <p>${body}</p>
      ${
        otp
          ? `<div style="background:#f4f4f4;padding:20px;text-align:center;margin:25px 0;border-radius:8px;"><span style="font-size:28px;font-weight:bold;color:#305CDE;letter-spacing:6px;">${otp}</span></div><p>This code expires in <strong>10 minutes</strong>.</p>`
          : ""
      }
    </div>
    <div style="background:#f0f0f0;padding:20px;text-align:center;font-size:12px;color:#888;">
      This is an automated message, please do not reply.<br/>© ${new Date().getFullYear()} VenCome. All rights reserved.
    </div>
  </div>
</div>`;
}

// POST /auth/referrals/invite — send host invite email
router.post("/referrals/invite", async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const referrerName = req.user ? `${req.user.firstName || "A VenCome member"}` : "A VenCome member";

    await sendEmail({
      to: email,
      subject: `${referrerName} invited you to list your space on VenCome`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <img src="https://www.vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
          <h2 style="color:#0A1628;">You've been invited to list on VenCome</h2>
          <p>Hi ${name || "there"},</p>
          <p>${referrerName} thinks you'd be a great fit for VenCome — the UK and Middle East's leading B2B commercial space marketplace.</p>
          <p>List your commercial space and start earning. It only takes a few minutes to get started.</p>
          <a href="https://www.vencome.com/login?role=host" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#305CDE;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">List My Space</a>
          <p style="color:#6B7280;font-size:13px;">If you have any questions, contact us at support@vencome.com</p>
          <p style="color:#6B7280;font-size:13px;">The VenCome Team</p>
        </div>
      `,
    });

    res.json({ success: true, message: "Invite sent successfully" });
  } catch (err) {
    console.error("Referral invite error:", err);
    res.status(500).json({ error: "Failed to send invite" });
  }
});

module.exports = router;
