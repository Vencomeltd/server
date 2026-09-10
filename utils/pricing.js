// utils/pricing.js

// Historical draft, never wired up anywhere -- its signature doesn't match
// either the real Property or Booking schema (booking.startTime/endTime/
// minHours don't exist on the real Booking model). Left in place as
// history; nothing calls this. See calculateDailyPriceWithBreakdown /
// calculateHourlyPriceWithBreakdown below for the real, live calculation.
module.exports.calculatePrice = function (property, booking) {
  const { pricing } = property;

  if (pricing.pricingType === "HOURLY") {
    const hours =
      (new Date(booking.endTime) - new Date(booking.startTime)) / 36e5;

    if (hours < pricing.minHours) {
      throw new Error("Minimum hourly booking not met");
    }

    return pricing.hourlyPrice * Math.ceil(hours);
  }

  return pricing.weekdayPrice * booking.days;
};

// Resolves the rate for a single calendar day, applying a customDayPricing
// override for that day-of-week if one exists. Uses local Date methods
// (not UTC) to match the calendar-day-boundary convention already used
// throughout routes/bookings.js.
function resolveDayRate(date, baseRate, customDayPricing) {
  const day = date.getDay(); // 0=Sunday..6=Saturday
  const override = (customDayPricing || []).find((d) => d.day === day);
  return override ? override.rate : baseRate;
}

// Resolves the open/close window for a specific calendar day, accounting
// for per-day-of-week opening hours (availability.hoursMode === "custom").
// Falls back to the listing's flat openTime/closeTime for "same" mode.
// Returns { openTime, closeTime } (empty strings = no restriction set), or
// null when that day is open 24 hours (no restriction to check at all).
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function resolveDayHours(date, availability) {
  if (!availability) return { openTime: "", closeTime: "" };
  if (availability.hoursMode !== "custom") {
    if (availability.is24Hours) return null;
    return { openTime: availability.openTime || "", closeTime: availability.closeTime || "" };
  }
  const dayName = DAY_NAMES[date.getDay()];
  const entry = (availability.dayHours || []).find((d) => d.day === dayName);
  if (!entry) return { openTime: "", closeTime: "" };
  if (entry.is24Hours) return null;
  return { openTime: entry.openTime || "", closeTime: entry.closeTime || "" };
}
module.exports.resolveDayHours = resolveDayHours;

// DAILY pricing: walks each night of the stay (checkOutDate exclusive,
// same convention as the existing totalNights calendar-day-gap logic),
// applying any customDayPricing override per night. Returns the summed
// total plus a per-night breakdown for receipt display.
module.exports.calculateDailyPriceWithBreakdown = function (
  checkInDate,
  totalNights,
  baseRate,
  customDayPricing
) {
  const checkInDay = new Date(
    checkInDate.getFullYear(),
    checkInDate.getMonth(),
    checkInDate.getDate()
  );

  const breakdown = [];
  let totalPrice = 0;

  for (let i = 0; i < totalNights; i++) {
    const date = new Date(checkInDay);
    date.setDate(date.getDate() + i);
    const rate = resolveDayRate(date, baseRate, customDayPricing);
    breakdown.push({ date, rate });
    totalPrice += rate;
  }

  return { totalPrice, breakdown };
};

// HOURLY pricing: a single slot is billed as one lump sum for its whole
// duration (not split per calendar day even if it happens to cross
// midnight), so this looks up just the check-in date's day-of-week rather
// than looping like the DAILY case.
module.exports.calculateHourlyPriceWithBreakdown = function (
  checkInDate,
  totalHours,
  baseRate,
  customDayPricing
) {
  const rate = resolveDayRate(checkInDate, baseRate, customDayPricing);
  const totalPrice = Math.round(totalHours * rate * 100) / 100;
  return { totalPrice, breakdown: [{ date: checkInDate, rate }] };
};
