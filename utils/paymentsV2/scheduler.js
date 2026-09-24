// Payments v2 scheduler (spec Phase 3.4 + Phase 6). Runs every few minutes and
// is idempotent and restart-safe: every step selects bookings by their stored
// state, and every Stripe write carries an idempotency key, so a repeated or
// overlapping run can't double-place a hold or double-pay a host. It only acts
// on bookings made under payments v2, so it is a no-op if v2 was never used.
const cron = require("node-cron");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Booking = require("../../models/Booking");
const Payment = require("../../models/Payment");
const Payout = require("../../models/Payout");
const User = require("../../models/User");
const makeUserHost = require("../stripeConnect");
const { PAYMENTS_CONFIG } = require("../../config/payments");
const { HOUR_MS, retainedHostSharePence } = require("./amounts");
const { placeDeposit, releaseHold, captureHold, refundChargedDeposit } = require("./depositHold");
const notify = require("./notify");

const NO_CLAIM = { $in: ["none", null] };

async function eachSafely(label, bookings, fn) {
  for (const booking of bookings) {
    try {
      await fn(booking);
    } catch (err) {
      console.error(`[Payments Scheduler] ${label} failed for booking ${booking._id}:`, err.message);
    }
  }
}

// 1. Place card holds / charged deposits that are due.
async function placeDueHolds(now) {
  const due = await Booking.find({
    "depositHold.status": "scheduled",
    "depositHold.holdAt": { $lte: now },
    status: { $nin: ["cancelled", "declined"] },
  });
  await eachSafely("Deposit placement", due, (b) => placeDeposit(b, { onSession: false }));
}

// 2. The customer didn't fix their card in time: hand the decision to the host.
async function expireCardFixes(now) {
  const expired = await Booking.find({
    "depositHold.status": "awaiting_new_card",
    "depositHold.cardFixDeadline": { $lte: now },
  });
  await eachSafely("Card-fix expiry", expired, async (b) => {
    b.depositHold.status = "awaiting_host_decision";
    await b.save();
    await notify.cardFixExpired(b);
  });
}

// 3. No claim within the claim window: release the hold (or refund a charged deposit).
async function releaseUnclaimedDeposits(now) {
  const windowEnd = new Date(now.getTime() - PAYMENTS_CONFIG.claimWindowHours * HOUR_MS);

  const holds = await Booking.find({ "depositHold.status": "held", "damageClaim.status": NO_CLAIM, checkOut: { $lte: windowEnd } });
  await eachSafely("Hold release", holds, async (b) => {
    await releaseHold(b);
    await notify.depositReleased(b);
  });

  const charged = await Booking.find({ "depositHold.status": "charged", "damageClaim.status": NO_CLAIM, checkOut: { $lte: windowEnd } });
  await eachSafely("Charged deposit refund", charged, (b) => refundChargedDeposit(b));
}

// 4. A claim is still open as the hold nears capture_before: capture the
// claimed amount now so it isn't lost, and alert admin. If the claim is later
// rejected or reduced, the admin resolution refunds the difference.
async function protectExpiringHolds(now) {
  const margin = new Date(now.getTime() + PAYMENTS_CONFIG.captureSafetyMarginHours * HOUR_MS);
  const expiring = await Booking.find({
    "depositHold.status": "held",
    "damageClaim.status": "open",
    "depositHold.captureBefore": { $lte: margin },
  });
  await eachSafely("Expiring-hold capture", expiring, async (b) => {
    try {
      await captureHold(b, b.damageClaim.amountPence);
    } catch (err) {
      if (err.message !== "HOLD_EXPIRED") throw err;
      b.depositHold.status = "failed";
      b.depositHold.failureReason = "hold_expired_with_open_claim";
      await b.save();
    }
    await notify.holdExpiringWithOpenClaim(b);
  });
}

// 5. Pay hosts once the release window after checkout has passed. The
// transfer is tied to the customer's charge (source_transaction) and the host
// gets exactly listing price minus commission.
async function payHosts(now) {
  const cutoff = new Date(now.getTime() - PAYMENTS_CONFIG.escrowReleaseHours * HOUR_MS);
  const ready = await Booking.find({
    "payment.status": "paid",
    status: { $in: ["confirmed", "completed"] },
    escrowReleased: { $ne: true },
    disputeFrozen: { $ne: true },
    checkOut: { $lte: cutoff },
  });

  await eachSafely("Host payout", ready, async (b) => {
    const p = b.payment;
    const host = await User.findById(b.host).select("stripeAccountId phoneNumber isPhoneVerified");
    if (!host?.stripeAccountId) {
      console.warn(`[Payments Scheduler] Host ${b.host} has no Stripe account -- skipping booking ${b._id}`);
      return;
    }
    if (!(p.hostAmountPence > 0)) return;

    let transfer;
    try {
      transfer = await stripe.transfers.create(
        {
          amount: p.hostAmountPence,
          currency: PAYMENTS_CONFIG.currency,
          destination: host.stripeAccountId,
          source_transaction: p.chargeId,
          transfer_group: p.transferGroup || `booking_${b._id}`,
          metadata: { bookingId: b._id.toString(), type: "host_payout" },
        },
        { idempotencyKey: `host-payout:${b._id}:v1` }
      );
    } catch (err) {
      if (makeUserHost.isStaleAccountError(err)) {
        await makeUserHost.clearStaleStripeAccount(b.host).catch(() => {});
        console.error(`[Payments Scheduler] Host ${b.host} has a stale pre-live-mode Stripe account -- cleared, needs to reconnect.`);
        return;
      }
      throw err;
    }

    p.transferId = transfer.id;
    p.transferredAt = new Date();
    p.status = "transferred";
    b.escrowReleased = true;
    b.stripeTransferId = transfer.id;
    await b.save();

    const payment = await Payment.findOne({ booking: b._id });
    if (payment) {
      await Payout.create({
        host: b.host,
        booking: b._id,
        payment: payment._id,
        amount: p.hostAmountPence / 100,
        platformFee: (p.commissionPence || 0) / 100,
        totalReceived: b.totalPrice,
        stripeTransferId: transfer.id,
        payoutMethod: "bank_account",
        status: "paid",
        releasedAt: new Date(),
      });
    }
    await notify.payoutSent(b, p.hostAmountPence);
  });
}

// 6. A booking cancelled with a partial refund (e.g. 75% back to the guest):
// the host keeps the non-refunded share. Paid on the same schedule as a normal
// payout. Cancelled bookings are skipped by payHosts, and a payout that had
// already been sent was proportionally reversed at cancellation, so this only
// covers bookings that were never paid out.
async function payRetainedCancellationShares(now) {
  const cutoff = new Date(now.getTime() - PAYMENTS_CONFIG.escrowReleaseHours * HOUR_MS);
  const ready = await Booking.find({
    status: "cancelled",
    "payment.status": "partially_refunded",
    "payment.transferId": { $exists: false },
    escrowReleased: { $ne: true },
    disputeFrozen: { $ne: true },
    checkOut: { $lte: cutoff },
  });

  await eachSafely("Cancellation payout", ready, async (b) => {
    const p = b.payment;
    const retainedPence = retainedHostSharePence(p.hostAmountPence || 0, b.refund?.percent || 0);
    if (retainedPence <= 0) return;

    const host = await User.findById(b.host).select("stripeAccountId");
    if (!host?.stripeAccountId) {
      console.warn(`[Payments Scheduler] Host ${b.host} has no Stripe account -- skipping booking ${b._id}`);
      return;
    }

    const transfer = await stripe.transfers.create(
      {
        amount: retainedPence,
        currency: PAYMENTS_CONFIG.currency,
        destination: host.stripeAccountId,
        source_transaction: p.chargeId,
        transfer_group: p.transferGroup || `booking_${b._id}`,
        metadata: { bookingId: b._id.toString(), type: "host_payout_cancellation" },
      },
      { idempotencyKey: `host-payout:${b._id}:v1` }
    );

    p.transferId = transfer.id;
    p.transferredAt = new Date();
    b.escrowReleased = true;
    b.stripeTransferId = transfer.id;
    await b.save();

    const payment = await Payment.findOne({ booking: b._id });
    if (payment) {
      await Payout.create({
        host: b.host,
        booking: b._id,
        payment: payment._id,
        amount: retainedPence / 100,
        platformFee: ((p.commissionPence || 0) - Math.round(((p.commissionPence || 0) * (b.refund?.percent || 0)) / 100)) / 100,
        totalReceived: b.totalPrice,
        stripeTransferId: transfer.id,
        payoutMethod: "bank_account",
        status: "paid",
        releasedAt: new Date(),
      });
    }
    await notify.payoutSent(b, retainedPence);
  });
}

let running = false;

async function runPaymentsSchedulerOnce() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    for (const [label, step] of [
      ["place holds", placeDueHolds],
      ["card fixes", expireCardFixes],
      ["release deposits", releaseUnclaimedDeposits],
      ["protect holds", protectExpiringHolds],
      ["host payouts", payHosts],
      ["cancellation payouts", payRetainedCancellationShares],
    ]) {
      try {
        await step(now);
      } catch (err) {
        console.error(`[Payments Scheduler] Step "${label}" error:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

function setupPaymentsScheduler() {
  // Deliberately not gated on PAYMENTS_V2: it only ever finds bookings made
  // under v2, so it's a no-op while v2 has never been on, and switching v2 off
  // later (a rollback) must not strand holds or host payouts already in flight.
  cron.schedule(`*/${PAYMENTS_CONFIG.schedulerIntervalMinutes} * * * *`, async () => {
    await runPaymentsSchedulerOnce();
  });
}

module.exports = setupPaymentsScheduler;
module.exports.runPaymentsSchedulerOnce = runPaymentsSchedulerOnce;
