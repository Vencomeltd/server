// Migration for building listings (Property.listingType / parentBuilding /
// unitDetails).
//
// up (default): sets listingType "single" on every listing that has none.
// Nothing else changes -- the three new fields are optional, and a listing
// without listingType already reads as "single" (the schema default and the
// { $ne: "unit" } list filters), so this only makes the stored data explicit.
//
// down (--rollback): unsets listingType, parentBuilding and unitDetails, but
// ONLY on listings whose listingType is "single". Buildings and units are
// never touched, so rolling back cannot orphan a unit.
//
// Dry run unless --apply:
//   node scripts/migrateBuildingListings.js                    report
//   node scripts/migrateBuildingListings.js --apply            migrate
//   node scripts/migrateBuildingListings.js --rollback         rollback dry run
//   node scripts/migrateBuildingListings.js --rollback --apply rollback
const Property = require("../models/Property");

const MISSING = { listingType: { $exists: false } };
const SINGLE = { listingType: "single" };

async function migrate({ apply = false, rollback = false, log = console.log } = {}) {
  const filter = rollback ? SINGLE : MISSING;
  const matched = await Property.countDocuments(filter);
  log(
    rollback
      ? `Listings with listingType "single" to roll back: ${matched}`
      : `Listings with no listingType to set to "single": ${matched}`
  );
  if (!apply) {
    log("Dry run (add --apply to write).");
    return { matched, modified: 0 };
  }
  const update = rollback
    ? { $unset: { listingType: "", parentBuilding: "", unitDetails: "" } }
    : { $set: { listingType: "single" } };
  const result = await Property.updateMany(filter, update);
  const modified = result?.modifiedCount ?? 0;
  log(`${rollback ? "Rolled back" : "Migrated"} ${modified} listings.`);
  return { matched, modified };
}

module.exports = { migrate };

if (require.main === module) {
  require("dotenv").config({ path: "config.env" });
  const mongoose = require("mongoose");
  (async () => {
    await mongoose.connect(process.env.DATABASE);
    await migrate({ apply: process.argv.includes("--apply"), rollback: process.argv.includes("--rollback") });
    await mongoose.disconnect();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
