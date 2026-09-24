// Payments v2 cancellation money movement (spec Phase 8): refund the booking
// by the configured tier, reverse the host's share if it was already paid out,
// and cancel/refund the deposit. A no-show is NOT a cancellation -- the host
// payout just proceeds as normal.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Property = require("../../models/Property");
const { HOUR_MS, getRefundTier } = require("./amounts");
const { cancelDeposit } = require("./depositHold");

// Refunds `refundPercent` of the amount charged. If the host share had already
// been transferred, the matching share is reversed so VenCome isn't left
// out of pocket. Returns { stripeRefund, refundPence }.
async function refundBookingPayment(booking, refundPercent, tag = "cancel") {
  const p = booking.payment;
  if (!p?.chargeId || !p.amountPence || refundPercent <= 0) return { stripeRefund: null, refundPence: 0 };

  const refundPence = Math.round((p.amountPence * refundPercent) / 100);
  const stripeRefund = await stripe.refunds.create(
    {
      payment_intent: p.paymentIntentId,
      amount: refundPence,
      reason: "requested_by_customer",
      metadata: { bookingId: booking._id.toString(), type: "booking_refund", tag },
    },
    { idempotencyKey: `refund:${booking._id}:${tag}:${refundPence}:v1` }
  );

  if (p.transferId && !p.transferReversedAt) {
    const reversePence = Math.round(((p.hostAmountPence || 0) * refundPercent) / 100);
    if (reversePence > 0) {
      await stripe.transfers.createReversal(
        p.transferId,
        { amount: reversePence, metadata: { bookingId: booking._id.toString(), type: "cancellation_reversal" } },
        { idempotencyKey: `reversal:${booking._id}:${reversePence}:v1` }
      );
    }
    p.transferReversedAt = new Date();
  }

  p.status = refundPercent >= 100 ? "refunded" : "partially_refunded";
  await booking.save();
  return { stripeRefund, refundPence };
}

// The host chose "cancel" after the guest failed to fix their card in time.
// Handled as a customer cancellation, so the normal refund tier applies.
async function cancelFromHostDecision(booking) {
  const hoursUntilCheckIn = (new Date(booking.checkIn).getTime() - Date.now()) / HOUR_MS;
  const tier = getRefundTier(hoursUntilCheckIn);

  const { stripeRefund, refundPence } = await refundBookingPayment(booking, tier.refundPercent, "host-decision");
  await cancelDeposit(booking);

  booking.status = "cancelled";
  booking.cancelledBy = "guest";
  booking.cancelledAt = new Date();
  booking.refund = {
    percent: tier.refundPercent,
    amount: refundPence / 100,
    reason: `${tier.reason} (deposit could not be secured)`,
    stripeRefundId: stripeRefund?.id || null,
    processedAt: stripeRefund ? new Date() : null,
  };
  await booking.save();

  await Property.findByIdAndUpdate(booking.property, { $pull: { blockedDates: { bookingId: booking._id } } });
  return booking;
}

module.exports = { refundBookingPayment, cancelFromHostDecision };
