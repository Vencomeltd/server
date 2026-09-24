// Stripe operations for the payments v2 damage deposit: placing a card hold
// (or charging a deposit), releasing/capturing/refunding it, and paying an
// approved claim to the host. Money is integer pence. Every Stripe write
// carries an idempotency key built from the booking id and the action.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const User = require("../../models/User");
const { PAYMENTS_CONFIG } = require("../../config/payments");
const { HOUR_MS } = require("./amounts");
const notify = require("./notify");

// Card problems the customer can fix by adding a new card. Anything else
// (network errors, Stripe outages) is rethrown so the scheduler retries.
const CUSTOMER_FIXABLE_CODES = new Set([
  "card_declined",
  "authentication_required",
  "expired_card",
  "insufficient_funds",
  "incorrect_cvc",
  "processing_error",
  "resource_missing",
  "payment_intent_authentication_failure",
]);

const isCustomerFixable = (err) =>
  err?.type === "StripeCardError" || CUSTOMER_FIXABLE_CODES.has(err?.code) || /^payment_method/.test(err?.code || "");

// Returns the user's Stripe Customer id, creating one if needed. A stored id
// that no longer exists (e.g. created in test mode before the live switch) is
// replaced.
async function getOrCreateCustomer(user) {
  if (user.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(user.stripeCustomerId);
      if (existing && !existing.deleted) return user.stripeCustomerId;
    } catch (err) {
      if (err.code !== "resource_missing" && !/test mode|live mode|No such customer/i.test(err.message || "")) throw err;
    }
  }
  const options = user.stripeCustomerId ? undefined : { idempotencyKey: `customer:${user._id}:v1` };
  const customer = await stripe.customers.create(
    {
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
      metadata: { userId: user._id.toString() },
    },
    options
  );
  // updateOne rather than user.save(): a full save re-validates the whole user
  // document and could fail on older accounts unrelated to payments.
  await User.updateOne({ _id: user._id }, { stripeCustomerId: customer.id });
  user.stripeCustomerId = customer.id;
  return customer.id;
}

async function markAwaitingNewCard(booking, reason) {
  const dh = booking.depositHold;
  dh.status = "awaiting_new_card";
  dh.failureReason = reason;
  dh.cardFixDeadline = new Date(Date.now() + PAYMENTS_CONFIG.cardFixHours * HOUR_MS);
  dh.attempt = (dh.attempt || 0) + 1;
  await booking.save();
  await notify.holdFailed(booking);
}

// Places the deposit: a manual-capture hold for card_hold, or an immediate
// charge for charged mode. onSession=true means the customer is present.
// Idempotent per attempt: the attempt counter only advances after a definite
// card failure, so a retry after a crash reuses the same Stripe idempotency
// key and can never create a second hold.
async function placeDeposit(booking, { onSession }) {
  const dh = booking.depositHold;
  if (!dh?.amountPence || dh.amountPence <= 0) return;

  if (!dh.paymentMethodId) {
    await markAwaitingNewCard(booking, "no_saved_card");
    return;
  }

  const guest = await User.findById(booking.guest);
  const customerId = await getOrCreateCustomer(guest);
  const isHold = dh.mode === "card_hold";

  let pi;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: dh.amountPence,
        currency: PAYMENTS_CONFIG.currency,
        customer: customerId,
        payment_method: dh.paymentMethodId,
        payment_method_types: ["card"],
        capture_method: isHold ? "manual" : "automatic",
        confirm: true,
        off_session: !onSession,
        description: `${isHold ? "Deposit hold" : "Deposit"} for booking ${booking._id}`,
        metadata: { bookingId: booking._id.toString(), type: isHold ? "deposit_hold" : "deposit_charged" },
      },
      { idempotencyKey: `deposit-hold:${booking._id}:v${(dh.attempt || 0) + 1}` }
    );
  } catch (err) {
    if (isCustomerFixable(err)) {
      await markAwaitingNewCard(booking, err.code || err.message);
      return;
    }
    throw err;
  }

  const placed = pi.status === "requires_capture" || pi.status === "succeeded";
  if (!placed) {
    // Needs customer authentication (3DS) that we can't complete here.
    await stripe.paymentIntents.cancel(pi.id).catch(() => {});
    await markAwaitingNewCard(booking, "authentication_required");
    return;
  }

  dh.paymentIntentId = pi.id;
  dh.failureReason = undefined;
  dh.cardFixDeadline = undefined;

  if (isHold) {
    const charge = await stripe.charges.retrieve(pi.latest_charge);
    const captureBefore = charge.payment_method_details?.card?.capture_before;
    dh.captureBefore = captureBefore ? new Date(captureBefore * 1000) : undefined;
    dh.status = "held";
  } else {
    dh.capturedPence = pi.amount_received ?? dh.amountPence;
    dh.status = "charged";
  }
  await booking.save();
  await notify.holdPlaced(booking);
}

// Releases an unused card hold (no claim). Never acts after capture_before:
// Stripe has already auto-released a hold past that time.
async function releaseHold(booking) {
  const dh = booking.depositHold;
  const expired = dh.captureBefore && Date.now() >= new Date(dh.captureBefore).getTime();
  if (dh.paymentIntentId && !expired) {
    try {
      await stripe.paymentIntents.cancel(dh.paymentIntentId, {}, { idempotencyKey: `deposit-release:${booking._id}:v1` });
    } catch (err) {
      // Already cancelled / captured on Stripe's side -- our record is what's stale.
      if (err.code !== "payment_intent_unexpected_state") throw err;
    }
  }
  dh.status = "released";
  await booking.save();
}

// Captures `amountPence` of a held deposit; Stripe releases the remainder.
async function captureHold(booking, amountPence) {
  const dh = booking.depositHold;
  if (dh.mode !== "card_hold" || !dh.paymentIntentId) throw new Error("No card hold to capture");
  if (dh.captureBefore && Date.now() >= new Date(dh.captureBefore).getTime()) throw new Error("HOLD_EXPIRED");
  const amount = Math.min(amountPence, dh.amountPence);

  const pi = await stripe.paymentIntents.capture(
    dh.paymentIntentId,
    { amount_to_capture: amount },
    { idempotencyKey: `deposit-capture:${booking._id}:${amount}:v1` }
  );
  dh.capturedPence = pi.amount_received ?? amount;
  dh.status = dh.capturedPence >= dh.amountPence ? "captured" : "partially_captured";
  await booking.save();
  return pi;
}

// Refunds part or all of money already taken on the deposit payment.
async function refundDepositPayment(booking, amountPence, tag) {
  const dh = booking.depositHold;
  if (!dh.paymentIntentId || amountPence <= 0) return null;
  return stripe.refunds.create(
    {
      payment_intent: dh.paymentIntentId,
      amount: amountPence,
      metadata: { bookingId: booking._id.toString(), type: `deposit_refund_${tag}` },
    },
    { idempotencyKey: `deposit-refund:${booking._id}:${tag}:${amountPence}:v1` }
  );
}

// Charged mode, no claim: refund the whole deposit.
async function refundChargedDeposit(booking) {
  const dh = booking.depositHold;
  await refundDepositPayment(booking, dh.capturedPence || dh.amountPence, "full");
  dh.status = "refunded";
  await booking.save();
  await notify.depositReleased(booking);
}

// Pays an approved claim to the host, sourced from the deposit's own charge.
async function transferClaimToHost(booking, amountPence) {
  if (amountPence <= 0) return null;
  const host = await User.findById(booking.host).select("stripeAccountId");
  if (!host?.stripeAccountId) throw new Error("Host has no connected Stripe account");
  const pi = await stripe.paymentIntents.retrieve(booking.depositHold.paymentIntentId);
  return stripe.transfers.create(
    {
      amount: amountPence,
      currency: PAYMENTS_CONFIG.currency,
      destination: host.stripeAccountId,
      source_transaction: pi.latest_charge,
      transfer_group: `booking_${booking._id}`,
      metadata: { bookingId: booking._id.toString(), type: "damage_claim" },
    },
    { idempotencyKey: `claim-transfer:${booking._id}:v1` }
  );
}

// Cancellation: drop any scheduled/held deposit and refund a charged one.
async function cancelDeposit(booking) {
  const dh = booking.depositHold;
  if (!dh?.status) return;

  if (["scheduled", "awaiting_new_card", "awaiting_host_decision"].includes(dh.status)) {
    dh.status = "released";
    await booking.save();
  } else if (dh.status === "held") {
    await releaseHold(booking);
  } else if (dh.status === "charged") {
    await refundChargedDeposit(booking);
  }
}

module.exports = {
  getOrCreateCustomer,
  placeDeposit,
  releaseHold,
  captureHold,
  refundDepositPayment,
  refundChargedDeposit,
  transferClaimToHost,
  cancelDeposit,
  markAwaitingNewCard,
  isCustomerFixable,
};
