// An unpaid Request to Book only holds its dates for HOLD_MINUTES (see
// utils/unitAvailability.js). These two helpers stop a guest paying for a
// booking that has since been cancelled, or whose dates someone else took
// after the hold lapsed.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Booking = require("../models/Booking");
const Property = require("../models/Property");
const User = require("../models/User");
const sendEmail = require("./sendEmail");
const { holdExpired, getUnitOccupancy, isFullyBooked, pickAvailableUnit } = require("./unitAvailability");

// True if the booking can still be paid for. If its own unit was taken but
// another is free, it moves to that unit. If its dates are gone, the booking
// is cancelled and false is returned.
async function ensureBookingStillHeld(booking) {
  if (["cancelled", "declined", "completed"].includes(booking.status)) return false;
  if (!holdExpired(booking)) return true;

  const property = await Property.findById(booking.property?._id || booking.property).select("_id unitsCount blockedDates");
  const occupancy = property
    ? await getUnitOccupancy(property, booking.checkIn, booking.checkOut, { excludeBookingId: booking._id })
    : null;

  if (!occupancy || isFullyBooked(occupancy, property.unitsCount)) {
    booking.status = "cancelled";
    booking.cancelledAt = new Date();
    await Booking.updateOne({ _id: booking._id }, { status: "cancelled", cancelledAt: booking.cancelledAt });
    return false;
  }

  const ownUnit = booking.unitIndex == null ? 1 : booking.unitIndex;
  if (occupancy.takenUnits.has(ownUnit)) {
    booking.unitIndex = pickAvailableUnit(occupancy, property.unitsCount);
    await Booking.updateOne({ _id: booking._id }, { unitIndex: booking.unitIndex });
  }
  return true;
}

// The guest's payment arrived for a booking that ensureBookingStillHeld
// rejected: release the card authorisation, or refund if it was captured.
async function releaseLostBookingPayment(booking, paymentIntentId) {
  let outcome = "none";
  if (paymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status === "succeeded") {
      await stripe.refunds.create({ payment_intent: pi.id }, { idempotencyKey: `lost-booking-refund:${pi.id}` });
      outcome = "refunded";
    } else if (pi.status !== "canceled") {
      await stripe.paymentIntents.cancel(pi.id);
      outcome = "released";
    }
  }
  console.warn(`[Booking hold] Payment for ${booking.status} booking ${booking._id} ${outcome}`);
  if (outcome === "none") return;

  const guest = await User.findById(booking.guest).select("email firstName displayName");
  if (!guest?.email) return;
  const name = guest.displayName || guest.firstName || "there";
  const moneyLine =
    outcome === "refunded"
      ? "Your payment has been refunded in full. It can take 5–10 working days to appear on your statement."
      : "You have not been charged — the hold on your card has been released.";
  await sendEmail({
    to: guest.email,
    subject: "Your booking could not be completed",
    html: `<div style="font-family:'Manrope',Arial,sans-serif;background:#f4f4f7;padding:20px;">
      <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
        <div style="background:#f0f0f0;padding:20px;text-align:center;"><img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="max-width:150px;"></div>
        <div style="padding:30px;color:#333;">
          <h2 style="color:#305CDE;text-align:center;margin-top:0;">Booking not completed</h2>
          <p>Hi <strong>${name}</strong>,</p>
          <p>This booking was no longer open when your payment came through — it had been cancelled, or its checkout ran past 30 minutes and the dates were booked by someone else.</p>
          <p>${moneyLine}</p>
          <div style="text-align:center;margin:30px 0;">
            <a href="https://www.vencome.com/search" style="display:inline-block;background:#0A1628;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;">Find Another Space</a>
          </div>
          <p style="margin-bottom:0;">The VenCome Team</p>
        </div>
        <div style="background:#f0f0f0;padding:20px;text-align:center;font-size:12px;color:#888;">© ${new Date().getFullYear()} VenCome. All rights reserved.</div>
      </div>
    </div>`,
  });
}

module.exports = { ensureBookingStillHeld, releaseLostBookingPayment };
