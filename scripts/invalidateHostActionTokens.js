// One-off security fix: GET /bookings/:id used to return hostActionToken (the
// single-use one-click approve/decline token from the "New booking request"
// email) to any logged-in user. The route is now locked down, but tokens that
// were readable before the fix could have been read by someone else, so this
// clears every still-unexpired one. Affected hosts fall back to the dashboard
// (the email link then shows "invalid or already used"). Run with --apply to
// actually write; without it, dry-run only. Token values are never printed.
require("dotenv").config({ path: "config.env" });
const mongoose = require("mongoose");
const Booking = require("../models/Booking");

const APPLY = process.argv.includes("--apply");

const run = async () => {
  await mongoose.connect(process.env.DATABASE);
  console.log(`Connected (${APPLY ? "APPLY" : "dry-run"})`);

  const filter = {
    hostActionToken: { $exists: true, $nin: [null, ""] },
    $or: [
      { hostActionTokenExpires: { $exists: false } },
      { hostActionTokenExpires: null },
      { hostActionTokenExpires: { $gt: new Date() } },
    ],
  };

  const affected = await Booking.find(filter).select("_id status hostActionTokenExpires");
  console.log(`Found ${affected.length} booking(s) with an unexpired hostActionToken:`);
  affected.forEach((b) =>
    console.log(`  ${b._id}  status=${b.status}  expires=${b.hostActionTokenExpires?.toISOString() ?? "none"}`)
  );

  if (APPLY && affected.length > 0) {
    const result = await Booking.updateMany(filter, {
      $unset: { hostActionToken: "", hostActionTokenExpires: "" },
    });
    console.log(`Cleared tokens on ${result.modifiedCount} document(s).`);
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
