// Migration for listing/draft creators (build spec 31 Oct 2026, section 4).
//
// up (default): no data change. Property.createdBy and Draft.createdBy are
// set on new records only; unset means the host built it (everything made
// before this field existed), which is how admin shows it. Reports counts.
// down (--rollback --apply): removes createdBy from every listing and draft.
//   node scripts/migrateCreatedBy.js
//   node scripts/migrateCreatedBy.js --rollback --apply
require("dotenv").config({ path: require("path").join(__dirname, "../config.env") });
const mongoose = require("mongoose");
const Property = require("../models/Property");
const Draft = require("../models/Draft");

(async () => {
  const rollback = process.argv.includes("--rollback");
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.DATABASE);

  const has = { createdBy: { $exists: true } };
  const [listings, drafts] = await Promise.all([Property.countDocuments(has), Draft.countDocuments(has)]);
  console.log(`createdBy set on ${listings} listing(s) and ${drafts} draft(s); the rest count as built by their host.`);

  if (rollback && apply) {
    await Property.updateMany(has, { $unset: { createdBy: "" } });
    await Draft.updateMany(has, { $unset: { createdBy: "" } });
    console.log("Removed createdBy.");
  } else if (rollback) {
    console.log("Rollback dry run -- pass --apply to write.");
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
