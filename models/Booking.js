const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      required: true,
    },
    guest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    // Which of the property's identical bookable units (see
    // Property.unitsCount) this booking occupies -- assigned at creation
    // time by utils/unitAvailability.js. Not to be confused with
    // totalUnits below, which counts pricing periods, not physical units.
    unitIndex: { type: Number, default: null },
    guests: { type: Number, default: 1 },
    totalPrice: { type: Number, required: true },
    totalNights: Number,
    totalHours: Number,
    // Duration type this specific booking was made under (a property can
    // have multiple pricing tiers enabled, so this isn't always the
    // property's default pricingType) and the matching unit count -- e.g.
    // pricingUnit: "week", totalUnits: 3 for a 3-week booking. This is the
    // single source of truth the UI uses to render an explicit breakdown
    // ("3 weeks × £200/week = £600") for every duration type, not just
    // daily/hourly (which totalNights/totalHours alone could already cover).
    pricingUnit: { type: String, enum: ["hour", "day", "week", "month", "year"] },
    totalUnits: Number,
    // Per-day rate breakdown for HOURLY/DAILY bookings on a listing with
    // customDayPricing active — only populated when the rate actually
    // varied across the booking (see routes/bookings.js). Lets the receipt
    // show "Fri 12 Sep — £120, Sat 13 Sep — £180" instead of a single
    // flat-rate line when the price genuinely wasn't flat.
    priceBreakdown: [
      {
        date: { type: Date, required: true },
        rate: { type: Number, required: true },
      },
    ],
    // Permanent record of the host's listing-specific terms this customer
    // agreed to at checkout (separate from VenCome's platform Terms &
    // Conditions). The exact text is snapshotted here rather than just
    // referencing the live Property.listingTerms field, since the host
    // could edit or clear their terms later and this must stay an accurate
    // record of what was actually agreed to, by whom, and when.
    listingTermsSnapshot: String,
    listingTermsAgreedAt: Date,
    status: {
      type: String,
      enum: ["pending", "confirmed", "declined", "cancelled", "completed"],
      default: "pending",
    },
    extras: [{ name: String, price: Number }],
    discountApplied: { type: Number, default: 0 },
    isPaid: { type: Boolean, default: false },
    stripeSessionId: String,
    paymentIntentId: String,
    // Set when Request to Book authorizes (but doesn't yet capture) the card.
    // Cleared implicitly once isPaid is true (captured) or the booking is
    // declined/expired (authorization released).
    paymentAuthorizedAt: Date,
    // Lets the host approve/decline straight from the "New booking request"
    // email without logging in first -- single-use (cleared after the
    // booking leaves "pending", however that happens) and time-limited.
    hostActionToken: String,
    hostActionTokenExpires: Date,
    // Google Calendar event ID on the host's connected calendar, if any —
    // lets us update/delete the pushed event on cancellation.
    googleCalendarEventId: String,
    // Same, for Outlook / Microsoft Graph.
    outlookCalendarEventId: String,
    cancelledBy: { type: String, enum: ["guest", "host"] },
    cancelledAt: Date,
    refund: {
      percent: Number,
      amount: Number,
      reason: String,
      stripeRefundId: String,
      processedAt: Date,
    },
    escrowReleaseDate: Date,
    escrowReleased: { type: Boolean, default: false },
    platformFee: { type: Number, default: 0 },
    hostAmount: { type: Number, default: 0 },
    licensePdfUrl: {
      type: String,
      default: null,
    },
    leaseUrl: {
      type: String,
      default: null,
      description: "URL to the uploaded lease agreement file in R2 storage",
    },
    leaseUploadedAt: {
      type: Date,
      default: null,
      description: "Timestamp when lease was uploaded by host",
    },
    leaseSignedAt: {
      type: Date,
      default: null,
      description: "Timestamp when guest signed the lease",
    },
    // Real e-signature capture for the lease-signing flow -- upgrades the
    // plain "signed" checkbox above into an actual drawn/typed signature
    // plus an audit trail (IP + hash of the exact document bytes signed).
    signatureType: { type: String, enum: ["drawn", "typed"] },
    signatureDataUrl: String,
    signatureTypedName: String,
    signedIp: String,
    leaseDocumentHash: String,
    stripeTransferId: String,
    disputeFrozen: { type: Boolean, default: false },
    disputeId: String,
    // Optional security deposit -- separate from rent/totalPrice above and
    // from the Stripe-chargeback "dispute" fields above (disputeId/
    // disputeFrozen). A deposit "dispute" is an internal VenCome process
    // (guest contesting a host's damage claim), not a Stripe chargeback.
    deposit: {
      amount: { type: Number, default: 0 },
      status: {
        type: String,
        enum: ["none", "charged", "refunded", "claimed", "partially_claimed"],
        default: "none",
      },
      chargedAt: Date,
      refundedAt: Date,
      claim: {
        amount: Number,
        reason: String,
        photoUrls: [String],
        filedAt: Date,
        disputeDeadline: Date,
        disputeStatus: { type: String, enum: ["none", "disputed", "resolved"], default: "none" },
        resolvedAt: Date,
        resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
    },
    reviewed: { type: Boolean, default: false },
    completed: { type: Boolean, default: false },
    review: { type: mongoose.Schema.Types.ObjectId, ref: "Review" },
    // Mirrors reviewed/review above, but for the host reviewing the guest
    // (the other direction of the two-way review system).
    hostReviewed: { type: Boolean, default: false },
    hostReview: { type: mongoose.Schema.Types.ObjectId, ref: "Review" },
  },
  { timestamps: true }
);

// ── Indexes ────────────────────────────────────────────────────────────────────
bookingSchema.index({ guest: 1, status: 1 });
bookingSchema.index({ host: 1, status: 1 });
bookingSchema.index({ property: 1, status: 1 });
bookingSchema.index({ isPaid: 1, escrowReleased: 1, status: 1 });
bookingSchema.index({ checkOut: 1 });

bookingSchema.index({ property: 1, checkIn: 1, checkOut: 1 });
bookingSchema.index({ status: 1 });
bookingSchema.index({ leaseUrl: 1 });

module.exports = mongoose.model("Booking", bookingSchema);
