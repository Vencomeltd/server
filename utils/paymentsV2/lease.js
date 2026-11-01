// Leases (Property.pricing.minimumTermMonths): one booking per month, sharing
// a groupId. Month 1 is paid at checkout like any series (its PaymentIntent
// saves the card); every later month is charged to that card off-session
// PAYMENTS_CONFIG.leaseChargeLeadDays before it starts. A failed month is
// retried daily for leaseRetryDays, then waits for the host and VenCome to
// decide (routes/adminLeases.js: retry or end the lease).
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Booking = require("../../models/Booking");
const Property = require("../../models/Property");
const { PAYMENTS_CONFIG } = require("../../config/payments");
const { HOUR_MS, computeBookingAmounts } = require("./amounts");
const { cancelDeposit } = require("./depositHold");
const { markLeaseMonthPaid } = require("./bookingPayment");
const notify = require("./notify");

const DAY_MS = 24 * HOUR_MS;

// Charges one lease month to the saved card. Card declines come back as a
// thrown error (off-session confirm), so the outcome is known right here;
// the payment_intent.succeeded webhook re-applies a success harmlessly.
async function chargeLeaseMonth(booking, now = new Date()) {
  const lease = booking.lease;
  const amounts = computeBookingAmounts(booking);
  const attempt = (lease.attempts || 0) + 1;

  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: amounts.amountPence,
        currency: PAYMENTS_CONFIG.currency,
        customer: lease.customerId,
        payment_method: lease.paymentMethodId,
        off_session: true,
        confirm: true,
        transfer_group: `booking_${booking._id}`,
        description: `Lease month ${lease.index} of ${lease.months} — booking ${booking._id}`,
        metadata: { bookingId: booking._id.toString(), groupId: booking.groupId, type: "lease_month" },
      },
      { idempotencyKey: `lease-month:${booking._id}:${attempt}:${lease.paymentMethodId}` }
    );
    lease.attempts = attempt;
    Object.assign(booking.payment, {
      paymentIntentId: pi.id,
      amountPence: amounts.amountPence,
      listingPricePence: amounts.listingPricePence,
      commissionPence: amounts.commissionPence,
      hostAmountPence: amounts.hostAmountPence,
      transferGroup: `booking_${booking._id}`,
      status: "pending",
    });
    booking.paymentIntentId = pi.id;
    await booking.save();
    if (pi.status === "succeeded") await markLeaseMonthPaid(pi);
    return { paid: pi.status === "succeeded" };
  } catch (err) {
    lease.attempts = attempt;
    lease.lastError = err.decline_code || err.code || err.message;
    // The first try plus leaseRetryDays daily retries, then a human decides.
    if (attempt <= PAYMENTS_CONFIG.leaseRetryDays) {
      lease.chargeStatus = "failed";
      lease.nextRetryAt = new Date(now.getTime() + DAY_MS);
      await booking.save();
      if (attempt === 1) await notify.leasePaymentFailed(booking);
    } else {
      lease.chargeStatus = "awaiting_decision";
      lease.nextRetryAt = undefined;
      await booking.save();
      await notify.leasePaymentNeedsDecision(booking);
    }
    return { paid: false, error: lease.lastError };
  }
}

// Scheduler step: months that are due, and failed months due a retry. Only
// confirmed leases whose first month went through.
async function chargeDueLeaseMonths(now) {
  const due = await Booking.find({
    status: "confirmed",
    isPaid: { $ne: true },
    "lease.securedAt": { $exists: true },
    $or: [
      { "lease.chargeStatus": "scheduled", "lease.chargeAt": { $lte: now } },
      { "lease.chargeStatus": "failed", "lease.nextRetryAt": { $lte: now } },
    ],
  });
  for (const booking of due) {
    try {
      await chargeLeaseMonth(booking, now);
    } catch (err) {
      console.error(`[Payments Scheduler] Lease charge failed for booking ${booking._id}:`, err.message);
    }
  }
}

// Ends a lease from the first unpaid month on: those months are cancelled
// (nothing was taken for them, so nothing is refunded), their dates freed,
// and the lease's deposit now covers only the months that remain -- or is
// returned if none do. Paid months are left exactly as they are.
async function endLease(groupId) {
  const unpaid = await Booking.find({ groupId, isPaid: { $ne: true }, status: { $in: ["pending", "confirmed"] } });
  const ids = unpaid.map((b) => b._id);
  if (ids.length) {
    await Booking.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          status: "cancelled",
          cancelledAt: new Date(),
          "lease.chargeStatus": "stopped",
          refund: { percent: 0, amount: 0, reason: "Lease ended by VenCome — no payment had been taken for this month", stripeRefundId: null, processedAt: null },
        },
        $unset: { "lease.nextRetryAt": "" },
      }
    );
    await Property.updateOne({ _id: unpaid[0].property }, { $pull: { blockedDates: { bookingId: { $in: ids } } } });
  }

  const holder = await Booking.findOne({ groupId, "depositHold.coversUntil": { $exists: true } });
  if (holder) {
    const last = await Booking.findOne({ groupId, status: { $in: ["confirmed", "completed"] } }).sort({ checkOut: -1 });
    if (!last) {
      await cancelDeposit(holder);
    } else if (last.checkOut < holder.depositHold.coversUntil) {
      holder.depositHold.coversUntil = last.checkOut;
      await holder.save();
    }
  }
  return ids.length;
}

// The guest added a new card: every unpaid month uses it, and a failed or
// stuck month is charged again straight away.
async function useNewLeaseCard(groupId, paymentMethodId) {
  await Booking.updateMany({ groupId, isPaid: { $ne: true } }, { $set: { "lease.paymentMethodId": paymentMethodId } });
  const stuck = await Booking.find({
    groupId,
    status: "confirmed",
    isPaid: { $ne: true },
    "lease.chargeStatus": { $in: ["failed", "awaiting_decision"] },
  }).sort({ checkIn: 1 });
  const results = [];
  for (const booking of stuck) results.push(await chargeLeaseMonth(booking));
  return results;
}

module.exports = { chargeLeaseMonth, chargeDueLeaseMonths, endLease, useNewLeaseCard };
