// Admin damage-claim queue and resolution (spec Phase 5), mounted at
// /api/admin/claims. Only the support tier (and full admins) can resolve, and
// every action is written to the claim's audit trail.
const express = require("express");
const { body, param, query, validationResult } = require("express-validator");
const { adminAuth, requireAdminRole } = require("../middleware/auth");
const Booking = require("../models/Booking");
const { captureHold, releaseHold, refundDepositPayment, refundChargedDeposit, transferClaimToHost } = require("../utils/paymentsV2/depositHold");
const notify = require("../utils/paymentsV2/notify");

const router = express.Router();
router.use(adminAuth, requireAdminRole("support"));

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

// GET / -- the claims queue. ?status=open (default) | approved | rejected | all
router.get("/", [query("status").optional().isIn(["open", "approved", "rejected", "all"])], validate, async (req, res) => {
  try {
    const status = req.query.status || "open";
    const filter = status === "all" ? { "damageClaim.status": { $in: ["open", "approved", "rejected"] } } : { "damageClaim.status": status };

    const bookings = await Booking.find(filter)
      .populate("property", "title")
      .populate("guest", "firstName lastName displayName email")
      .populate("host", "firstName lastName displayName email")
      .sort({ "damageClaim.openedAt": 1 })
      .limit(100);

    res.json({ claims: bookings });
  } catch (err) {
    console.error("List claims error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /_test/run-scheduler -- { asOf?: ISO date } runs the payments scheduler
// once as if it were that time. TEST KEYS ONLY: it refuses on a live Stripe key,
// so it can never move real money early.
router.post("/_test/run-scheduler", [body("asOf").optional().isISO8601().withMessage("asOf must be an ISO date")], validate, async (req, res) => {
  if (!(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test_")) {
    return res.status(403).json({ error: "Only available when the server is on Stripe test keys." });
  }
  try {
    const { runPaymentsSchedulerOnce } = require("../utils/paymentsV2/scheduler");
    const asOf = req.body.asOf ? new Date(req.body.asOf) : new Date();
    await runPaymentsSchedulerOnce(asOf);
    res.json({ ran: true, asOf: asOf.toISOString() });
  } catch (err) {
    console.error("Test scheduler run error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:bookingId/resolve -- { decision: "approve" | "reject", approvedAmountPence? }
router.post(
  "/:bookingId/resolve",
  [
    param("bookingId").isMongoId().withMessage("Invalid booking id"),
    body("decision").isIn(["approve", "reject"]).withMessage("Decision must be approve or reject"),
    body("approvedAmountPence").optional().isInt({ min: 1 }).withMessage("Approved amount must be at least 1p").toInt(),
  ],
  validate,
  async (req, res) => {
    try {
      const booking = await Booking.findById(req.params.bookingId);
      if (!booking) return res.status(404).json({ error: "Booking not found" });

      const claim = booking.damageClaim;
      const dh = booking.depositHold;
      if (claim.status !== "open") return res.status(400).json({ error: "This claim isn't open." });

      const { decision } = req.body;
      const alreadyCapturedPence = ["captured", "partially_captured"].includes(dh.status) ? dh.capturedPence || 0 : 0;

      if (decision === "approve") {
        const approved = req.body.approvedAmountPence ?? claim.amountPence;
        const ceiling = alreadyCapturedPence || claim.amountPence;
        if (approved > ceiling) {
          return res.status(400).json({ error: `The approved amount can't be more than £${(ceiling / 100).toFixed(2)}.` });
        }

        if (dh.mode === "card_hold" && dh.status === "held") {
          await captureHold(booking, approved);
        } else if (alreadyCapturedPence) {
          // The scheduler captured the claimed amount to protect an expiring
          // hold -- refund whatever the admin reduced it by.
          if (approved < alreadyCapturedPence) {
            await refundDepositPayment(booking, alreadyCapturedPence - approved, "claim-reduce");
          }
          dh.capturedPence = approved;
          dh.status = approved >= dh.amountPence ? "captured" : "partially_captured";
        } else if (dh.mode === "charged" && dh.status === "charged") {
          const depositTaken = dh.capturedPence || dh.amountPence;
          await refundDepositPayment(booking, depositTaken - approved, "claim");
          dh.capturedPence = approved;
          dh.status = approved >= depositTaken ? "captured" : "partially_captured";
        } else {
          return res.status(400).json({ error: "There is no live deposit to take this claim from." });
        }

        const transfer = await transferClaimToHost(booking, approved);
        claim.status = "approved";
        claim.approvedAmountPence = approved;
        claim.transferId = transfer?.id;
      } else {
        if (dh.mode === "card_hold" && dh.status === "held") {
          await releaseHold(booking);
        } else if (alreadyCapturedPence) {
          await refundDepositPayment(booking, alreadyCapturedPence, "claim-reject");
          dh.status = "refunded";
        } else if (dh.mode === "charged" && dh.status === "charged") {
          await refundChargedDeposit(booking);
        }
        claim.status = "rejected";
        claim.approvedAmountPence = 0;
      }

      claim.resolvedAt = new Date();
      claim.resolvedBy = req.user.id;
      claim.audit.push({ by: req.user.id, action: decision === "approve" ? "approved" : "rejected", amountPence: claim.approvedAmountPence });
      await booking.save();

      console.log(`[Audit] Admin ${req.user.id} ${claim.status} damage claim on booking ${booking._id} (${claim.approvedAmountPence}p)`);
      await notify.claimResolved(booking);
      res.json({ claim: booking.damageClaim, depositHold: booking.depositHold });
    } catch (err) {
      console.error("Resolve claim error:", err);
      res.status(500).json({ error: err.message || "Could not resolve the claim" });
    }
  }
);

module.exports = router;
