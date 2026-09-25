// Pure money/time calculations for the payments v2 flow (no I/O, no Stripe).
// All money is integer pence. See docs/specs/payments-deposits.md.
const { PAYMENTS_CONFIG } = require("../../config/payments");

const HOUR_MS = 60 * 60 * 1000;

const toPence = (pounds) => Math.round(Number(pounds || 0) * 100);

// The booking's commission is decided once at booking time
// (routes/bookings.js, utils/commission.js) and is authoritative, so it is
// converted here rather than recalculated. The host amount is always based on
// the listing price, never on what's left after Stripe fees.
function computeBookingAmounts(booking, config = PAYMENTS_CONFIG) {
  const listingPricePence = toPence(booking.totalPrice);
  const commissionPence = toPence(booking.platformFee);
  const hostAmountPence = listingPricePence - commissionPence;
  const serviceFeePence = Math.round((listingPricePence * config.serviceFeePercent) / 100);
  return {
    listingPricePence,
    commissionPence,
    hostAmountPence,
    serviceFeePence,
    amountPence: listingPricePence + serviceFeePence,
  };
}

function normaliseBrand(brand) {
  return String(brand || "").toLowerCase();
}

function leadHours(brand, config = PAYMENTS_CONFIG) {
  return config.holdLeadHours[normaliseBrand(brand)] ?? config.holdLeadHours.default;
}

// How long a card hold stays valid: 7 days when the customer is present, and
// for merchant-initiated (off-session) holds 4 days 18 hours on Visa, 7 days
// on everything else.
function holdWindowHours(brand, onSession) {
  if (onSession) return 7 * 24;
  if (normaliseBrand(brand) === "visa") return 4 * 24 + 18;
  return 7 * 24;
}

// Decides which deposit applies to a booking.
// policy: { mode, amountPence, longStayFallback } (the listing's depositPolicy)
// Returns { mode, status, holdAt, onSession, fallbackApplied, reason } where
// status is one of:
//   not_required  - no deposit for this booking
//   scheduled     - card hold to be placed off-session at holdAt
//   place_now     - card hold to be placed right after payment (customer present)
//   charged_now   - deposit is charged right after payment as its own payment
function planDeposit({ policy, brand, checkIn, checkOut, now = new Date(), listingPricePence, config = PAYMENTS_CONFIG }) {
  const none = (reason, fallbackApplied = false) => ({
    mode: "none",
    status: "not_required",
    holdAt: null,
    onSession: false,
    fallbackApplied,
    reason,
  });

  if (!policy || policy.mode === "none" || !(policy.amountPence > 0)) return none("No deposit set on this listing");

  const overChargedMin = listingPricePence > config.chargedDepositMinPence;

  if (policy.mode === "charged") {
    if (!overChargedMin) return none("Charged deposits only apply to bookings over £200");
    return { mode: "charged", status: "charged_now", holdAt: null, onSession: true, fallbackApplied: false, reason: "Deposit charged at booking" };
  }

  // card_hold
  const checkInMs = new Date(checkIn).getTime();
  const checkOutMs = new Date(checkOut).getTime();
  const nowMs = new Date(now).getTime();

  const holdAtMs = checkInMs - leadHours(brand, config) * HOUR_MS;
  const onSession = nowMs >= holdAtMs;
  const effectiveHoldAtMs = onSession ? nowMs : holdAtMs;
  const needUntilMs = checkOutMs + (config.claimWindowHours + config.captureSafetyMarginHours) * HOUR_MS;
  // Every hold is placed as a saved-card (off-session) charge -- see
  // depositHold.placeDeposit -- so it only lasts the off-session window, even
  // when it's placed straight away at booking.
  const covered = effectiveHoldAtMs + holdWindowHours(brand, false) * HOUR_MS >= needUntilMs;

  if (covered) {
    return {
      mode: "card_hold",
      status: onSession ? "place_now" : "scheduled",
      holdAt: new Date(effectiveHoldAtMs),
      onSession,
      fallbackApplied: false,
      reason: onSession ? "Card hold placed at booking" : "Card hold scheduled before check-in",
    };
  }

  // Stay is too long for a card hold to cover -- apply the listing's fallback.
  if (policy.longStayFallback === "charged" && overChargedMin) {
    return { mode: "charged", status: "charged_now", holdAt: null, onSession: true, fallbackApplied: true, reason: "Stay too long for a card hold — deposit charged instead" };
  }
  return none("Stay too long for a card hold — no deposit taken", true);
}

// Cleans a listing's depositPolicy from a request body: a valid mode, an
// integer pence amount, and no deposit at all if the amount is zero.
function normaliseDepositPolicy(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const mode = ["card_hold", "charged"].includes(input.mode) ? input.mode : "none";
  const amountPence = mode === "none" ? 0 : Math.max(0, Math.round(Number(input.amountPence) || 0));
  return {
    mode: amountPence > 0 ? mode : "none",
    amountPence,
    longStayFallback: input.longStayFallback === "charged" ? "charged" : "none",
  };
}

// After a partial-refund cancellation the host keeps the non-refunded share of
// their amount (e.g. a 75% refund leaves the host 25% of their share).
function retainedHostSharePence(hostAmountPence, refundPercent) {
  const refunded = Math.round((hostAmountPence * refundPercent) / 100);
  return Math.max(0, hostAmountPence - refunded);
}

// Refund tier for a cancellation, read from config (never hardcoded).
function getRefundTier(hoursUntilCheckIn, config = PAYMENTS_CONFIG) {
  return config.cancellationTiers.find((t) => (t.exclusive ? hoursUntilCheckIn > t.minHours : hoursUntilCheckIn >= t.minHours));
}

module.exports = {
  HOUR_MS,
  toPence,
  computeBookingAmounts,
  leadHours,
  holdWindowHours,
  planDeposit,
  normaliseDepositPolicy,
  retainedHostSharePence,
  getRefundTier,
};
