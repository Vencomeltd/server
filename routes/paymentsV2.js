// Payments v2 booking routes (spec Phases 2, 4 and 5), mounted under
// /api/bookings. Everything here is inert unless PAYMENTS_V2=true.
const express = require("express");
const { body, param, validationResult } = require("express-validator");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const auth = require("../middleware/auth");
const { blockDuringImpersonation } = require("../middleware/auth");
const Booking = require("../models/Booking");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const { PAYMENTS_CONFIG, isPaymentsV2Enabled } = require("../config/payments");
const { HOUR_MS, computeBookingAmounts, planDeposit, leadHours } = require("../utils/paymentsV2/amounts");
const { getOrCreateCustomer, placeDeposit } = require("../utils/paymentsV2/depositHold");
const { cancelFromHostDecision } = require("../utils/paymentsV2/cancel");
const notify = require("../utils/paymentsV2/notify");

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

const bookingIdParam = param("bookingId").isMongoId().withMessage("Invalid booking id");

const publicDeposit = (dh = {}) => ({
  mode: dh.mode,
  amountPence: dh.amountPence,
  status: dh.status,
  holdAt: dh.holdAt,
  cardBrand: dh.cardBrand,
  cardFixDeadline: dh.cardFixDeadline,
  failureReason: dh.failureReason,
});

// ── Phase 2: create the booking's PaymentIntent ─────────────────────────────
// Separate charges and transfers: the platform takes the whole payment, and
// the host's share is transferred later (utils/paymentsV2/scheduler.js). No
// transfer_data / application_fee_amount / on_behalf_of.
router.post("/:bookingId/payment-intent", auth, [bookingIdParam], validate, async (req, res) => {
  if (!isPaymentsV2Enabled()) return res.json({ enabled: false });

  try {
    const booking = await Booking.findOne({ _id: req.params.bookingId, guest: req.user.id }).populate(
      "property",
      "title depositPolicy"
    );
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.isPaid) return res.status(400).json({ error: "Booking already paid" });
    if (["cancelled", "declined", "completed"].includes(booking.status)) {
      return res.status(400).json({ error: `Booking is ${booking.status}` });
    }

    const amounts = computeBookingAmounts(booking);
    if (amounts.amountPence < 30) return res.status(400).json({ error: "This booking total is below the minimum card payment." });

    const policy = booking.property?.depositPolicy;
    const plan = planDeposit({
      policy,
      brand: undefined, // card not chosen yet -- the default (Visa) rule is shown, then re-run after payment
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      listingPricePence: amounts.listingPricePence,
    });
    const depositSummary = {
      mode: plan.mode,
      amountPence: plan.mode === "none" ? 0 : policy.amountPence,
      reason: plan.reason,
      holdLeadHours: leadHours("visa"),
      holdLeadHoursMax: Math.max(...Object.values(PAYMENTS_CONFIG.holdLeadHours)),
    };

    // Reuse an unfinished payment intent instead of creating a second one.
    const existingId = booking.payment?.paymentIntentId;
    if (existingId) {
      const existing = await stripe.paymentIntents.retrieve(existingId);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(existing.status)) {
        return res.json({ enabled: true, clientSecret: existing.client_secret, amountPence: existing.amount, deposit: depositSummary });
      }
      return res.status(400).json({ error: "This booking already has a payment in progress." });
    }

    const guest = await User.findById(req.user.id);
    const customerId = await getOrCreateCustomer(guest);
    const saveCard = Boolean(policy && policy.mode !== "none" && policy.amountPence > 0);

    const pi = await stripe.paymentIntents.create(
      {
        amount: amounts.amountPence,
        currency: PAYMENTS_CONFIG.currency,
        customer: customerId,
        // Request to Book only authorises the card; it's captured on host approval.
        capture_method: booking.status === "pending" ? "manual" : "automatic",
        // Saves the card so the deposit can be held/charged later.
        ...(saveCard && { setup_future_usage: "off_session" }),
        transfer_group: `booking_${booking._id}`,
        description: `Booking ${booking._id} — ${booking.property?.title || "VenCome space"}`,
        metadata: { bookingId: booking._id.toString(), type: "booking" },
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      },
      { idempotencyKey: `booking-pi:${booking._id}:v1` }
    );

    booking.paymentIntentId = pi.id;
    booking.payment.paymentIntentId = pi.id;
    booking.payment.amountPence = amounts.amountPence;
    booking.payment.listingPricePence = amounts.listingPricePence;
    booking.payment.commissionPence = amounts.commissionPence;
    booking.payment.hostAmountPence = amounts.hostAmountPence;
    booking.payment.transferGroup = `booking_${booking._id}`;
    booking.payment.status = "pending";
    await booking.save();

    res.json({ enabled: true, clientSecret: pi.client_secret, amountPence: amounts.amountPence, deposit: depositSummary });
  } catch (err) {
    console.error("Create payment intent error:", err);
    res.status(500).json({ error: "Could not start payment" });
  }
});

// ── Phase 4a: the guest replaces a card that failed the deposit hold ────────
// Two steps: no body -> a SetupIntent to confirm on the client; then
// { setupIntentId } once confirmed -> the hold is placed with the new card.
router.post(
  "/:bookingId/deposit/update-card",
  auth,
  blockDuringImpersonation,
  [bookingIdParam, body("setupIntentId").optional().isString().trim().notEmpty()],
  validate,
  async (req, res) => {
    if (!isPaymentsV2Enabled()) return res.status(404).json({ error: "Not available" });

    try {
      const booking = await Booking.findOne({ _id: req.params.bookingId, guest: req.user.id }).populate("property", "depositPolicy");
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      const dh = booking.depositHold;
      if (dh.status !== "awaiting_new_card") {
        return res.status(400).json({ error: "This booking isn't waiting for a new card." });
      }

      const guest = await User.findById(req.user.id);
      const customerId = await getOrCreateCustomer(guest);

      if (!req.body.setupIntentId) {
        const si = await stripe.setupIntents.create(
          {
            customer: customerId,
            usage: "off_session",
            payment_method_types: ["card"],
            metadata: { bookingId: booking._id.toString(), type: "deposit_card_update" },
          },
          { idempotencyKey: `update-card-si:${booking._id}:v${dh.attempt || 0}` }
        );
        return res.json({ clientSecret: si.client_secret });
      }

      const si = await stripe.setupIntents.retrieve(req.body.setupIntentId);
      if (si.metadata?.bookingId !== booking._id.toString() || si.customer !== customerId || si.status !== "succeeded") {
        return res.status(400).json({ error: "That card could not be verified. Please try again." });
      }
      const pm = await stripe.paymentMethods.retrieve(si.payment_method);

      dh.paymentMethodId = pm.id;
      dh.cardBrand = pm.card?.brand;
      dh.failureReason = undefined;
      dh.cardFixDeadline = undefined;

      // Re-run the coverage check: the new card's brand changes the hold rules.
      const plan = planDeposit({
        policy: { mode: dh.mode, amountPence: dh.amountPence, longStayFallback: booking.property?.depositPolicy?.longStayFallback },
        brand: dh.cardBrand,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        listingPricePence: booking.payment.listingPricePence,
      });

      if (plan.status === "not_required") {
        dh.mode = "none";
        dh.status = "not_required";
        await booking.save();
        return res.json({ deposit: publicDeposit(dh) });
      }

      dh.mode = plan.mode;
      dh.status = "scheduled";
      dh.holdAt = plan.holdAt || undefined;
      await booking.save();

      // Customer is present now, so place it straight away when it's due.
      if (plan.status === "place_now" || plan.status === "charged_now") {
        await placeDeposit(booking, { onSession: true });
      }
      res.json({ deposit: publicDeposit(booking.depositHold) });
    } catch (err) {
      console.error("Update deposit card error:", err);
      res.status(500).json({ error: "Could not update your card" });
    }
  }
);

// ── Phase 4b: the host decides after the card-fix window lapses ─────────────
router.post(
  "/:bookingId/deposit/host-decision",
  auth,
  blockDuringImpersonation,
  [bookingIdParam, body("decision").isIn(["proceed_without_deposit", "cancel"]).withMessage("Invalid decision")],
  validate,
  async (req, res) => {
    if (!isPaymentsV2Enabled()) return res.status(404).json({ error: "Not available" });

    try {
      const booking = await Booking.findOne({ _id: req.params.bookingId, host: req.user.id });
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.depositHold.status !== "awaiting_host_decision") {
        return res.status(400).json({ error: "This booking isn't waiting for your decision." });
      }

      const { decision } = req.body;
      booking.depositHold.hostDecision = decision;

      if (decision === "proceed_without_deposit") {
        booking.depositHold.status = "waived";
        await booking.save();
        return res.json({ deposit: publicDeposit(booking.depositHold) });
      }

      await cancelFromHostDecision(booking);
      const guest = await User.findById(booking.guest).select("email firstName displayName");
      if (guest?.email) {
        sendEmail({
          to: guest.email,
          subject: "Your booking was cancelled",
          html: `<p>Hi ${guest.displayName || guest.firstName || "there"}, your booking was cancelled because the deposit couldn't be secured. Any refund due has been issued to your card.</p>`,
        }).catch((err) => console.error("[Payments v2] Cancellation email failed:", err.message));
      }
      res.json({ deposit: publicDeposit(booking.depositHold), status: booking.status });
    } catch (err) {
      console.error("Host deposit decision error:", err);
      res.status(500).json({ error: "Could not record your decision" });
    }
  }
);

// ── Phase 5: the host opens a damage claim ──────────────────────────────────
router.post(
  "/:bookingId/claims",
  auth,
  blockDuringImpersonation,
  [
    bookingIdParam,
    body("amountPence").isInt({ min: 1 }).withMessage("Enter the amount you are claiming").toInt(),
    body("reason").isString().trim().isLength({ min: 5, max: 2000 }).withMessage("Please describe the damage"),
    body("evidenceUrls").isArray({ min: 1, max: 10 }).withMessage("Add at least one photo as evidence"),
    body("evidenceUrls.*").isURL({ protocols: ["https"], require_protocol: true }).withMessage("Invalid evidence link"),
  ],
  validate,
  async (req, res) => {
    if (!isPaymentsV2Enabled()) return res.status(404).json({ error: "Not available" });

    try {
      const booking = await Booking.findOne({ _id: req.params.bookingId, host: req.user.id });
      if (!booking) return res.status(404).json({ error: "Booking not found" });

      const dh = booking.depositHold;
      if (!["held", "charged"].includes(dh.status)) {
        return res.status(400).json({ error: "There is no active deposit to claim against." });
      }
      if (booking.damageClaim.status && booking.damageClaim.status !== "none") {
        return res.status(400).json({ error: "A claim has already been opened for this booking." });
      }

      const now = Date.now();
      const checkOutMs = new Date(booking.checkOut).getTime();
      const windowEndMs = checkOutMs + PAYMENTS_CONFIG.claimWindowHours * HOUR_MS;
      if (now < checkOutMs || now > windowEndMs) {
        return res.status(400).json({ error: `Claims can only be opened in the ${PAYMENTS_CONFIG.claimWindowHours} hours after checkout.` });
      }

      const { amountPence, reason, evidenceUrls } = req.body;
      if (amountPence > dh.amountPence) {
        return res.status(400).json({ error: `The claim can't be more than the deposit (£${(dh.amountPence / 100).toFixed(2)}).` });
      }

      booking.damageClaim.status = "open";
      booking.damageClaim.amountPence = amountPence;
      booking.damageClaim.reason = reason;
      booking.damageClaim.evidenceUrls = evidenceUrls;
      booking.damageClaim.openedAt = new Date();
      await booking.save();

      await notify.claimOpened(booking);
      res.status(201).json({ claim: booking.damageClaim });
    } catch (err) {
      console.error("Open damage claim error:", err);
      res.status(500).json({ error: "Could not open the claim" });
    }
  }
);

module.exports = router;
