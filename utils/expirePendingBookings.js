const cron = require("node-cron");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Booking = require("../models/Booking");
const Payment = require("../models/Payment");
const sendEmail = require("./sendEmail");
const { cancelUnpaidBookings } = require("./bookingHold");

// Request to Book gives the host 24 hours to approve/decline (see
// routes/bookings.js and the booking-confirmation email). If they never
// respond, auto-decline the request and release any held card authorization
// so the guest is never charged.
module.exports = function setupBookingExpiry() {
  cron.schedule("*/30 * * * *", async () => {
    console.log("[Booking Expiry] Checking for unanswered requests older than 24h...");
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const staleBookings = await Booking.find({
        status: "pending",
        createdAt: { $lt: cutoff },
        // Only touch bookings created under the new deferred-capture flow
        // (paymentAuthorizedAt is set by the webhook only when a manual-
        // capture PaymentIntent was authorized). This deliberately excludes
        // any pre-existing "pending" booking from before this feature
        // shipped — those may already be paid under the old immediate-
        // capture flow, and auto-declining them here would both cancel a
        // booking the host might still be about to approve and send the
        // guest a "you were not charged" email that could be false.
        paymentAuthorizedAt: { $exists: true },
      })
        .populate("property", "title")
        .populate("guest", "email firstName displayName");

      for (const booking of staleBookings) {
        try {
          const awaitingCapture = Boolean(booking.paymentIntentId) && !booking.isPaid;

          if (awaitingCapture) {
            await stripe.paymentIntents.cancel(booking.paymentIntentId).catch((err) => {
              console.warn(
                `[Booking Expiry] Could not release payment hold for booking ${booking._id}:`,
                err.message
              );
            });
            await Payment.findOneAndUpdate({ booking: booking._id }, { status: "released" });
          }

          booking.status = "declined";
          await booking.save();
          // A lease's later months have no card authorisation of their own.
          if (booking.lease?.months) {
            await Booking.updateMany({ groupId: booking.groupId, status: "pending" }, { $set: { status: "declined" } });
          }

          const guestUser = booking.guest;
          if (guestUser?.email) {
            const guestName = guestUser.displayName || guestUser.firstName || "there";
            await sendEmail({
              to: guestUser.email,
              subject: "Your booking request expired",
              html: `
                <div style="font-family: 'Manrope', Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
                  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                    <div style="background-color: #f0f0f0; padding: 20px; text-align: center;">
                      <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="max-width: 150px;">
                    </div>
                    <div style="padding: 30px; color: #333;">
                      <h2 style="color: #305CDE; text-align: center; margin-top: 0;">Booking Request Expired</h2>
                      <p>Hi <strong>${guestName}</strong>,</p>
                      <p>The host didn't respond to your booking request for <strong>${booking.property?.title || "the space"}</strong> within 24 hours, so it has expired.</p>
                      <p>You have not been charged — no payment was captured.</p>
                      <div style="text-align: center; margin: 30px 0;">
                        <a href="https://www.vencome.com/search" style="display: inline-block; background-color: #0A1628; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">Find Another Space</a>
                      </div>
                      <p style="margin-bottom: 0;">The VenCome Team</p>
                    </div>
                    <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
                      This is an automated message, please do not reply.<br />
                      © ${new Date().getFullYear()} VenCome. All rights reserved.
                    </div>
                  </div>
                </div>
              `,
            });
          }

          console.log(`[Booking Expiry] Expired booking ${booking._id}`);
        } catch (err) {
          console.error(`[Booking Expiry] Failed to expire booking ${booking._id}:`, err.message);
        }
      }
    } catch (err) {
      console.error("[Booking Expiry Cron] Error:", err.message);
    }

    // Bookings the guest never paid for. They stopped blocking their dates
    // after 30 minutes (utils/unitAvailability.js); this just clears them
    // out of the bookings lists. No email -- the guest never finished
    // booking. A late payment is refunded by the webhook.
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const cancelled = await cancelUnpaidBookings({ createdAt: { $lt: cutoff } });
      if (cancelled) {
        console.log(`[Booking Expiry] Cancelled ${cancelled} abandoned unpaid booking(s)`);
      }
    } catch (err) {
      console.error("[Booking Expiry Cron] Abandoned cleanup error:", err.message);
    }
  });
};
