// Shared unit-occupancy logic for listings with more than one identical
// bookable unit (Property.unitsCount) -- used by both routes/bookings.js
// (conflict-check + assignment on booking creation) and routes/properties.js
// (excluding fully-booked listings from search results), so the "which
// units are taken for this date range" algorithm lives in exactly one place.
const Booking = require("../models/Booking");

// [start1, end1) overlaps [start2, end2) -- same convention already used
// throughout routes/bookings.js.
const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

// A booking is saved the moment the guest clicks the button, before checkout
// ("pending" for Request to Book, "confirmed" for Instant Book). Until it's
// paid (or the card authorised) it only holds its dates for HOLD_MINUTES --
// otherwise an abandoned checkout (or the guest going Back and retrying)
// blocks those dates for everyone, forever.
const HOLD_MINUTES = 30;

// Bookings that occupy their dates right now.
function occupyingBookingFilter(now = new Date()) {
  const holdCutoff = new Date(now.getTime() - HOLD_MINUTES * 60 * 1000);
  return {
    $or: [
      {
        status: "confirmed",
        $or: [{ instantBook: { $ne: true } }, { isPaid: true }, { createdAt: { $gte: holdCutoff } }],
      },
      {
        status: "pending",
        $or: [{ isPaid: true }, { paymentAuthorizedAt: { $exists: true } }, { createdAt: { $gte: holdCutoff } }],
      },
    ],
  };
}

// True once an unpaid booking's hold has lapsed.
function holdExpired(booking, now = new Date()) {
  const unpaid =
    (booking.status === "pending" && !booking.isPaid && !booking.paymentAuthorizedAt) ||
    (booking.status === "confirmed" && booking.instantBook && !booking.isPaid);
  return Boolean(unpaid) && new Date(booking.createdAt).getTime() < now.getTime() - HOLD_MINUTES * 60 * 1000;
}

// Mongo filter for unpaid bookings (either kind), for cleanup queries.
const UNPAID_BOOKING_FILTER = {
  isPaid: { $ne: true },
  $or: [{ status: "pending", paymentAuthorizedAt: { $exists: false } }, { status: "confirmed", instantBook: true }],
};

// Returns { blockedAll, takenUnits } for a property + date range.
// blockedAll is true if a manual/external block with no specific unit
// (unitIndex null) overlaps -- that closes every unit regardless of count.
// takenUnits is the set of specific unit numbers occupied by overlapping
// pending/confirmed bookings or per-unit manual blocks.
// excludeBookingId leaves one booking out (re-checking a booking's own dates).
async function getUnitOccupancy(property, checkIn, checkOut, { excludeBookingId } = {}) {
  const takenUnits = new Set();
  let blockedAll = false;

  const overlappingBookings = await Booking.find({
    property: property._id,
    ...occupyingBookingFilter(),
    checkIn: { $lt: checkOut },
    checkOut: { $gt: checkIn },
    ...(excludeBookingId && { _id: { $ne: excludeBookingId } }),
  }).select("unitIndex");

  for (const booking of overlappingBookings) {
    // Bookings made before unitIndex existed default to unit 1 rather than
    // being silently ignored -- they're still real, occupying bookings.
    takenUnits.add(booking.unitIndex == null ? 1 : booking.unitIndex);
  }

  for (const block of property.blockedDates || []) {
    // "booked" entries mirror confirmed bookings (pushed on host approval/
    // instant-book confirm) -- already fully covered by the Booking query
    // above, which is the source of truth and also catches pending ones.
    if (block.reason === "booked") continue;
    if (!rangesOverlap(checkIn, checkOut, new Date(block.start), new Date(block.end))) continue;

    if (block.unitIndex == null) {
      blockedAll = true;
    } else {
      takenUnits.add(block.unitIndex);
    }
  }

  return { blockedAll, takenUnits };
}

function isFullyBooked(occupancy, unitsCount) {
  return occupancy.blockedAll || occupancy.takenUnits.size >= (unitsCount || 1);
}

// Lowest free unit number. Caller should check isFullyBooked first --
// returns null if none are free (shouldn't happen if that check passed).
function pickAvailableUnit(occupancy, unitsCount) {
  for (let unit = 1; unit <= (unitsCount || 1); unit += 1) {
    if (!occupancy.takenUnits.has(unit)) return unit;
  }
  return null;
}

module.exports = {
  HOLD_MINUTES,
  UNPAID_BOOKING_FILTER,
  occupyingBookingFilter,
  holdExpired,
  getUnitOccupancy,
  isFullyBooked,
  pickAvailableUnit,
  rangesOverlap,
};
