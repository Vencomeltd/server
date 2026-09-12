const express = require("express");
const router = express.Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Booking = require("../models/Booking");
const Payment = require("../models/Payment");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const googleCalendar = require("../utils/googleCalendar");
const outlookCalendar = require("../utils/outlookCalendar");
const { creditDepositToWallet } = require("../utils/wallet");
const { sendBookingCreatedNotifications } = require("../utils/bookingNotifications");

router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const bookingId = session.metadata?.bookingId;
      if (!bookingId) return res.json({ received: true });

      const booking = await Booking.findById(bookingId).populate("property", "title host location");
      if (!booking || booking.isPaid) return res.json({ received: true });

      booking.stripeSessionId = session.id;
      booking.paymentIntentId = session.payment_intent;

      // Booking-time commission (routes/bookings.js) is authoritative — don't
      // recalculate it here. Just find out whether Stripe actually captured
      // the charge yet (Instant Book) or only authorized it (Request to Book
      // uses manual capture — see routes/payments.js).
      const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
      const captured = paymentIntent.status === "succeeded";

      const total = booking.totalPrice;
      const platformFee = booking.platformFee;
      const hostAmount = booking.hostAmount;
      const io = req.app.get("io");
      const guestUser = await User.findById(booking.guest);
      const hostUser = await User.findById(booking.property.host);

      if (captured) {
        booking.isPaid = true;
        const releaseDate = new Date(booking.checkOut);
        releaseDate.setHours(releaseDate.getHours() + 24);
        booking.escrowReleaseDate = releaseDate;
        await creditDepositToWallet(booking);
        await booking.save();
        await sendBookingCreatedNotifications(booking, booking.property, guestUser, hostUser, io);

        await Payment.create({
          booking: booking._id,
          guest: booking.guest,
          host: booking.property.host,
          amount: total,
          platformFee,
          hostAmount,
          provider: "stripe",
          providerPaymentId: session.payment_intent,
          status: "paid",
          escrowReleaseAt: releaseDate,
        });

        // Instant Book — confirmed immediately, so push to the host's
        // connected calendar(s) here too (Request to Book does this on
        // approval, in routes/bookings.js PUT /:id/status instead).
        try {
          const hostUser = await User.findById(booking.property.host).select("googleCalendar outlookCalendar");
          const eventPayload = {
            summary: `VenCome booking — ${booking.property.title}`,
            description: `Booking ref ${booking._id.toString().slice(-8).toUpperCase()} via VenCome.`,
            start: booking.checkIn,
            end: booking.checkOut,
          };

          if (hostUser?.googleCalendar?.connected) {
            booking.googleCalendarEventId = await googleCalendar.createEvent(
              hostUser.googleCalendar.refreshToken,
              eventPayload
            );
          }
          if (hostUser?.outlookCalendar?.connected) {
            booking.outlookCalendarEventId = await outlookCalendar.createEvent(
              hostUser.outlookCalendar.refreshToken,
              eventPayload
            );
          }
          if (booking.isModified()) await booking.save();
        } catch (calErr) {
          console.error(`Calendar push failed for booking ${booking._id}:`, calErr.message);
        }
      } else {
        // Request to Book — card is authorized only. Nothing is captured
        // until the host approves (routes/bookings.js PUT /:id/status), or
        // the authorization is released on decline / 24h expiry.
        booking.paymentAuthorizedAt = new Date();
        await booking.save();
        await sendBookingCreatedNotifications(booking, booking.property, guestUser, hostUser, io);

        await Payment.create({
          booking: booking._id,
          guest: booking.guest,
          host: booking.property.host,
          amount: total,
          platformFee,
          hostAmount,
          provider: "stripe",
          providerPaymentId: session.payment_intent,
          status: "authorized",
        });
      }

      io?.to(`user_${booking.guest}`).emit("paymentSuccess", { bookingId });

      // Only send a "payment confirmed" email when a charge actually happened.
      // For Request to Book, the booking-creation email already explains that
      // the guest won't be charged until the host approves.
      if (captured) {
        const user = guestUser;
        if (user) {
          const displayName = user.displayName || user.firstName || "there";
          sendEmail({
            to: user.email,
            subject: "Your payment is confirmed 🎉",
            html: `<div style="font-family:'Manrope',Arial,sans-serif;background:#f4f4f7;padding:20px;">
              <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
                <div style="background:#f0f0f0;padding:20px;text-align:center;"><img src="${process.env.CLIENT_URL}/logo-blue.png" alt="VenCome" style="max-width:150px;"></div>
                <div style="padding:30px;color:#333;">
                  <h2 style="color:#305CDE;text-align:center;">Payment Successful 🎉</h2>
                  <p>Hi <strong>${displayName}</strong>, your payment of <strong>£${total}</strong> for <strong>${booking.property.title}</strong> has been received.</p>
                  <p>Your booking is now fully secured. View or manage it from your VenCome dashboard.</p>
                </div>
                <div style="background:#f0f0f0;padding:20px;text-align:center;font-size:12px;color:#888;">© ${new Date().getFullYear()} VenCome. All rights reserved.</div>
              </div>
            </div>`,
          });
        }
      }
    }

    if (event.type === "charge.dispute.created") {
      const dispute = event.data.object;
      console.warn("[Dispute] New dispute created:", dispute.id, "charge:", dispute.charge);

      let paymentIntentId = dispute.payment_intent;
      if (!paymentIntentId && dispute.charge) {
        const charge = await stripe.charges.retrieve(dispute.charge);
        paymentIntentId = charge.payment_intent;
      }

      const booking = paymentIntentId
        ? await Booking.findOne({ paymentIntentId }).populate("property", "title")
        : null;

      if (booking) {
        booking.disputeFrozen = true;
        booking.disputeId = dispute.id;
        await booking.save();

        await Payment.findOneAndUpdate(
          { booking: booking._id },
          { status: "disputed" }
        );
      } else {
        console.warn("[Dispute] No matching booking found for payment_intent:", paymentIntentId);
      }

      sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: `⚠️ Stripe dispute opened${booking ? `: ${booking.property?.title}` : ""}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
            <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
            <h2 style="color:#0A1628;">⚠️ Stripe Dispute Opened</h2>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px 0;color:#666;">Dispute ID</td><td style="padding:8px 0;font-weight:700;">${dispute.id}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Amount</td><td style="padding:8px 0;font-weight:700;">${(dispute.amount / 100).toFixed(2)} ${dispute.currency?.toUpperCase()}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Reason</td><td style="padding:8px 0;font-weight:700;">${dispute.reason}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Booking</td><td style="padding:8px 0;font-weight:700;">${booking ? booking._id : "Not matched — check payment_intent " + paymentIntentId}</td></tr>
            </table>
            <p style="color:#6B7280;font-size:13px;">Escrow release for this booking has been frozen automatically. Review in the Stripe Dashboard and admin Disputes tab.</p>
          </div>
        `,
      });
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing failed:", err);
    res.status(500).json({ error: "Webhook handler failed" });
  }
});

module.exports = router;
