const cron = require("node-cron");
const Booking = require("../models/Booking");
const { refundDeposit, settleClaim } = require("./wallet");

module.exports = function setupDepositAutoRelease() {
  cron.schedule("0 * * * *", async () => {
    // 1. No host action (no refund, no claim) within 72h of checkout --
    // auto-refund the full deposit so it can't get stuck on an inactive host.
    try {
      const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
      const stuck = await Booking.find({
        "deposit.status": "charged",
        checkOut: { $lt: cutoff },
      });

      for (const booking of stuck) {
        try {
          await refundDeposit(booking);
          await booking.save();
          console.log(`[Deposit Auto-Release] Refunded deposit for booking ${booking._id} (72h no action)`);
        } catch (err) {
          console.error(`[Deposit Auto-Release] Refund failed for booking ${booking._id}:`, err.message);
        }
      }
    } catch (err) {
      console.error("[Deposit Auto-Release] 72h sweep error:", err);
    }

    // 2. A filed claim the guest never disputed within 48h -- auto-settle at
    // the originally claimed amount.
    try {
      const now = new Date();
      const undisputed = await Booking.find({
        "deposit.status": { $in: ["claimed", "partially_claimed"] },
        "deposit.claim.disputeStatus": "none",
        "deposit.claim.resolvedAt": { $exists: false },
        "deposit.claim.disputeDeadline": { $lt: now },
      });

      for (const booking of undisputed) {
        try {
          await settleClaim(booking, booking.deposit.claim.amount);
          await booking.save();
          console.log(`[Deposit Auto-Release] Auto-settled undisputed claim for booking ${booking._id}`);
        } catch (err) {
          console.error(`[Deposit Auto-Release] Claim settle failed for booking ${booking._id}:`, err.message);
        }
      }
    } catch (err) {
      console.error("[Deposit Auto-Release] Claim auto-settle sweep error:", err);
    }
  });
};
