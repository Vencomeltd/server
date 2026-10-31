// Migration for VAT / utilities pricing (build spec 31 Oct 2026, section 1).
//
// up (default): no data change. The new fields are all optional --
// Property.pricing.vat, Booking.pricingBreakdown, PlatformSettings
// .commissionBase (defaults to "core") -- and a listing without
// pricing.vat is priced exactly as before ("VAT status not set" in admin).
// This only reports how many active listings still need a VAT status.
//
// down (--rollback): removes the new fields. Dry run unless --apply.
//   node scripts/migrateVatPricing.js                    report
//   node scripts/migrateVatPricing.js --rollback         rollback dry run
//   node scripts/migrateVatPricing.js --rollback --apply rollback
// Each VAT-set listing's price goes back to the gross the customer pays
// today (pre-VAT, the price field was what the customer paid). Existing
// bookings' totalPrice, platformFee and hostAmount are never changed --
// only the breakdown that sits beside them is removed.
require("dotenv").config({ path: "config.env" });
const mongoose = require("mongoose");
const Property = require("../models/Property");
const Booking = require("../models/Booking");
const PlatformSettings = require("../models/PlatformSettings");

const ROLLBACK = process.argv.includes("--rollback");
const APPLY = process.argv.includes("--apply");
const UNITS = ["hourly", "daily", "weekly", "monthly"];

const run = async () => {
  await mongoose.connect(process.env.DATABASE);
  const noVat = await Property.countDocuments({ isActive: true, "pricing.vat": { $exists: false } });
  const vatListings = await Property.find({ "pricing.vat": { $exists: true } }).select("pricing.vat title");
  const withBreakdown = await Booking.countDocuments({ pricingBreakdown: { $exists: true } });
  console.log(`Active listings with VAT status not set: ${noVat}`);
  console.log(`Listings with VAT settings: ${vatListings.length}; bookings with a price breakdown: ${withBreakdown}`);

  if (ROLLBACK) {
    console.log(APPLY ? "Rolling back..." : "Rollback dry run (add --apply to write).");
    for (const listing of vatListings) {
      const set = {};
      for (const unit of UNITS) {
        const gross = listing.pricing?.vat?.[unit]?.grossPence;
        if (gross > 0) set[`pricing.${unit}`] = gross / 100;
      }
      console.log(`  ${listing.title}: ${JSON.stringify(set)}`);
      if (APPLY) await Property.updateOne({ _id: listing._id }, { $set: set, $unset: { "pricing.vat": "" } });
    }
    if (APPLY) {
      await Booking.updateMany({ pricingBreakdown: { $exists: true } }, { $unset: { pricingBreakdown: "" } });
      await PlatformSettings.updateMany({}, { $unset: { commissionBase: "" } });
      console.log("Rolled back.");
    }
  }
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
