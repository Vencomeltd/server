// Building listings: one "building" Property (photos, address, amenities) with
// "unit" Properties under it (price, size, capacity, features, availability).
// Units have no photos and are enquiry-only. See models/Property.js.
const Property = require("../models/Property");
const { quote } = require("./vatPricing");

// Mongo filter for every list/count that must never show a unit as its own
// listing. $ne also matches listings created before listingType existed.
const NOT_UNIT = { listingType: { $ne: "unit" } };

const MAX_UNITS_PER_BUILDING = 100;
const UNIT_STATUSES = ["available", "available_from", "let"];
const AVAILABLE_STATUSES = ["available", "available_from"];

const isBlank = (value) => value === undefined || value === null || value === "";
const plain = (doc) => (typeof doc?.toObject === "function" ? doc.toObject() : doc);

// A unit's quote: the same quote() the listing cards use, on its monthly rate.
// Only what a guest may see (no commission figures).
function unitQuote(unit) {
  const { corePence, utilitiesPence, vatStatus, vatRatePct, vatPence, totalPence } = quote({
    corePence: Math.round((Number(unit.pricing?.monthly) || 0) * 100),
    quantity: 1,
    tax: unit.pricing?.vat?.monthly,
  });
  return { corePence, utilitiesPence, vatStatus, vatRatePct, vatPence, totalPence };
}

const isUnitAvailable = (unit) => AVAILABLE_STATUSES.includes(unit.unitDetails?.availability?.status);

// unitsAvailable + fromPricePence (lowest gross monthly among available
// units, null when there are none) for a building's units.
function summariseUnits(units) {
  const available = units.filter(isUnitAvailable);
  const prices = available.map((unit) => unitQuote(unit).totalPence);
  return { unitsAvailable: available.length, fromPricePence: prices.length ? Math.min(...prices) : null };
}

const liveUnitsFilter = (buildingFilter) => ({ parentBuilding: buildingFilter, listingType: "unit", isActive: true });

// Building cards in a list response get unitsAvailable and fromPricePence.
// Lists with no building in them cost no extra query and are returned as-is.
async function attachBuildingStats(properties) {
  const buildings = properties.filter((p) => p?.listingType === "building");
  if (!buildings.length) return properties;
  const units = await Property.find(liveUnitsFilter({ $in: buildings.map((b) => b._id) }))
    .select("parentBuilding pricing unitDetails")
    .lean();
  const byBuilding = new Map();
  for (const unit of units) {
    const key = String(unit.parentBuilding);
    byBuilding.set(key, [...(byBuilding.get(key) || []), unit]);
  }
  return properties.map((p) =>
    p?.listingType === "building"
      ? { ...plain(p), ...summariseUnits(byBuilding.get(String(p._id)) || []) }
      : p
  );
}

// What GET /properties/:id adds to a building: its units (oldest first) with
// their quote, and the same summary the cards show.
async function buildingUnitsDetail(buildingId) {
  const units = await Property.find(liveUnitsFilter(buildingId)).select("title pricing unitDetails createdAt").sort({ createdAt: 1 }).lean();
  return {
    units: units.map((u) => ({ _id: u._id, title: u.title, pricing: u.pricing, unitDetails: u.unitDetails, quote: unitQuote(u) })),
    ...summariseUnits(units),
  };
}

// ── Input validation for units ────────────────────────────────────────────

function cleanPositiveNumber(value, label, { integer = false, max }) {
  if (isBlank(value)) return { value: undefined };
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))) {
    return { error: `${label} must be a positive ${integer ? "whole " : ""}number` };
  }
  return { value: n };
}

// unitDetails from the request: label, sizeSqFt, capacity, features, availability.
function cleanUnitDetails(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "unitDetails is required" };
  const out = {};

  if (!isBlank(input.label)) {
    if (typeof input.label !== "string" || input.label.trim().length > 80) return { error: "label must be text of at most 80 characters" };
    out.label = input.label.trim();
  }
  for (const [key, opts] of [["sizeSqFt", { max: 1e6 }], ["capacity", { integer: true, max: 10000 }]]) {
    const { value, error } = cleanPositiveNumber(input[key], key, opts);
    if (error) return { error };
    if (value !== undefined) out[key] = value;
  }

  if (!isBlank(input.features)) {
    if (!Array.isArray(input.features) || input.features.length > 20) return { error: "features must be a list of at most 20 items" };
    if (input.features.some((f) => typeof f !== "string" || f.trim().length > 60)) return { error: "each feature must be text of at most 60 characters" };
    out.features = input.features.map((f) => f.trim()).filter(Boolean);
  }

  const availability = input.availability ?? {};
  if (typeof availability !== "object" || Array.isArray(availability)) return { error: "availability must be an object" };
  const status = availability.status ?? "available";
  if (!UNIT_STATUSES.includes(status)) return { error: `availability.status must be one of ${UNIT_STATUSES.join(", ")}` };
  out.availability = { status };
  if (status === "available_from") {
    const date = new Date(availability.availableFrom);
    if (isBlank(availability.availableFrom) || Number.isNaN(date.getTime())) return { error: "availability.availableFrom must be a valid date when status is available_from" };
    out.availability.availableFrom = date;
  }
  return { value: out };
}

// pricing from the request, cut down to what a unit may carry: the monthly
// rate (plain, or with VAT/utilities under vat.monthly), minimumTermMonths and
// pricingType. The route then runs it through applyVatSettings like any listing.
function cleanUnitPricing(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "pricing is required" };
  const out = { pricingType: "MONTHLY" };

  const vat = input.vat?.monthly;
  if (!isBlank(vat) && (typeof vat !== "object" || !(Number(vat.enteredPence) >= 0))) return { error: "pricing.vat.monthly.enteredPence must be a number of pence" };
  if (vat && !(Number(vat.ratePct ?? 20) >= 0 && Number(vat.ratePct ?? 20) <= 100)) return { error: "pricing.vat.monthly.ratePct must be between 0 and 100" };
  if (vat && Number(vat.enteredPence) > 0) out.vat = { monthly: vat };

  const monthly = cleanPositiveNumber(input.monthly, "pricing.monthly", { max: 1e7 });
  if (monthly.error) return { error: monthly.error };
  if (monthly.value !== undefined) out.monthly = monthly.value;
  if (!out.vat && out.monthly === undefined) return { error: "A monthly price is required" };

  if (!isBlank(input.minimumTermMonths)) {
    const months = Number(input.minimumTermMonths);
    if (!Number.isInteger(months) || months < 2 || months > 36) return { error: "pricing.minimumTermMonths must be a whole number from 2 to 36" };
    out.minimumTermMonths = months;
  }
  return { value: out };
}

function cleanUnitTitle(title) {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 150) return { error: "title is required (up to 150 characters)" };
  return { value: title.trim() };
}

module.exports = {
  NOT_UNIT,
  MAX_UNITS_PER_BUILDING,
  unitQuote,
  summariseUnits,
  attachBuildingStats,
  buildingUnitsDetail,
  cleanUnitDetails,
  cleanUnitPricing,
  cleanUnitTitle,
};
