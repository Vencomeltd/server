const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const HostWallet = require("../models/HostWallet");
const WalletTransaction = require("../models/WalletTransaction");

// Credits a booking's deposit into the host's wallet as "reserved" (not yet
// withdrawable -- see models/HostWallet.js) the moment the deposit is
// actually charged (payment captured, either on host approval for Request
// to Book, or immediately for Instant Book). Callers must only invoke this
// once per booking -- check booking.deposit.status first (it stays "none"
// until this runs) -- since it isn't itself idempotent.
async function creditDepositToWallet(booking) {
  if (!booking.deposit?.amount || booking.deposit.amount <= 0) return;

  await HostWallet.findOneAndUpdate(
    { host: booking.host },
    { $inc: { reservedBalance: booking.deposit.amount } },
    { upsert: true }
  );

  await WalletTransaction.create({
    host: booking.host,
    booking: booking._id,
    type: "deposit_credit",
    amount: booking.deposit.amount,
    balanceType: "reserved",
  });

  booking.deposit.status = "charged";
  booking.deposit.chargedAt = new Date();
}

// Fully refunds a booking's deposit to the guest via Stripe and debits the
// host's reserved wallet balance. Used for both pre-checkin cancellation
// (always a full deposit refund, regardless of whichever rent-refund tier
// applied) and the host-triggered "clean checkout" refund. Returns the
// Stripe refund object, or null if there was nothing to refund (deposit
// never charged, or already refunded/claimed).
async function refundDeposit(booking) {
  if (booking.deposit?.status !== "charged") return null;

  const stripeRefund = await stripe.refunds.create({
    payment_intent: booking.paymentIntentId,
    amount: Math.round(booking.deposit.amount * 100),
    reason: "requested_by_customer",
    metadata: { bookingId: booking._id.toString(), type: "deposit_refund" },
  });

  await HostWallet.findOneAndUpdate(
    { host: booking.host },
    { $inc: { reservedBalance: -booking.deposit.amount } }
  );

  await WalletTransaction.create({
    host: booking.host,
    booking: booking._id,
    type: "deposit_refund",
    amount: booking.deposit.amount,
    balanceType: "reserved",
  });

  booking.deposit.status = "refunded";
  booking.deposit.refundedAt = new Date();

  return stripeRefund;
}

// Settles a filed damage claim for `approvedAmount` (may be less than the
// full claim.amount if an admin reduces it on review) -- moves that much
// from the host's reserved balance to their available balance (see
// models/HostWallet.js; available auto-transfers to the host's Stripe
// Connect account the same way rent escrow does, so no separate withdraw
// step is needed), and refunds whatever's left of the deposit to the guest.
// Used both by the 48h no-dispute auto-settle sweep and by admin manually
// resolving a disputed claim.
async function settleClaim(booking, approvedAmount, resolvedBy) {
  if (booking.deposit?.status !== "claimed" && booking.deposit?.status !== "partially_claimed") return;

  const depositAmount = booking.deposit.amount;
  const remainder = Math.max(0, depositAmount - approvedAmount);

  if (approvedAmount > 0) {
    await HostWallet.findOneAndUpdate(
      { host: booking.host },
      { $inc: { reservedBalance: -approvedAmount, availableBalance: approvedAmount } }
    );
    await WalletTransaction.create({
      host: booking.host,
      booking: booking._id,
      type: "claim_settled",
      amount: approvedAmount,
      balanceType: "available",
    });
  }

  if (remainder > 0) {
    await stripe.refunds.create({
      payment_intent: booking.paymentIntentId,
      amount: Math.round(remainder * 100),
      reason: "requested_by_customer",
      metadata: { bookingId: booking._id.toString(), type: "deposit_claim_remainder_refund" },
    });
    await HostWallet.findOneAndUpdate(
      { host: booking.host },
      { $inc: { reservedBalance: -remainder } }
    );
    await WalletTransaction.create({
      host: booking.host,
      booking: booking._id,
      type: "deposit_refund",
      amount: remainder,
      balanceType: "reserved",
    });
  }

  booking.deposit.status = approvedAmount >= depositAmount ? "claimed" : "partially_claimed";
  booking.deposit.claim.amount = approvedAmount;
  booking.deposit.claim.resolvedAt = new Date();
  if (resolvedBy) booking.deposit.claim.resolvedBy = resolvedBy;
}

module.exports = { creditDepositToWallet, refundDeposit, settleClaim };
