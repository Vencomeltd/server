// Migration for editable content (build spec 31 Oct 2026, sections 5 and 8):
// the new SiteContent and EmailTemplate collections.
//
// up (default): no data change -- both start empty, and an empty collection
// means every page and email uses its built-in default. Reports what's saved.
// down (--rollback --apply): deletes every override, putting all site text
// and emails back to their defaults.
//   node scripts/migrateEditableContent.js
//   node scripts/migrateEditableContent.js --rollback --apply
require("dotenv").config({ path: require("path").join(__dirname, "../config.env") });
const mongoose = require("mongoose");
const SiteContent = require("../models/SiteContent");
const EmailTemplate = require("../models/EmailTemplate");

(async () => {
  const rollback = process.argv.includes("--rollback");
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.DATABASE);

  const [blocks, templates] = await Promise.all([SiteContent.countDocuments(), EmailTemplate.countDocuments()]);
  console.log(`${blocks} site content block(s) and ${templates} email template override(s) saved.`);

  if (rollback && apply) {
    await SiteContent.deleteMany({});
    await EmailTemplate.deleteMany({});
    console.log("Removed -- everything is back to its default wording.");
  } else if (rollback) {
    console.log("Rollback dry run -- pass --apply to write.");
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
