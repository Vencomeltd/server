const cron = require("node-cron");
const Booking = require("../models/Booking");
const Payment = require("../models/Payment");
const Payout = require("../models/Payout");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const User = require("../models/User");
const sendSMS = require("./sendSMS");
const makeUserHost = require("./stripeConnect");
const { PAYMENTS_CONFIG } = require("../config/payments");

module.exports = function setupEscrowRelease() {
  cron.schedule("0 * * * *", async () => {
    console.log("[Escrow Release] Checking for bookings ready for payout...");
    try {
      const now = new Date();
      const readyBookings = await Booking.find({
        status: "completed",
        isPaid: true,
        escrowReleased: false,
        disputeFrozen: { $ne: true },
        // Payments v2 bookings are paid out by utils/paymentsV2/scheduler.js
        // (with source_transaction + idempotency) -- never twice.
        "payment.chargeId": { $exists: false },
        checkOut: { $lt: new Date(now.getTime() - PAYMENTS_CONFIG.escrowReleaseHours * 60 * 60 * 1000) },
      }).populate("host");

      for (const booking of readyBookings) {
        const host = await User.findById(booking.host);
        if (!host?.stripeAccountId) {
          console.warn(`[Escrow] Host ${booking.host} has no Stripe account — skipping`);
          continue;
        }

        const amountToHost = Math.round(booking.hostAmount * 100); // cents
        if (amountToHost <= 0) {
          console.warn(`[Escrow] Booking ${booking._id} has zero hostAmount — skipping`);
          continue;
        }

        try {
          const transfer = await stripe.transfers.create({
            amount: amountToHost,
            currency: "gbp",
            destination: host.stripeAccountId,
            transfer_group: booking._id.toString(),
            description: `Payout for booking ${booking._id} after ${PAYMENTS_CONFIG.escrowReleaseHours}hr escrow`,
          });

          booking.escrowReleased = true;
          booking.stripeTransferId = transfer.id;
          await booking.save();

          const payment = await Payment.findOne({ booking: booking._id });
          await Payout.create({
            host: host._id,
            booking: booking._id,
            payment: payment?._id,
            amount: booking.hostAmount,
            platformFee: booking.platformFee,
            totalReceived: booking.totalPrice,
            stripeTransferId: transfer.id,
            payoutMethod: "bank_account",
            status: "paid",
            releasedAt: new Date(),
          });

          console.log(`[Escrow] Released $${amountToHost / 100} to host ${host._id} for booking ${booking._id}`);

          if (host.phoneNumber && host.isPhoneVerified) {
            sendSMS({
              to: host.phoneNumber,
              body: `VenCome: You've been paid £${(amountToHost / 100).toFixed(2)} for booking ${booking._id.toString().slice(-8).toUpperCase()}.`,
            }).catch((err) => {
              if (err.code !== "SMS_NOT_CONFIGURED") console.error("Payout SMS to host failed:", err.message);
            });
          }
        } catch (transferErr) {
          console.error(`[Escrow] Transfer failed for booking ${booking._id}:`, transferErr.message);
          // This host's account predates Stripe's test-to-live switch --
          // clear it so they get prompted to reconnect next time they open
          // Payouts, instead of this transfer silently failing on this same
          // dead account id every hour forever.
          if (makeUserHost.isStaleAccountError(transferErr)) {
            await makeUserHost.clearStaleStripeAccount(host._id).catch(() => {});
            console.error(`[Escrow] Host ${host._id} has a stale pre-live-mode Stripe account -- cleared, needs to reconnect.`);
          } else {
            // Otherwise this is very likely Stripe refusing the transfer
            // because the destination account is still "Restricted" --
            // outstanding verification requirements (identity, business
            // info, banking) that only the host themselves can clear.
            // Nothing to auto-fix here, but log it plainly instead of
            // letting it look like the same generic failure every hour.
            try {
              const account = await stripe.accounts.retrieve(host.stripeAccountId);
              const outstanding = account.requirements?.currently_due || [];
              if (outstanding.length > 0) {
                console.error(`[Escrow] Host ${host._id} (booking ${booking._id}) is blocked on Stripe verification: ${outstanding.join(", ")}`);
              }
            } catch (lookupErr) {
              console.error(`[Escrow] Requirements lookup failed for host ${host._id}:`, lookupErr.message);
            }
          }
        }
      }
    } catch (err) {
      console.error("[Escrow Release Cron] Error:", err);
    }
  });
};
