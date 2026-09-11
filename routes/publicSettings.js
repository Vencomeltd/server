// Public, unauthenticated subset of PlatformSettings -- the admin-only
// GET /admin/settings can't be hit by anonymous visitors, but the storefront
// (Navbar currency picker, price formatting) needs to know the admin's
// configured currency. Only exposes fields safe for anyone to read.
const express = require("express");
const router = express.Router();
const PlatformSettings = require("../models/PlatformSettings");

router.get("/", async (req, res) => {
  try {
    const settings = await PlatformSettings.getSettings();
    res.json({ currency: settings.currency });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
