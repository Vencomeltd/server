// One-time, idempotent conversion run at server start when PAYMENTS_V2 is on:
// a listing that has the legacy "security deposit" enabled (charged with the
// rent) becomes a card-hold deposit under the new system with the same amount,
// and the legacy setting is switched off so a host's later choice (including
// "no deposit") is never overridden on the next restart. Bookings already made
// under the legacy deposit are unaffected -- they finish through the old flow.
const Property = require("../../models/Property");

async function migrateLegacyDeposits() {
  const legacy = await Property.find({
    "deposit.enabled": true,
    "deposit.amount": { $gt: 0 },
    "depositPolicy.mode": { $in: ["none", null] },
  }).select("_id title deposit");

  for (const property of legacy) {
    await Property.updateOne(
      { _id: property._id },
      {
        $set: {
          "depositPolicy.mode": "card_hold",
          "depositPolicy.amountPence": Math.round(property.deposit.amount * 100),
          "depositPolicy.longStayFallback": "none",
          "deposit.enabled": false,
        },
      }
    );
    console.log(`[Payments v2] Converted legacy deposit on "${property.title}" (£${property.deposit.amount}) to a card hold`);
  }
  if (legacy.length > 0) console.log(`[Payments v2] Converted ${legacy.length} legacy deposit(s)`);
}

module.exports = migrateLegacyDeposits;
