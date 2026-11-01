// Admin lease desk (monthly-instalment leases, utils/paymentsV2/lease.js),
// mounted at /api/admin/leases. Lists leases, and handles a month whose
// payment kept failing: retry it, or end the lease. Every action is written to
// the lease's audit trail (on its first month).
const express = require("express");
const { body, param, query, validationResult } = require("express-validator");
const { adminAuth, requireAdminRole } = require("../middleware/auth");
const Booking = require("../models/Booking");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const { chargeLeaseMonth, endLease } = require("../utils/paymentsV2/lease");

const router = express.Router();
router.use(adminAuth, requireAdminRole("support"));

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

const groupIdParam = param("groupId").isUUID().withMessage("Invalid lease id");
const NEEDS_ATTENTION = ["failed", "awaiting_decision"];

async function audit(groupId, by, action, note) {
  await Booking.updateOne({ groupId, "lease.index": 1 }, { $push: { "lease.audit": { by, action, note } } });
  console.log(`[Audit] Admin ${by} ${action} lease ${groupId}${note ? ` (${note})` : ""}`);
}

// GET / -- leases, newest first. ?attention=1 only those with a failed month.
router.get("/", [query("attention").optional().isIn(["0", "1"])], validate, async (req, res) => {
  try {
    const filter = { "lease.months": { $exists: true } };
    if (req.query.attention === "1") {
      filter.groupId = { $in: await Booking.distinct("groupId", { "lease.chargeStatus": { $in: NEEDS_ATTENTION } }) };
    }
    const firsts = await Booking.find({ ...filter, "lease.index": 1 })
      .populate("property", "title")
      .populate("guest", "firstName lastName displayName email")
      .populate("host", "firstName lastName displayName email")
      .populate("lease.audit.by", "firstName lastName email")
      .sort({ createdAt: -1 })
      .limit(100);

    const months = await Booking.find({ groupId: { $in: firsts.map((b) => b.groupId) } })
      .select("groupId checkIn checkOut status isPaid totalPrice lease.index lease.chargeStatus lease.chargeAt lease.attempts lease.lastError")
      .sort({ checkIn: 1 });

    res.json({
      leases: firsts.map((first) => ({
        groupId: first.groupId,
        property: first.property,
        guest: first.guest,
        host: first.host,
        months: first.lease.months,
        minimumMonths: first.lease.minimumMonths,
        securedAt: first.lease.securedAt,
        audit: first.lease.audit,
        schedule: months.filter((m) => m.groupId === first.groupId),
      })),
    });
  } catch (err) {
    console.error("List leases error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /:groupId/retry -- keep trying: charge the overdue month again now,
// and give it a fresh set of daily retries if it fails.
router.post("/:groupId/retry", [groupIdParam, body("note").optional().isString().trim().isLength({ max: 500 })], validate, async (req, res) => {
  try {
    const booking = await Booking.findOne({
      groupId: req.params.groupId,
      status: "confirmed",
      "lease.chargeStatus": { $in: NEEDS_ATTENTION },
    }).sort({ checkIn: 1 });
    if (!booking) return res.status(400).json({ error: "This lease has no overdue month." });

    booking.lease.attempts = 0;
    const result = await chargeLeaseMonth(booking);
    await audit(req.params.groupId, req.user.id, result.paid ? "retried_paid" : "retried_failed", req.body.note);
    res.json(result);
  } catch (err) {
    console.error("Retry lease month error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /:groupId/end -- { confirm: true, note } ends the lease from its first
// unpaid month. Paid months, payouts and invoices are left untouched.
router.post(
  "/:groupId/end",
  [
    groupIdParam,
    body("confirm").equals("true").withMessage("Confirm ending this lease"),
    body("note").isString().trim().isLength({ min: 3, max: 500 }).withMessage("Add a short reason"),
  ],
  validate,
  async (req, res) => {
    try {
      const first = await Booking.findOne({ groupId: req.params.groupId, "lease.index": 1 }).populate("property", "title");
      if (!first) return res.status(404).json({ error: "Lease not found" });

      const cancelled = await endLease(req.params.groupId);
      await audit(req.params.groupId, req.user.id, "ended", req.body.note);

      const [guest, host] = await Promise.all([
        User.findById(first.guest).select("email firstName displayName"),
        User.findById(first.host).select("email firstName displayName"),
      ]);
      const title = first.property?.title || "the space";
      for (const user of [guest, host]) {
        if (!user?.email) continue;
        sendEmail({
          to: user.email,
          subject: "Your lease has been ended",
          html: `<p>Hi ${user.displayName || user.firstName || "there"}, the lease at <strong>${title}</strong> has been ended by VenCome. ${
            cancelled ? `The remaining ${cancelled} month${cancelled === 1 ? "" : "s"} won't be charged.` : ""
          } Months already paid are unchanged. Please contact VenCome if you have any questions.</p>`,
        }).catch((err) => console.error("Lease ended email failed:", err.message));
      }
      res.json({ cancelledMonths: cancelled });
    } catch (err) {
      console.error("End lease error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

module.exports = router;
