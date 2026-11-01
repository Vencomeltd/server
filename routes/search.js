const express = require("express");
const Property = require("../models/Property");
const router = express.Router();

// GET /api/search?q=&city=&minPrice=&maxPrice=&category=&pricingType=&page=
router.get("/", async (req, res) => {
  try {
    const {
      q, city, country, category, pricingType,
      minPrice, maxPrice, lat, lng, radius,
      page = 1, limit = 12, sortBy = "createdAt",
    } = req.query;

    const filter = { isActive: true };

    if (q) {
      filter.$or = [
        { title: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { "location.city": { $regex: q, $options: "i" } },
      ];
    }

    if (city) filter["location.city"] = { $regex: city, $options: "i" };
    if (country) filter["location.country"] = { $regex: country, $options: "i" };
    if (category) filter.category = category;
    if (pricingType) filter["pricing.pricingType"] = pricingType;

    if (minPrice || maxPrice) {
      filter.$and = filter.$and || [];
      if (pricingType === "HOURLY") {
        if (minPrice) filter.$and.push({ "pricing.hourlyPrice": { $gte: Number(minPrice) } });
        if (maxPrice) filter.$and.push({ "pricing.hourlyPrice": { $lte: Number(maxPrice) } });
      } else {
        if (minPrice) filter.$and.push({ "pricing.weekdayPrice": { $gte: Number(minPrice) } });
        if (maxPrice) filter.$and.push({ "pricing.weekdayPrice": { $lte: Number(maxPrice) } });
      }
    }

    // Geo-radius filter
    if (lat && lng) {
      const radiusKm = Number(radius) || 25;
      const radiusDeg = radiusKm / 111; // 1 degree ≈ 111km
      filter["coordinates.latitude"] = { $gte: Number(lat) - radiusDeg, $lte: Number(lat) + radiusDeg };
      filter["coordinates.longitude"] = { $gte: Number(lng) - radiusDeg, $lte: Number(lng) + radiusDeg };
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, parseInt(limit));
    const skip = (pageNum - 1) * limitNum;

    const sortMap = {
      createdAt: { createdAt: -1 },
      rating: { rating: -1 },
      price_asc: { "pricing.weekdayPrice": 1, "pricing.hourlyPrice": 1 },
      price_desc: { "pricing.weekdayPrice": -1, "pricing.hourlyPrice": -1 },
    };
    const sort = sortMap[sortBy] || { createdAt: -1 };

    const [properties, total] = await Promise.all([
      Property.find(filter)
        .populate("category", "name icon")
        .populate("host", "firstName lastName profileImage isVerified businessVerification.companyName accountFlag")
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .select("-blockedDates -__v"),
      Property.countDocuments(filter),
    ]);

    res.json({
      properties,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      hasMore: skip + properties.length < total,
    });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/search/nearby?lat=&lng=&radius=
router.get("/nearby", async (req, res) => {
  const { lat, lng, radius = 10, limit = 10 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng are required" });

  try {
    const radiusDeg = Number(radius) / 111;
    const properties = await Property.find({
      isActive: true,
      "coordinates.latitude": { $gte: Number(lat) - radiusDeg, $lte: Number(lat) + radiusDeg },
      "coordinates.longitude": { $gte: Number(lng) - radiusDeg, $lte: Number(lng) + radiusDeg },
    })
      .populate("category", "name icon")
      .populate("host", "firstName lastName profileImage businessVerification.companyName accountFlag")
      .limit(Math.min(50, parseInt(limit)))
      .select("title coverImage location coordinates pricing rating reviewNumber category host");

    res.json({ properties });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
