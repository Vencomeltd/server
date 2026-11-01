const Market = require("../models/Market");
const PlatformSettings = require("../models/PlatformSettings");
const { PAYMENTS_CONFIG } = require("../config/payments");

// ANNUAL/MONTHLY stay fixed regardless of market — only the HOURLY/DAILY/
// WEEKLY "everything else" tier is affected by the platform default or a
// per-market override. A monthly booking of 12+ months (termMonths) pays the
// annual 3%, even when it's paid month by month. Market matching mirrors the admin dashboard's
// bookingsForMarket logic: a market's name or any of its cities,
// case-insensitively substring-matched against the property's country/city.
async function resolveCommissionRate(pricingType, property, { termMonths = 0 } = {}) {
  if (pricingType === "ANNUAL") return 0.03;
  if (pricingType === "MONTHLY") return termMonths >= PAYMENTS_CONFIG.leaseLowCommissionMonths ? 0.03 : 0.06;

  const country = (property?.location?.country || "").toLowerCase();
  const city = (property?.location?.city || "").toLowerCase();

  if (country || city) {
    const overrideMarkets = await Market.find({ commissionOverrideActive: true, commissionRate: { $ne: null } });
    const match = overrideMarkets.find((m) => {
      const needles = [m.name, ...(m.cities || [])].map((s) => (s || "").toLowerCase());
      return needles.some((n) => n && (country.includes(n) || city.includes(n)));
    });
    if (match) return match.commissionRate / 100;
  }

  const settings = await PlatformSettings.getSettings();
  return (settings.defaultCommissionRate ?? 10) / 100;
}

module.exports = { resolveCommissionRate };
