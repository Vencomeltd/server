// Building listings: one "building" Property (photos, address, amenities, lease
// agreement) with "unit" Properties (rooms) under it. A room is a full bookable
// listing -- its own price, booking settings and availability, optional photos
// -- that takes its location, category and lease from the building.
// See models/Property.js.
const Property = require("../models/Property");
const { quote } = require("./vatPricing");
const { generateSlug } = require("./slugify");

// Mongo filter for every list/count that must never show a unit as its own
// listing. $ne also matches listings created before listingType existed.
const NOT_UNIT = { listingType: { $ne: "unit" } };

const MAX_UNITS_PER_BUILDING = 100;
const UNIT_STATUSES = ["available", "available_from", "let"];
const AVAILABLE_STATUSES = ["available", "available_from"];

const isBlank = (value) => value === undefined || value === null || value === "";
const plain = (doc) => (typeof doc?.toObject === "function" ? doc.toObject() : doc);

// A room is priced like any listing, so it may have hourly, daily, weekly and
// monthly rates. Its card quote uses the first one it has, monthly first.
const QUOTE_TIERS = [["monthly", "month"], ["weekly", "week"], ["daily", "day"], ["hourly", "hour"]];
const tierPricePence = (pricing, key) => {
  const value = key === "daily" ? pricing.daily || pricing.weekdayPrice : key === "hourly" ? pricing.hourly || pricing.hourlyPrice : pricing[key];
  return Math.round((Number(value) || 0) * 100);
};
const quoteTier = (unit) => QUOTE_TIERS.find(([key]) => tierPricePence(unit.pricing || {}, key) > 0) || QUOTE_TIERS[0];

// A unit's quote: the same quote() the listing cards use, on its first rate.
// Only what a guest may see (no commission figures); `per` says which rate.
function unitQuote(unit) {
  const [key, per] = quoteTier(unit);
  const { corePence, utilitiesPence, vatStatus, vatRatePct, vatPence, totalPence } = quote({
    corePence: tierPricePence(unit.pricing || {}, key),
    quantity: 1,
    tax: unit.pricing?.vat?.[key],
  });
  return { corePence, utilitiesPence, vatStatus, vatRatePct, vatPence, totalPence, per };
}

const isUnitAvailable = (unit) => AVAILABLE_STATUSES.includes(unit.unitDetails?.availability?.status);

// unitsAvailable + fromPricePence (lowest gross price among available units,
// null when there are none) for a building's units. Prices are compared per
// rate -- the first rate in this order that any available unit has: monthly, weekly, daily,
// hourly -- and fromPriceUnit says which ("month" unless no unit has a monthly rate).
function summariseUnits(units) {
  const available = units.filter(isUnitAvailable);
  const quotes = available.map(unitQuote);
  const per = QUOTE_TIERS.map(([, name]) => name).find((name) => quotes.some((q) => q.per === name));
  const prices = quotes.filter((q) => q.per === per).map((q) => q.totalPence);
  return { unitsAvailable: available.length, fromPricePence: prices.length ? Math.min(...prices) : null, fromPriceUnit: per || "month" };
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

// A room's URL: /property/<building>/<room>. The building's slug is missing on
// listings made before slugs existed, so its id stands in.
const roomPath = (building, unit) => `/property/${building.slug || building._id}/${unit.roomSlug || unit._id}`;

// A room shows its own photos when it has any, otherwise its building's.
function roomPhotos(unit, building) {
  const own = unit.images?.length > 0;
  return {
    images: own ? unit.images : building.images || [],
    coverImage: own ? unit.coverImage || unit.images[0] : building.coverImage,
    imagesInherited: !own,
  };
}

// What GET /properties/:id adds to a building: its units (oldest first) with
// their quote, URL and photo, and the same summary the cards show.
// `building` needs _id, slug, images and coverImage.
async function buildingUnitsDetail(building) {
  const units = await Property.find(liveUnitsFilter(building._id))
    .select("title pricing unitDetails createdAt roomSlug images coverImage")
    .sort({ createdAt: 1 })
    .lean();
  return {
    units: units.map((u) => ({
      _id: u._id,
      title: u.title,
      pricing: u.pricing,
      unitDetails: u.unitDetails,
      quote: unitQuote(u),
      roomSlug: u.roomSlug,
      path: roomPath(building, u),
      coverImage: roomPhotos(u, building).coverImage,
      imagesInherited: roomPhotos(u, building).imagesInherited,
    })),
    ...summariseUnits(units),
  };
}

// The Mongo filter for every PUBLIC list, search, map, sitemap and count: no
// rooms, and no building until it has at least one active room. Spread it in
// where NOT_UNIT was (owners' and admin lists keep using NOT_UNIT).
async function publicListingFilter() {
  const withRooms = await Property.distinct("parentBuilding", { listingType: "unit", isActive: true });
  return { ...NOT_UNIT, $nor: [{ listingType: "building", _id: { $nin: withRooms } }] };
}

// A slug for a room that no other room in its building has, from its label (or title).
async function uniqueRoomSlug(buildingId, text, exceptId) {
  const base = generateSlug(text || "") || "room";
  const taken = new Set(
    (await Property.find({ parentBuilding: buildingId, listingType: "unit" }).select("roomSlug").lean())
      .filter((u) => String(u._id) !== String(exceptId))
      .map((u) => u.roomSlug)
  );
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return slug;
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

module.exports = {
  NOT_UNIT,
  MAX_UNITS_PER_BUILDING,
  unitQuote,
  summariseUnits,
  attachBuildingStats,
  buildingUnitsDetail,
  cleanUnitDetails,
  cleanPositiveNumber,
  roomPath,
  roomPhotos,
  publicListingFilter,
  uniqueRoomSlug,
};
