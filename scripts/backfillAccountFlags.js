// Migration for admin user flags and verify reminders (build spec 31 Oct
// 2026, section 3).
//
// up: accounts already marked isTestAccount get accountFlag "test" so admin
// shows why they're excluded -- they were already left out of every total.
// User.verifyReminders and EmailLog.category need no data change (unset =
// no reminders sent yet / a transactional email).
//   node scripts/backfillAccountFlags.js                    report
//   node scripts/backfillAccountFlags.js --apply            write
// down: removes accountFlag from every user.
//   node scripts/backfillAccountFlags.js --rollback --apply
require("dotenv").config({ path: require("path").join(__dirname, "../config.env") });
const mongoose = require("mongoose");
const User = require("../models/User");

(async () => {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  await mongoose.connect(process.env.DATABASE);

  const filter = rollback ? { accountFlag: { $exists: true } } : { isTestAccount: true, accountFlag: { $exists: false } };
  const users = await User.find(filter).select("email accountFlag");
  console.log(`${users.length} account(s) ${rollback ? "with a flag to remove" : "to flag as test"}:`);
  for (const user of users) console.log(`  ${user.email}`);

  if (apply && users.length) {
    const update = rollback ? { $unset: { accountFlag: "" } } : { $set: { accountFlag: "test" } };
    const result = await User.updateMany(filter, update);
    console.log(`Updated ${result.modifiedCount}.`);
  } else if (!apply) {
    console.log("Report only -- pass --apply to write.");
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
