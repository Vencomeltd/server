const mongoose = require("mongoose");

const propertySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    // URL-friendly identifier for /property/:slug -- generated from title at
    // creation, kept stable afterward (not regenerated on edit) so already
    // shared/indexed links never break. sparse so pre-migration documents
    // without one don't violate the unique index; utils/slugify.js backfills.
    slug: { type: String, unique: true, sparse: true, trim: true },
    description: { type: String, required: true },
    whatsIncluded: { type: String, default: "" },
    // Optional host-authored terms for this specific listing (e.g. usage
    // restrictions, deposit rules). Separate from and in addition to
    // VenCome's platform-wide Terms & Conditions -- shown as a "Read More"
    // popup on the listing page, and the customer must agree to it after
    // clicking Request to Book/Book Now before the booking is created.
    listingTerms: { type: String, default: "" },
    location: {
      address: { type: String, required: true },
      city: { type: String, required: true },
      country: { type: String, required: true },
      // Optional, host-fillable -- powers the /:subcategorySlug/:locationSlug
      // service+location landing pages. Left blank on existing listings
      // (no reliable way to infer it from address/city text), so those
      // pages start sparse until hosts fill this in.
      neighborhood: { type: String, default: "" },
    },
    coordinates: {
      latitude: Number,
      longitude: Number,
    },
    images: [{ type: String }],
    coverImage: { type: String },
    features: {
      wifi: { type: Boolean, default: false },
      restrooms: { type: Number, default: 0 },
      sizeSQM: { type: Number, default: 0 },
      seatCapacity: { type: Number, default: 0 },
      capacity: { type: Number, default: 0 },
      amenities: { type: [String], default: [] },
      houseRules: { type: String, default: "" },
      maxGuests: { type: Number, default: 0 },
      consultationArea: { type: Boolean, default: false },
      examinationCouch: { type: Boolean, default: false },
      sinkCounter: { type: Boolean, default: false },
      adjustableEnvironment: { type: Boolean, default: false },
      sharpsBin: { type: Boolean, default: false },
      naturalLight: { type: Boolean, default: false },
      dirtyTowelShoot: { type: Boolean, default: false },
      cqcCompliance: { type: Boolean, default: false },
      plug: { type: Boolean, default: false },
      sound: { type: Boolean, default: false },
      lockable: { type: Boolean, default: false },
      washbasin: { type: Boolean, default: false },
      clinicalSurface: { type: Boolean, default: false },
      wasteBin: { type: Boolean, default: false },
      meetCQCStandards: { type: Boolean, default: false },
      electricBed: { type: Boolean, default: false },
      adjustableStool: { type: Boolean, default: false },
      trolley: { type: Boolean, default: false },
      magnifyingLamp: { type: Boolean, default: false },
      storage: { type: Boolean, default: false },
      mirror: { type: Boolean, default: false },
      bathroom: { type: Number, default: 1 },
    },
    extras: [{ name: String, price: Number }],
    cqcDocuments: {
      type: [String],
      default: [],
    },
    pricing: {
      weekdayPrice: { type: Number, default: 0 },
      // Superseded by customDayPricing below — never read by any price
      // calculation (client or server). Left in place for backward
      // compatibility; not wired up to anything.
      weekendPrice: { type: Number, default: 0 },
      hourlyPrice: { type: Number, default: 0 },
      pricingType: { type: String, default: "DAILY" },
      hourly: { type: Number, default: 0 },
      daily: { type: Number, default: 0 },
      weekly: { type: Number, default: 0 },
      monthly: { type: Number, default: 0 },
      annual: { type: Number, default: 0 },
      discounts: {
        newListing: { type: Boolean, default: false },
        lastMinute: { type: Boolean, default: false },
        weekly: { type: Boolean, default: false },
        monthly: { type: Boolean, default: false },
        // Per-host percentage (0 = disabled) for HOURLY bookings longer than
        // 3 hours -- unlike the other discounts above, which are booleans at
        // a fixed platform-wide rate, hosts set their own rate for this one.
        extendedHours: { type: Number, default: 0, min: 0, max: 100 },
      },
      // Optional per-day-of-week rate overrides for HOURLY/DAILY pricing
      // only (a week/month/year-long stay spans all 7 days regardless of
      // start day, so day-of-week variance doesn't apply to those tiers).
      // day: 0=Sunday..6=Saturday (matches JS Date.getDay()). A day not
      // present here falls back to the base weekdayPrice/daily or
      // hourlyPrice/hourly rate.
      customDayPricing: {
        type: [
          {
            day: { type: Number, min: 0, max: 6, required: true },
            rate: { type: Number, min: 0, required: true },
          },
        ],
        default: [],
      },
      // Graduated/stepped WEEKLY pricing -- e.g. £80/week for the first 8
      // weeks, then £100/week after. Only applies to WEEKLY bookings (a
      // host's most common ask); the base `weekly` rate above still covers
      // weeks up to thresholdWeeks.
      graduatedWeekly: {
        enabled: { type: Boolean, default: false },
        thresholdWeeks: { type: Number, min: 0, default: 0 },
        rateAfterThreshold: { type: Number, min: 0, default: 0 },
      },
    },
    // Optional per-listing security deposit -- charged alongside rent at
    // checkout, held in the host's wallet (see HostWallet/WalletTransaction),
    // separate from rent/pricing above.
    deposit: {
      enabled: { type: Boolean, default: false },
      amount: { type: Number, min: 0, default: 0 },
    },
    bookingSettings: {
      approveFirstFive: { type: Boolean, default: true },
      instantBook: { type: Boolean, default: false },
      approveAllBookings: { type: Boolean, default: false },
      refundPolicy: {
        type: String,
        enum: ["flexible", "moderate", "strict", "non-refundable"],
        default: "moderate",
      },
      // Buffer time (minutes) blocked before/after each booking so hosts get
      // clean-up/prep time. Surfaced in EditSpace.jsx and PropertyAvailability.jsx.
      bufferBefore: { type: Number, default: 0 },
      bufferAfter: { type: Number, default: 0 },
      // DAILY-pricing listings only: restricts a booking to exactly one
      // calendar day, like a one-way flight, instead of allowing a
      // multi-night stay. Off by default so existing listings keep their
      // current multi-night behavior.
      singleDayOnly: { type: Boolean, default: false },
    },
    firstFiveApproved: { type: Number, default: 0 },
    // Homepage display order, set by admin drag-reorder. Lower sorts first;
    // 0 for every listing until an admin reorders them, so the default
    // newest-first sort (createdAt) still applies as a tiebreaker.
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category" },
    subcategory: { type: String, default: "" },
    categories: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
    subcategories: [{ type: String }],
    rating: { type: Number, default: 0 },
    reviewNumber: { type: Number, default: 0 },
    reviews: [{ type: mongoose.Schema.Types.ObjectId, ref: "Review" }],
    refundPolicy: {
      type: String,
      enum: ["flexible", "moderate", "strict", "non-refundable"],
      default: "moderate",
    },
    availability: {
      openDays: {
        type: [String],
        enum: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        default: [],
      },
      openTime: { type: String, default: "" },
      closeTime: { type: String, default: "" },
      minNotice: { type: String, default: "" },
      instantBook: { type: Boolean, default: false },
      maxAdvance: { type: String, default: "" },
      weekendAvailable: { type: Boolean, default: true },
      sameDayCutoff: { type: String, default: "" },
      // openTime/closeTime above apply to every open day when hoursMode is
      // "same" (the default, unchanged behavior). "custom" opts into
      // per-day hours in dayHours instead -- open days not listed there
      // fall back to openTime/closeTime.
      is24Hours: { type: Boolean, default: false },
      hoursMode: { type: String, enum: ["same", "custom"], default: "same" },
      dayHours: [
        {
          day: {
            type: String,
            enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
          },
          openTime: String,
          closeTime: String,
          is24Hours: { type: Boolean, default: false },
        },
      ],
    },
    customAvailability: {
      days: [
        {
          type: String,
          enum: [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ],
        },
      ],
      startTime: String,
      endTime: String,
      minBookingHours: { type: Number, default: 2 },
    },
    // Number of identical bookable units this listing represents (e.g. 5
    // identical chairs listed as one page) -- default 1 preserves today's
    // single-unit behavior exactly for every existing listing.
    unitsCount: { type: Number, default: 1, min: 1 },
    blockedDates: [
      {
        start: { type: Date, required: true },
        end: { type: Date, required: true },
        reason: {
          type: String,
          enum: ["booked", "maintenance", "personal", "external"],
        },
        bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
        externalEventId: String,
        // null/unset = blocks all units (today's behavior, and the default
        // for every pre-existing entry); a number 1..unitsCount = blocks
        // only that specific unit. Guest bookings always get a real,
        // specific value here; only host-created manual blocks and
        // synced-external blocks can be "all".
        unitIndex: { type: Number, default: null },
      },
    ],
    icalUrl: String,
    icalLastSyncedAt: Date,
    icalLastSyncError: String,
    leaseAgreement: {
      type: String,
      default: null,
    },
    // Optional single video tour of the space, shown alongside the photo
    // gallery. Client-requested (Aug 24 WhatsApp) -- never actually built
    // despite an earlier "yes we can" reply.
    video: {
      type: String,
      default: null,
    },
    // Optional host-written terms specific to this listing (e.g. equipment
    // handling, cancellation nuances, access rules). Separate from and in
    // addition to VenCome's platform-wide Terms & Conditions -- shown as a
    // "Read More" preview on the listing page, and gated behind a checkbox
    // at checkout (see Booking.listingTermsSnapshot for the agreement record).
    listingTerms: { type: String, default: "" },
  },
  { timestamps: true }
);

// ── Indexes ────────────────────────────────────────────────────────────────────
propertySchema.index({ host: 1 });
propertySchema.index({ category: 1 });
propertySchema.index({ isActive: 1 });
propertySchema.index({ "location.city": 1 });
propertySchema.index({ "location.country": 1 });
propertySchema.index({ "coordinates.latitude": 1, "coordinates.longitude": 1 });
propertySchema.index({ rating: -1 });
propertySchema.index({ createdAt: -1 });

module.exports = mongoose.model("Property", propertySchema);
