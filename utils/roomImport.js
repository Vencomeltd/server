// Room import: validate and plan a spreadsheet's worth of rooms for one building.
// Pure -- no database. POST /properties/:buildingId/units/import loads the
// building's existing room slugs, calls planRoomImport(), and (unless it is a
// dry run) saves the rows planned as "create".
//
// A row is checked with the same validators the room create path uses
// (cleanUnitDetails for the room name, size, capacity, features and status;
// applyVatSettings + roomPricingError for the price, VAT and minimum term), so
// an imported room can never hold something a hand-made room could not.
const { generateSlug } = require("./slugify");
const { VAT_STATUSES } = require("./vatPricing");
const { cleanUnitDetails, cleanPositiveNumber } = require("./buildingListings");

const MAX_IMPORT_ROWS = 200;
const MAX_PRICE = 1e7;

const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

// The shared validators word their messages for the API; say them in the
// spreadsheet's terms.
const friendly = (message) =>
  message
    .replace(/^label /, "room name ")
    .replace(/availability\.status/g, "status")
    .replace(/availability\.availableFrom/g, "availableFrom")
    .replace(/pricing\.minimumTermMonths/g, "minTermMonths");

// features: a list, or one comma/newline separated string.
const featureList = (value) =>
  typeof value === "string" ? [...new Set(value.split(/[,\n]/).map((f) => f.trim()).filter(Boolean))] : value;

// YYYY-MM-DD that is a real calendar date.
const isIsoDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const date = new Date(`${value.trim()}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.trim();
};

// The slug the room create path would give this room name (before any "-2").
const roomSlugFor = (name) => generateSlug(name) || "room";

// One row -> { name, errors } or { name, errors: [], value }, where value is
// { title, description, slug, pricing, unitDetails } ready to become a room.
function cleanImportRow(row, { applyVatSettings, roomPricingError }) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { name: "", errors: ["row must be an object"] };
  const errors = [];
  const name = typeof row.room === "string" ? row.room.trim() : typeof row.room === "number" ? String(row.room) : "";

  if (!name) errors.push(isBlank(row.room) ? "room name is required" : "room name must be text");

  // Price and VAT.
  let pricing;
  const price = cleanPositiveNumber(row.pricePerMonth, "pricePerMonth", { max: MAX_PRICE });
  if (price.error) errors.push(price.error);
  else if (price.value === undefined) errors.push("pricePerMonth is required");

  if (!VAT_STATUSES.includes(row.vatStatus)) errors.push(`vatStatus is required and must be one of ${VAT_STATUSES.join(", ")}`);
  let ratePct;
  if (!isBlank(row.vatRatePct)) {
    ratePct = typeof row.vatRatePct === "string" ? Number(row.vatRatePct.trim()) : row.vatRatePct;
    if (typeof ratePct !== "number" || !Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) errors.push("vatRatePct must be a number from 0 to 100");
  }
  if (!price.error && price.value !== undefined && VAT_STATUSES.includes(row.vatStatus) && !errors.some((e) => e.startsWith("vatRatePct"))) {
    pricing = {
      monthly: price.value,
      vat: { monthly: { enteredPence: Math.round(price.value * 100), status: row.vatStatus, ratePct, utilities: { amountPence: 0, per: "unit", vatable: true } } },
    };
    if (!isBlank(row.minTermMonths)) pricing.minimumTermMonths = typeof row.minTermMonths === "string" ? Number(row.minTermMonths.trim()) : row.minTermMonths;
    pricing = applyVatSettings(pricing);
    const pricingError = roomPricingError(pricing);
    if (pricingError) errors.push(pricingError);
  }

  // Name, size, capacity, features, status: one group at a time so every
  // problem in the row is reported, not just the first.
  const status = isBlank(row.status) ? "available" : row.status;
  const groups = [
    { label: name },
    { sizeSqFt: row.sizeSqFt },
    { capacity: row.capacity },
    { features: isBlank(row.features) ? undefined : featureList(row.features) },
    { availability: { status, availableFrom: status === "available_from" ? row.availableFrom : undefined } },
  ];
  const unitDetails = {};
  for (const group of groups) {
    if (group.availability?.status === "available_from" && !isIsoDate(group.availability.availableFrom)) {
      errors.push("availableFrom must be a date as YYYY-MM-DD when status is available_from");
      continue;
    }
    const cleaned = cleanUnitDetails(group);
    if (cleaned.error) errors.push(cleaned.error);
    else {
      const { availability, ...rest } = cleaned.value;
      Object.assign(unitDetails, rest, group.availability && { availability });
    }
  }

  if (!isBlank(row.description) && typeof row.description !== "string") errors.push("description must be text");

  const unique = [...new Set(errors.map(friendly))];
  if (unique.length) return { name, errors: unique };
  return {
    name,
    errors: [],
    value: {
      title: name,
      description: isBlank(row.description) ? name : row.description.trim(),
      slug: roomSlugFor(name),
      pricing,
      unitDetails,
    },
  };
}

// rows -> [{ row (1-based), room, status, errors, reason?, value? }], status
// "create" | "duplicate" | "error". Nothing here updates an existing room: a
// row whose room name slugifies to an existing roomSlug in the building, or to
// one an earlier valid row in the file already claimed, is a duplicate and is
// skipped. Rows that fail validation never claim a slug. `capacity` is how many
// more rooms the building can hold.
function planRoomImport(rows, { existingSlugs, capacity, applyVatSettings, roomPricingError }) {
  const claimed = new Map(); // slug -> 1-based row of the file row that will create it
  let room = capacity;
  return rows.map((row, index) => {
    const number = index + 1;
    const cleaned = cleanImportRow(row, { applyVatSettings, roomPricingError });
    if (cleaned.errors.length) return { row: number, room: cleaned.name, status: "error", errors: cleaned.errors };

    const { slug } = cleaned.value;
    if (existingSlugs.has(slug)) {
      return { row: number, room: cleaned.name, status: "duplicate", errors: [], reason: "A room with this name already exists in the building" };
    }
    if (claimed.has(slug)) {
      return { row: number, room: cleaned.name, status: "duplicate", errors: [], reason: `Repeats row ${claimed.get(slug)} in this file` };
    }
    if (room <= 0) {
      return { row: number, room: cleaned.name, status: "error", errors: ["The building is already at its maximum number of rooms"] };
    }
    claimed.set(slug, number);
    room -= 1;
    return { row: number, room: cleaned.name, status: "create", errors: [], value: cleaned.value };
  });
}

const summarise = (results) => ({
  total: results.length,
  create: results.filter((r) => r.status === "create" || r.status === "created").length,
  duplicate: results.filter((r) => r.status === "duplicate").length,
  error: results.filter((r) => r.status === "error").length,
});

module.exports = { MAX_IMPORT_ROWS, cleanImportRow, planRoomImport, roomSlugFor, summarise };
