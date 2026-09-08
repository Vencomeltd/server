const mongoose = require("mongoose");

// Emails left by prospective hosts in a territory (subcategory + location)
// VenCome hasn't launched in yet -- collected from ServiceLocationPage.jsx's
// "coming soon" state, so admin can email people once that territory opens.
const prospectEmailSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    location: { type: String, required: true, trim: true },
    category: { type: String, trim: true },
    subcategory: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ProspectEmail", prospectEmailSchema);
