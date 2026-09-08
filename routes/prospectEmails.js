const express = require("express");
const router = express.Router();
const ProspectEmail = require("../models/ProspectEmail");

// POST /api/prospect-emails -- public, no auth. Called from the "coming
// soon" state on ServiceLocationPage.jsx when a visitor leaves their email
// for a territory VenCome hasn't launched in yet.
router.post("/", async (req, res) => {
  const { email, location, category, subcategory } = req.body;
  if (!email || !location) {
    return res.status(400).json({ error: "Email and location are required" });
  }
  const trimmedEmail = String(email).toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return res.status(400).json({ error: "Please enter a valid email address" });
  }

  try {
    await ProspectEmail.create({
      email: trimmedEmail,
      location: String(location).trim(),
      category: category ? String(category).trim() : undefined,
      subcategory: subcategory ? String(subcategory).trim() : undefined,
    });
    res.status(201).json({ success: true });
  } catch (err) {
    console.error("Prospect email capture error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
