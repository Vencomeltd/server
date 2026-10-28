// Payments v2 webhook handling: a booking payment being authorised/paid,
// deposit scheduling once the card is known, and the bookkeeping events
// (refunds, reversed transfers, deposit payment state changes). Every handler
// is safe to run twice -- Stripe re-delivers events.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Booking = require("../../models/Booking");
const Payment = require("../../models/Payment");
const User = require("../../models/User");
const sendEmail = require("../sendEmail");
const { sendBookingCreatedNotifications } = require("../bookingNotifications");
const { PAYMENTS_CONFIG } = require("../../config/payments");
const { planDeposit, planSeriesDeposit, computeBookingAmounts, HOUR_MS } = require("./amounts");
const { placeDeposit, markAwaitingNewCard } = require("./depositHold");
const { ensureBookingStillHeld, releaseLostBookingPayment, cancelUnpaidBookings } = require("../bookingHold");

const loadBooking = (bookingId) =>
  Booking.findById(bookingId).populate("property", "title host location depositPolicy");

// Records the plan for the deposit once we know the card brand.
async function scheduleDepositAfterPayment(booking, charge) {
  if (booking.depositHold?.status) return null; // already planned

  const policy = booking.property?.depositPolicy;
  const brand = charge.payment_method_details?.card?.brand;
  if (booking.groupId) return scheduleSeriesDeposit(booking, policy, charge, brand);
  const plan = planDeposit({
    policy,
    brand,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    now: new Date(),
    listingPricePence: booking.payment.listingPricePence,
  });

  const dh = booking.depositHold;
  dh.mode = plan.mode;
  dh.amountPence = plan.mode === "none" ? 0 : policy.amountPence;
  dh.paymentMethodId = typeof charge.payment_method === "string" ? charge.payment_method : undefined;
  dh.cardBrand = brand;
  dh.attempt = 0;
  dh.status = plan.status === "not_required" ? "not_required" : "scheduled";
  dh.holdAt = plan.holdAt || undefined;
  await booking.save();
  return plan;
}

// One deposit for a whole series: charged on its first booking and kept until
// the last date's checkout (coversUntil); the other dates carry none.
async function scheduleSeriesDeposit(booking, policy, charge, brand) {
  const series = await Booking.find({ groupId: booking.groupId }).sort({ checkIn: 1 }).select("_id checkOut");
  const isFirst = String(series[0]?._id) === String(booking._id);
  const plan = isFirst ? planSeriesDeposit(policy) : { mode: "none", status: "not_required" };

  const dh = booking.depositHold;
  dh.mode = plan.mode;
  dh.amountPence = plan.mode === "none" ? 0 : policy.amountPence;
  dh.paymentMethodId = typeof charge.payment_method === "string" ? charge.payment_method : undefined;
  dh.cardBrand = brand;
  dh.attempt = 0;
  dh.status = plan.status === "not_required" ? "not_required" : "scheduled";
  if (plan.mode !== "none") dh.coversUntil = series[series.length - 1].checkOut;
  await booking.save();
  return plan;
}

// Request to Book: the card is authorised (manual capture) but not charged
// until the host approves. `series` (called from onSeriesPayment): the series
// was already checked as a whole and is notified once, so skip both here.
async function onBookingAuthorized(pi, io, { series = false } = {}) {
  const booking = await loadBooking(pi.metadata.bookingId);
  if (!booking || booking.paymentAuthorizedAt || booking.isPaid) return;
  if (!series && !(await ensureBookingStillHeld(booking))) return releaseLostBookingPayment(booking, pi.id);

  booking.paymentAuthorizedAt = new Date();
  booking.payment.paymentIntentId = pi.id;
  await booking.save();

  if (!(await Payment.findOne({ booking: booking._id }))) {
    await Payment.create({
      booking: booking._id,
      guest: booking.guest,
      host: booking.property.host,
      amount: booking.totalPrice,
      platformFee: booking.platformFee,
      hostAmount: booking.hostAmount,
      provider: "stripe",
      providerPaymentId: pi.id,
      status: "authorized",
    });
  }

  if (series) return;
  const [guest, host] = await Promise.all([User.findById(booking.guest), User.findById(booking.property.host)]);
  await sendBookingCreatedNotifications(booking, booking.property, guest, host, io);
  io?.to(`user_${booking.guest}`).emit("paymentSuccess", { bookingId: booking._id.toString() });
}

// The booking payment has been captured (Instant Book at checkout, or Request
// to Book once the host approves). `series`: see onBookingAuthorized.
async function onBookingPaid(pi, io, { series = false } = {}) {
  const booking = await loadBooking(pi.metadata.bookingId);
  if (!booking) return;

  const firstTimePaid = !booking.isPaid;
  // Instant Book pays here directly; Request to Book was checked at authorisation.
  if (!series && firstTimePaid && !booking.paymentAuthorizedAt && !(await ensureBookingStillHeld(booking))) {
    return releaseLostBookingPayment(booking, pi.id);
  }
  const charge = await stripe.charges.retrieve(pi.latest_charge);

  let stripeFeePence;
  if (charge.balance_transaction) {
    const btId = typeof charge.balance_transaction === "string" ? charge.balance_transaction : charge.balance_transaction.id;
    stripeFeePence = (await stripe.balanceTransactions.retrieve(btId)).fee;
  }

  const amounts = computeBookingAmounts(booking);
  const p = booking.payment;
  p.paymentIntentId = pi.id;
  p.chargeId = charge.id;
  p.stripeFeePence = stripeFeePence;
  p.transferGroup = `booking_${booking._id}`;
  p.amountPence = p.amountPence || amounts.amountPence;
  p.listingPricePence = p.listingPricePence || amounts.listingPricePence;
  p.commissionPence = p.commissionPence ?? amounts.commissionPence;
  p.hostAmountPence = p.hostAmountPence ?? amounts.hostAmountPence;
  if (!p.status || p.status === "pending") p.status = "paid";

  const releaseDate = new Date(new Date(booking.checkOut).getTime() + PAYMENTS_CONFIG.escrowReleaseHours * HOUR_MS);
  if (!booking.isPaid) {
    booking.isPaid = true;
    booking.escrowReleaseDate = releaseDate;
  }
  await booking.save();

  const existing = await Payment.findOne({ booking: booking._id });
  if (!existing) {
    await Payment.create({
      booking: booking._id,
      guest: booking.guest,
      host: booking.property.host,
      amount: booking.totalPrice,
      platformFee: booking.platformFee,
      hostAmount: booking.hostAmount,
      provider: "stripe",
      providerPaymentId: pi.id,
      status: "paid",
      escrowReleaseAt: releaseDate,
    });
  } else if (existing.status !== "paid") {
    existing.status = "paid";
    existing.escrowReleaseAt = releaseDate;
    await existing.save();
  }

  const plan = await scheduleDepositAfterPayment(booking, charge);

  if (firstTimePaid && !series) {
    const [guest, host] = await Promise.all([User.findById(booking.guest), User.findById(booking.property.host)]);
    // Request to Book already notified at authorisation; only Instant Book is new here.
    if (!booking.paymentAuthorizedAt) {
      await sendBookingCreatedNotifications(booking, booking.property, guest, host, io);
    }
    io?.to(`user_${booking.guest}`).emit("paymentSuccess", { bookingId: booking._id.toString() });
    if (guest?.email) {
      sendEmail({
        to: guest.email,
        subject: "Your payment is confirmed 🎉",
        html: `<p>Hi ${guest.displayName || guest.firstName || "there"}, your payment of <strong>£${booking.totalPrice}</strong> for <strong>${booking.property.title}</strong> has been received. View or manage it from your VenCome dashboard.</p>`,
      }).catch((err) => console.error("[Payments v2] Payment confirmation email failed:", err.message));
    }
  }

  // Customer is present (booking made inside the hold lead time, or a charged
  // deposit): place it now instead of waiting for the scheduler.
  if (plan && (plan.status === "place_now" || plan.status === "charged_now")) {
    await placeDeposit(booking, { onSession: true }).catch((err) =>
      console.error(`[Payments v2] Immediate deposit placement failed for booking ${booking._id} (scheduler will retry):`, err.message)
    );
  }
}

// A series' shared PaymentIntent was authorised or paid: apply it to every
// booking in the series, then notify guest and host once with all the dates.
async function onSeriesPayment(pi, io, kind) {
  const { groupId } = pi.metadata;
  const bookings = await loadSeries(groupId);
  if (!bookings.length) return;

  // First payment for the series (not the capture on host approval): if any
  // date was cancelled or lost while the guest was paying, the whole series
  // is cancelled and the money released or refunded.
  const firstPayment = bookings.every((b) => !b.isPaid && !b.paymentAuthorizedAt);
  if (firstPayment) {
    for (const booking of bookings) {
      if (!(await ensureBookingStillHeld(booking))) {
        await cancelUnpaidBookings({ groupId });
        return releaseLostBookingPayment(booking, pi.id);
      }
    }
  }

  const apply = kind === "paid" ? onBookingPaid : onBookingAuthorized;
  for (const booking of bookings) {
    await apply({ ...pi, metadata: { ...pi.metadata, bookingId: booking._id.toString() } }, io, { series: true });
  }
  if (!firstPayment) return; // host approval: applyDecision already emailed the guest

  const series = await loadSeries(groupId);
  const [guest, host] = await Promise.all([User.findById(series[0].guest), User.findById(series[0].property.host)]);
  await sendBookingCreatedNotifications(series[0], series[0].property, guest, host, io, series);
  io?.to(`user_${series[0].guest}`).emit("paymentSuccess", { bookingId: series[0]._id.toString(), groupId });
}

const loadSeries = (groupId) =>
  Booking.find({ groupId }).sort({ checkIn: 1 }).populate("property", "title host location depositPolicy");

async function findByDepositPI(pi) {
  return Booking.findOne({ _id: pi.metadata.bookingId, "depositHold.paymentIntentId": pi.id });
}

async function onDepositCanceled(pi) {
  const booking = await findByDepositPI(pi);
  // A hold we still consider active was cancelled on Stripe's side (e.g. it expired).
  if (booking && booking.depositHold.status === "held") {
    booking.depositHold.status = "released";
    await booking.save();
  }
}

async function onDepositChargeSucceeded(pi) {
  const booking = await Booking.findById(pi.metadata.bookingId);
  if (booking?.depositHold && booking.depositHold.status !== "charged" && booking.depositHold.mode === "charged") {
    booking.depositHold.paymentIntentId = pi.id;
    booking.depositHold.capturedPence = pi.amount_received;
    booking.depositHold.status = "charged";
    await booking.save();
  }
}

async function onDepositPaymentFailed(pi) {
  const booking = await Booking.findById(pi.metadata.bookingId);
  if (booking?.depositHold?.status === "scheduled") {
    await markAwaitingNewCard(booking, pi.last_payment_error?.code || "payment_failed");
  }
}

async function onChargeRefunded(charge) {
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) return;
  const booking = await Booking.findOne({ "payment.paymentIntentId": paymentIntentId });
  // A series shares one charge, so its total says nothing about one date --
  // refundBookingPayment already set that booking's own status.
  if (!booking || booking.groupId || !charge.amount_refunded) return;
  booking.payment.status = charge.amount_refunded >= charge.amount ? "refunded" : "partially_refunded";
  await booking.save();
}

async function onTransferReversed(transfer) {
  const booking = await Booking.findOne({ "payment.transferId": transfer.id });
  if (!booking || booking.payment.transferReversedAt) return;
  booking.payment.transferReversedAt = new Date();
  await booking.save();
}

// Routes a Stripe event to the right v2 handler. Returns true if it was a v2
// event (so the caller can skip the legacy handlers), false otherwise.
async function handleEvent(event, io) {
  const obj = event.data.object;

  if (event.type === "charge.refunded") {
    await onChargeRefunded(obj);
    return false; // legacy code ignores it, but other listeners may care
  }
  if (event.type === "transfer.reversed") {
    await onTransferReversed(obj);
    return true;
  }

  const type = obj.metadata?.type;
  if (!event.type.startsWith("payment_intent.") || !type || !obj.metadata?.bookingId) return false;

  switch (`${event.type}:${type}`) {
    case "payment_intent.succeeded:booking":
      await onBookingPaid(obj, io);
      return true;
    case "payment_intent.amount_capturable_updated:booking":
      await onBookingAuthorized(obj, io);
      return true;
    case "payment_intent.succeeded:deposit_charged":
      await onDepositChargeSucceeded(obj);
      return true;
    case "payment_intent.canceled:deposit_hold":
      await onDepositCanceled(obj);
      return true;
    case "payment_intent.payment_failed:deposit_hold":
    case "payment_intent.payment_failed:deposit_charged":
      await onDepositPaymentFailed(obj);
      return true;
    case "payment_intent.succeeded:booking_group":
      await onSeriesPayment(obj, io, "paid");
      return true;
    case "payment_intent.amount_capturable_updated:booking_group":
      await onSeriesPayment(obj, io, "authorized");
      return true;
    case "payment_intent.payment_failed:booking_group":
    case "payment_intent.payment_failed:booking":
      console.warn(`[Payments v2] Booking payment failed for ${obj.metadata.bookingId}:`, obj.last_payment_error?.message);
      return true;
    default:
      return true; // a v2 payment event we deliberately don't act on
  }
}

module.exports = { handleEvent, onBookingPaid, onBookingAuthorized, scheduleDepositAfterPayment };
