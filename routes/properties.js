const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const Property = require("../models/Property");
const { normaliseDepositPolicy } = require("../utils/paymentsV2/amounts");
const Category = require("../models/Category");
const auth = require("../middleware/auth");
const uploadToR2 = require("../utils/uploadService");
const { deleteFromR2 } = require("../utils/uploadService");
const validatePricing = require("../middleware/validatePricing");
const User = require("../models/User");
const Report = require("../models/Report");
const Draft = require("../models/Draft");
const makeUserHost = require("../utils/stripeConnect");
const { getUnitOccupancy, isFullyBooked } = require("../utils/unitAvailability");
const sendEmail = require("../utils/sendEmail");
const { geocodeAddress } = require("../utils/geocode");
const { client } = require("../utils/redisClient");
const { publicHostPopulate, publicListing } = require("../utils/hostName");
const geoip = require("geoip-lite");
const { generateUniqueSlug, generateSlug } = require("../utils/slugify");

const { buildUnitTax } = require("../utils/vatPricing");
const {
  NOT_UNIT,
  MAX_UNITS_PER_BUILDING,
  attachBuildingStats,
  buildingUnitsDetail,
  cleanUnitDetails,
  publicListingFilter,
  roomPath,
  roomPhotos,
  uniqueRoomSlug,
} = require("../utils/buildingListings");
const { listingName } = require("../utils/listingName");

// minBookingHours from the listing editor: a whole number of hours, 0-24
// (0 = no minimum). Returns undefined when not sent, null when invalid.
const parseMinBookingHours = (value) => {
  if (value === undefined) return undefined;
  const hours = Number(value);
  return Number.isInteger(hours) && hours >= 0 && hours <= 24 ? hours : null;
};
const MIN_BOOKING_HOURS_ERROR = "Minimum booking hours must be a whole number from 0 to 24";
const router = express.Router();

// pricing.vat from the listing form: every figure is recomputed here (never
// the browser's maths), and pricing[unit] becomes the core price ex VAT --
// what every booking and commission calculation reads. See utils/vatPricing.js.
const VAT_UNITS = ["hourly", "daily", "weekly", "monthly"];
function applyVatSettings(pricing, existingVat) {
  if (!pricing) return pricing;
  if (!pricing.vat) {
    // A form without the VAT fields (e.g. an older edit page) keeps what's saved.
    if (existingVat) pricing.vat = existingVat;
    return pricing;
  }
  const vat = {};
  for (const unit of VAT_UNITS) {
    const entry = pricing.vat[unit];
    if (!entry || !(Number(entry.enteredPence) > 0)) continue;
    vat[unit] = buildUnitTax(entry);
    pricing[unit] = vat[unit].netPence / 100;
  }
  pricing.vat = vat;
  return pricing;
}

// Commission rates for the listing form's payout calculator (an estimate --
// a market override can change the hourly/daily/weekly rate at booking).
router.get("/commission-rates", async (req, res) => {
  try {
    const PlatformSettings = require("../models/PlatformSettings");
    const settings = await PlatformSettings.getSettings();
    res.json({
      hourly: settings.defaultCommissionRate,
      daily: settings.defaultCommissionRate,
      weekly: settings.defaultCommissionRate,
      monthly: 6,
      annual: 3,
      base: settings.commissionBase || "core",
    });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// Configure multer storage for temporary files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/temp/";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage,
  // Raised from 10MB -- a listing video needs more room than a document
  // or photo. Applies to every field on this shared instance (images,
  // cqcDocuments, leaseFile, video); no per-field limit support in multer
  // without a second instance, not worth the complexity for a size ceiling.
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "video/mp4",
      "video/quicktime",
      "video/webm",
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(
        new Error("Only image, video, PDF, DOC, and DOCX files are allowed!"),
        false
      );
    }
    cb(null, true);
  },
});

// ====================== HELPERS ======================

const cleanupTempFiles = (files) => {
  files?.forEach((file) => {
    if (fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch (e) {
        console.error("Error deleting temp file:", e);
      }
    }
  });
};

// Breakpoint widths generated per listing photo -- the client derives each
// smaller variant's URL from the stored (largest) URL by swapping the
// "-w1600.webp" suffix, so property.images keeps storing a single plain URL
// string per photo (no schema change) while R2 actually holds all 4 sizes.
const IMAGE_WIDTHS = [480, 800, 1200, 1600];

// Runs async work over `items` with at most `limit` in flight at once,
// instead of firing everything concurrently -- used below to cap how many
// sharp image conversions run at the same time.
const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

// Shared by listing photos AND non-image documents (CQC compliance docs,
// lease PDFs) uploaded through the same form fields -- only actual raster
// images get re-encoded to WebP variants here, everything else uploads
// unchanged.
//
// Each image is re-encoded into 4 WebP width variants (see IMAGE_WIDTHS),
// so an unbounded Promise.all over `files` here means N uploaded photos
// fire up to N*4 concurrent sharp operations -- a host uploading a full
// batch of listing photos (up to 45 allowed) could spike to 180 concurrent
// image conversions with nothing throttling it. Capped at 3 files
// processing at once to bound peak memory regardless of batch size.
const uploadFilesToR2 = async (files) => {
  return mapWithConcurrency(files, 3, async (file) => {
    if (!file.mimetype.startsWith("image/")) {
      try {
        const result = await uploadToR2(file.path, file.filename, file.mimetype);
        return result.location;
      } catch (error) {
        console.error(`Error uploading ${file.filename}:`, error);
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        throw error;
      }
    }

    const baseName = file.filename.slice(0, -path.extname(file.filename).length);
    const dir = path.dirname(file.path);

    try {
      // One shared decode of the source file, cloned per width variant --
      // this used to call sharp(file.path) separately for each of the 4
      // widths, re-reading and re-decoding the same original 4 times in
      // parallel (x3 for mapWithConcurrency's concurrent files = up to 12
      // simultaneous decodes). For a large raw photo (reported: a 25MB
      // upload that "refused to compress" until a safety timeout dropped
      // it), that's 4x the CPU/memory work this step actually needs.
      // sharp's own docs recommend exactly this decode-once/.clone()
      // pattern for deriving multiple outputs from one source.
      const source = sharp(file.path);
      const variants = await Promise.all(
        IMAGE_WIDTHS.map(async (width) => {
          const variantFilename = `${baseName}-w${width}.webp`;
          const variantPath = path.join(dir, variantFilename);
          await source
            .clone()
            .resize({ width, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(variantPath);
          const result = await uploadToR2(variantPath, variantFilename, "image/webp");
          if (fs.existsSync(variantPath)) fs.unlinkSync(variantPath);
          return { width, location: result.location };
        })
      );
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return variants.reduce((largest, v) => (v.width > largest.width ? v : largest)).location;
    } catch (conversionError) {
      console.error(`WebP variant generation failed for ${file.filename}, uploading original:`, conversionError);
      const result = await uploadToR2(file.path, file.filename, file.mimetype);
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return result.location;
    }
  });
};

const deleteFilesFromR2 = async (imageUrls) => {
  const deletePromises = imageUrls.map(async (url) => {
    try {
      const filename = url.split("/").pop();
      await deleteFromR2(filename);
    } catch (error) {
      console.error(`Error deleting ${url}:`, error);
    }
  });
  await Promise.all(deletePromises);
};

// ====================== ROUTES ======================

// Creating a listing takes the files below. A room (listingType "unit" with a
// parentBuilding) is created here too -- POST /:buildingId/units calls the same
// handler -- and takes its host, location and category from its building.
const listingUpload = upload.fields([
  { name: "images", maxCount: 45 },
  { name: "cqcDocuments", maxCount: 10 },
  { name: "leaseFile", maxCount: 1 }, // ✅ NEW: Added lease file field
  { name: "video", maxCount: 1 },
]);
const createListingHandler = async (req, res) => {
    try {
      const isUnit = req.body.listingType === "unit";
      let building;
      if (isUnit) {
        const found = await loadBuildingForRoom(req.user.id, req.body.parentBuilding);
        if (found.error) {
          cleanupTempFiles([
            ...(req.files?.images || []),
            ...(req.files?.cqcDocuments || []),
            ...(req.files?.leaseFile || []),
            ...(req.files?.video || []),
          ]);
          return res.status(found.status).json({ error: found.error });
        }
        building = found.building.toObject();
      }

      // ── Parse JSON safely ──
      let location,
        coordinates,
        features,
        extras,
        pricing,
        bookingSettings,
        blockedDates,
        timeBlocks;

      try {
        // A room's location comes from its building, and it needs no features.
        location = isUnit ? building.location : JSON.parse(req.body.location);
        coordinates = isUnit ? building.coordinates : JSON.parse(req.body.coordinates);
        features = JSON.parse(req.body.features || (isUnit ? "{}" : undefined));
        extras = JSON.parse(req.body.extras || "[]");
        // A building is a showcase for its units, so it needs no price of its own.
        pricing = applyVatSettings(
          req.body.listingType === "building" && !req.body.pricing ? {} : JSON.parse(req.body.pricing)
        );
        // The client sends discounts as its own field, separate from
        // pricing -- fold it in here since that's where the schema keeps it
        // (pricing.discounts). This field was previously never read at all,
        // so every discount toggle a host set was silently discarded.
        if (req.body.discounts) {
          pricing.discounts = JSON.parse(req.body.discounts);
        }
        bookingSettings = JSON.parse(req.body.bookingSettings || "{}");
        blockedDates = req.body.blockedDates
          ? JSON.parse(req.body.blockedDates)
          : [];
        timeBlocks = req.body.timeBlocks ? JSON.parse(req.body.timeBlocks) : [];
      } catch (parseError) {
        console.error("JSON Parse Error:", parseError);
        cleanupTempFiles([
          ...(req.files?.images || []),
          ...(req.files?.cqcDocuments || []),
          ...(req.files?.leaseFile || []), // ✅ NEW: Added lease file cleanup
          ...(req.files?.video || []),
        ]);
        return res.status(400).json({
          error: "Invalid JSON format in request body",
          details: parseError.message,
        });
      }

      const title = req.body.title;
      // A room that is not described is described by its title.
      const description = req.body.description || (isUnit ? title : undefined);
      const category = isUnit ? building.category && String(building.category) : req.body.category;
      const subcategory = isUnit ? building.subcategory : req.body.subcategory;
      let categoriesArray = [];
      let subcategoriesArray = [];
      try {
        categoriesArray = req.body.categories ? JSON.parse(req.body.categories) : [];
        subcategoriesArray = req.body.subcategories ? JSON.parse(req.body.subcategories) : [];
      } catch (e) {
        categoriesArray = [];
        subcategoriesArray = [];
      }
      if (isUnit) {
        categoriesArray = (building.categories || []).map(String);
        subcategoriesArray = building.subcategories || [];
      }

      // A room's own details (label, size, capacity, features, whether it is
      // let) -- validated like the building-unit editor always did.
      let unitDetails;
      if (isUnit) {
        const roomFiles = [...(req.files?.images || []), ...(req.files?.cqcDocuments || []), ...(req.files?.leaseFile || []), ...(req.files?.video || [])];
        let sent = {};
        try {
          sent = req.body.unitDetails ? JSON.parse(req.body.unitDetails) : {};
        } catch {
          sent = null;
        }
        const cleaned = cleanUnitDetails(sent);
        if (cleaned.error) {
          cleanupTempFiles(roomFiles);
          return res.status(400).json({ error: cleaned.error });
        }
        unitDetails = cleaned.value;
        const pricingError = roomPricingError(pricing);
        if (pricingError) {
          cleanupTempFiles(roomFiles);
          return res.status(400).json({ error: pricingError });
        }
      }
      // req.body.availability is a JSON-stringified {openDays, openTime,
      // closeTime, minNotice} object from the client (see EditSpace.jsx's
      // PUT for the same shape) -- this used to assign the raw string
      // straight onto the object-typed schema field below, which Mongoose
      // silently coerced to all-defaults, so no listing's open days/hours
      // were ever actually saved despite the step being required.
      let availability = "all";
      if (req.body.availability) {
        try {
          availability = JSON.parse(req.body.availability);
        } catch {
          availability = "all";
        }
      }
      let deposit = { enabled: false, amount: 0 };
      if (req.body.deposit) {
        try {
          const parsed = JSON.parse(req.body.deposit);
          deposit = { enabled: !!parsed.enabled, amount: parsed.enabled ? Number(parsed.amount) || 0 : 0 };
        } catch {
          deposit = { enabled: false, amount: 0 };
        }
      }
      // Payments v2 damage-deposit policy (integer pence); ignored by the app
      // unless PAYMENTS_V2 is enabled.
      let depositPolicy;
      if (req.body.depositPolicy) {
        try {
          depositPolicy = normaliseDepositPolicy(JSON.parse(req.body.depositPolicy));
        } catch {
          depositPolicy = undefined;
        }
      }
      const host = isUnit ? building.host : req.user.id;

      // Optional iCal feed URL set during creation (same field the
      // PropertyAvailability/EditSpace pages patch later) -- validated the
      // same way as that PATCH route.
      const icalUrl = req.body.icalUrl && String(req.body.icalUrl).trim();
      if (icalUrl && !/^https?:\/\//i.test(icalUrl)) {
        return res.status(400).json({ error: "iCal URL must start with http:// or https://" });
      }

      const minBookingHours = parseMinBookingHours(req.body.minBookingHours);
      if (minBookingHours === null) {
        return res.status(400).json({ error: MIN_BOOKING_HOURS_ERROR });
      }

      // Optional listing-specific terms (separate from the platform-wide
      // Terms & Conditions) -- plain text, not required.
      const listingTerms = typeof req.body.listingTerms === "string" ? req.body.listingTerms.trim() : "";

      if (req.body.listingType !== undefined && !["single", "building", "unit"].includes(req.body.listingType)) {
        cleanupTempFiles([
          ...(req.files?.images || []),
          ...(req.files?.cqcDocuments || []),
          ...(req.files?.leaseFile || []),
          ...(req.files?.video || []),
        ]);
        return res.status(400).json({ error: "listingType must be single, building or unit" });
      }

      // ── Required fields check ──
      if (!title || !description) {
        cleanupTempFiles([
          ...(req.files?.images || []),
          ...(req.files?.cqcDocuments || []),
          ...(req.files?.leaseFile || []), // ✅ NEW: Added lease file cleanup
          ...(req.files?.video || []),
        ]);
        return res.status(400).json({
          error: "Missing required fields: title and description are required",
        });
      }

      // ── Category / Subcategory validation ──
      if (!isUnit && category?.trim()) {
        const categoryDoc = await Category.findById(category);
        if (!categoryDoc) {
          cleanupTempFiles([
            ...(req.files?.images || []),
            ...(req.files?.cqcDocuments || []),
            ...(req.files?.leaseFile || []), // ✅ NEW: Added lease file cleanup
            ...(req.files?.video || []),
          ]);
          return res.status(404).json({ error: "Category not found" });
        }
      }

      if (!isUnit && categoriesArray.length > 0) {
        const foundCategories = await Category.find({ _id: { $in: categoriesArray } });
        if (foundCategories.length !== categoriesArray.length) {
          cleanupTempFiles([
            ...(req.files?.images || []),
            ...(req.files?.cqcDocuments || []),
            ...(req.files?.leaseFile || []),
            ...(req.files?.video || []),
          ]);
          return res.status(400).json({ error: "One or more category IDs are invalid" });
        }
      }

      // ── User validation ──
      const user = await User.findById(req.user.id);
      if (!user) {
        return res
          .status(401)
          .json({ success: false, message: "User not found" });
      }
      if (!user.isVerified) {
        return res.status(403).json({
          success: false,
          message: "You must verify your account before creating a property",
        });
      }

      // ── Required profile fields ──
      const requiredFields = [
        "lastName",
        "firstName",
        "phoneNumber",
        "address",
        "profileImage",
        "payoutMethods",
        "dob",
      ];
      /*
      const missingFields = requiredFields.filter(
        (field) => !user[field] || user[field].toString().trim() === ""
      );
      if (missingFields.length > 0) {
        const fieldLabels = {
          lastName: "Last name",
          firstName: "First name",
          phoneNumber: "Phone number",
          address: "Address",
          profileImage: "Profile image",
          payoutMethods: "Payout method",
          dob: "Date of birth",
        };
        const readableFields = missingFields.map(
          (field) => fieldLabels[field] || field
        );
        const message =
          readableFields.length === 1
            ? `Please provide your ${readableFields[0]} before creating a property`
            : `Please provide the following fields before creating a property: ${readableFields.join(
                ", "
              )}`;

        return res.status(403).json({
          success: false,
          message,
          missingFields,
        });
      }
      */

      // ── Handle image upload to R2 ──
      let r2ImageUrls = [];
      const imageFiles = req.files?.images || [];
      if (isUnit) {
        let keptCount = 0;
        try {
          keptCount = JSON.parse(req.body.existingImages || "[]").length;
        } catch {
          keptCount = 0;
        }
        if (imageFiles.length + keptCount > MAX_ROOM_PHOTOS) {
          cleanupTempFiles([...imageFiles, ...(req.files?.cqcDocuments || []), ...(req.files?.leaseFile || []), ...(req.files?.video || [])]);
          return res.status(400).json({ error: `A room can have at most ${MAX_ROOM_PHOTOS} photos` });
        }
      }
      if (imageFiles.length > 0) {
        try {
          r2ImageUrls = await uploadFilesToR2(imageFiles);
        } catch (uploadError) {
          console.error("Error uploading to R2:", uploadError);
          return res.status(500).json({
            error: "Failed to upload images",
            details: uploadError.message,
          });
        }
      }

      // ── Handle CQC document upload ──
      let cqcDocumentUrls = [];
      const cqcFiles = req.files?.cqcDocuments || [];
      if (cqcFiles.length > 0) {
        try {
          cqcDocumentUrls = await uploadFilesToR2(cqcFiles);
        } catch (uploadError) {
          console.error("Error uploading CQC documents to R2:", uploadError);
          return res.status(500).json({
            error: "Failed to upload CQC documents",
            details: uploadError.message,
          });
        }
      }

      // ✅ NEW: Handle lease agreement upload
      // A room has no lease of its own: it is under its building's.
      let leaseAgreementUrl = isUnit ? null : req.body.existingLeaseAgreement || null;
      const leaseFiles = isUnit ? [] : req.files?.leaseFile || [];
      if (isUnit) cleanupTempFiles(req.files?.leaseFile);
      if (leaseFiles.length > 0) {
        try {
          const uploadedLeaseUrls = await uploadFilesToR2(leaseFiles);
          leaseAgreementUrl = uploadedLeaseUrls[0]; // Only one file expected
        } catch (uploadError) {
          console.error("Error uploading lease agreement to R2:", uploadError);
          return res.status(500).json({
            error: "Failed to upload lease agreement",
            details: uploadError.message,
          });
        }
      }

      // Handle video tour upload
      let videoUrl = req.body.existingVideo || null;
      const videoFiles = req.files?.video || [];
      if (videoFiles.length > 0) {
        try {
          const uploadedVideoUrls = await uploadFilesToR2(videoFiles);
          videoUrl = uploadedVideoUrls[0];
        } catch (uploadError) {
          console.error("Error uploading video to R2:", uploadError);
          return res.status(500).json({
            error: "Failed to upload video",
            details: uploadError.message,
          });
        }
      }

      // ── Images already uploaded earlier in this session (e.g. resumed from
      // a saved draft) — the client sends their URLs directly since it's the
      // frontend's current form state that reflects any adds/removes, not a
      // stale draft record. ──
      let existingImages = [];
      if (req.body.existingImages) {
        try {
          existingImages = JSON.parse(req.body.existingImages);
        } catch (err) {
          existingImages = [];
        }
      }
      const allImages = [...existingImages, ...r2ImageUrls];

      // ── Photos are required to publish ──
      // Nothing previously enforced this here or on the client's final
      // Publish action (only the wizard's own step-4 gate did, which is
      // bypassable via a resumed draft or back/forward navigation) -- a
      // listing could go live with zero photos and no error at all.
      if (allImages.length === 0 && !isUnit) {
        cleanupTempFiles([
          ...(req.files?.images || []),
          ...(req.files?.cqcDocuments || []),
          ...(req.files?.leaseFile || []),
          ...(req.files?.video || []),
        ]);
        return res.status(400).json({
          error: "Please add at least one photo before publishing your listing.",
        });
      }

      const coverImageIndex = parseInt(req.body.coverImageIndex) || 0;
      const coverImage =
        allImages.length > 0 ? allImages[coverImageIndex] || allImages[0] : isUnit ? undefined : null;

      // ── Validate custom availability ──
      if (
        availability === "custom" &&
        (!timeBlocks || timeBlocks.length === 0)
      ) {
        return res.status(400).json({
          message: "Time blocks are required for custom availability",
        });
      }

      // ── Fill in coordinates if the client didn't send real ones ──
      // (host typed an address without picking a Places autocomplete
      // suggestion, or the picker failed silently) -- without this, the
      // listing publishes fine and shows in search/lists, but never gets a
      // pin on the search page map, which only plots listings with a
      // non-zero lat/lng.
      if (!coordinates?.latitude && !coordinates?.longitude) {
        const geocoded = await geocodeAddress(location || {});
        if (geocoded) coordinates = { ...coordinates, ...geocoded };
      }

      // ── Save property ──
      const slug = await generateUniqueSlug(Property, title);
      const property = new Property({
        ...(isUnit && {
          parentBuilding: building._id,
          parentBuildingTitle: building.title,
          roomSlug: await uniqueRoomSlug(building._id, unitDetails.label || title),
          unitDetails,
        }),
        title,
        slug,
        description,
        whatsIncluded: req.body.whatsIncluded || "",
        location,
        coordinates,
        images: allImages,
        coverImage,
        features: {
          ...features,
          houseRules: features.houseRules || "",
        },
        extras: extras || [],
        pricing,
        bookingSettings,
        host,
        createdBy: req.user.impersonatedBy || req.user.id,
        category: category && category.trim() ? category : undefined,
        subcategory: typeof subcategory === "string" ? subcategory : "",
        categories: categoriesArray,
        subcategories: subcategoriesArray,
        availability,
        deposit,
        depositPolicy,
        timeBlocks,
        unitsCount: isUnit ? 1 : parseInt(req.body.unitsCount, 10) || 1,
        minBookingHours,
        blockedDates: blockedDates.map((d) => ({
          start: new Date(d.start),
          end: new Date(d.end),
          reason: d.reason || "personal",
          unitIndex: d.unitIndex ?? null,
        })),
        cqcDocuments: cqcDocumentUrls,
        leaseAgreement: leaseAgreementUrl, // ✅ NEW: Added lease agreement field
        video: videoUrl,
        icalUrl: icalUrl || undefined,
        listingTerms,
        listingType: isUnit ? "unit" : req.body.listingType === "building" ? "building" : "single",
        isActive: true,
        moderationStatus: "approved",
      });

      const savedProperty = await property.save();

      // Retire the draft this listing was published from -- previously this
      // only happened via a best-effort DELETE call from the client after
      // this request returned (CreateSpace.jsx), which could race with the
      // autosave that created the draft, or fail silently. Doing it here,
      // atomically with creation, is what stops the hourly draft-reminder
      // cron in server.js from emailing hosts about listings they already
      // published.
      if (req.body.draftId) {
        await Draft.deleteOne({ _id: req.body.draftId, host: req.user.id }).catch(
          (err) => console.error("Draft cleanup on publish failed:", err.message)
        );
      }

      // A room is one more room in a building the host already published: no
      // "new space" emails, and it never makes someone a host.
      if (isUnit) {
        const room = roomPayload(savedProperty, building);
        return res.status(201).json({ success: true, message: "Room created successfully", property: room, unit: room });
      }

      // Notify admins of new listing
      try {
        const sendEmail = require("../utils/sendEmail");
        const host = await User.findById(req.user.id).select("firstName lastName displayName email").lean();
        const hostName = host?.displayName || host?.firstName || "A host";
        const categoryDoc = category ? await Category.findById(category).select("name").lean() : null;
        const categoryName = categoryDoc?.name || "Uncategorized";
        const adminEmails = ["vencomeltd@gmail.com", "bashayr.alharthi@outlook.com"];
        const reviewUrl = `https://www.vencome.com/admin?section=listings&review=${savedProperty._id}`;
        sendEmail({
          to: adminEmails,
          subject: `New Space Listed - ${title}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <img src=" https://vencome.com/VenCome.jpg " alt="VenCome" style="height:40px;margin-bottom:24px;" />
              <h2 style="color:#0A1628;">New Space Listed 🏢</h2>
              <p>A new commercial space just went live on VenCome. It's already visible to tenants — this is just for your awareness in case anything about it looks off and needs to be flagged.</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <tr><td style="padding:8px 0;color:#666;">Listing</td><td style="padding:8px 0;font-weight:700;">${title}</td></tr>
                <tr><td style="padding:8px 0;color:#666;">Host</td><td style="padding:8px 0;font-weight:700;">${hostName} (${host?.email || ""})</td></tr>
                <tr><td style="padding:8px 0;color:#666;">Category</td><td style="padding:8px 0;font-weight:700;">${categoryName}</td></tr>
                <tr><td style="padding:8px 0;color:#666;">Location</td><td style="padding:8px 0;font-weight:700;">${location?.city || ""}, ${location?.country || ""}</td></tr>
                <tr><td style="padding:8px 0;color:#666;">Time</td><td style="padding:8px 0;font-weight:700;">${new Date().toLocaleString("en-GB")}</td></tr>
              </table>
              <a href="${reviewUrl}" style="display:inline-block;padding:12px 24px;background:#305CDE;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">View This Space</a>
            </div>
          `,
        }).catch((err) => console.error("Listing notification error:", err.message));
      } catch (notifyErr) {
        console.error("Failed to send listing notification:", notifyErr.message);
      }

      const propertyCount = await Property.countDocuments({
        host: req.user.id,
      });
      if (propertyCount === 1) {
        try {
          await makeUserHost(req.user.id);
        } catch (hostErr) {
          console.error("makeUserHost error:", hostErr);
        }
      }

      res.status(201).json({
        success: true,
        message: "Property created successfully",
        property: savedProperty,
      });

      const displayName = user.displayName || user.firstName || "there";
      sendEmail({
        to: user.email,
        subject: "Your property has been created successfully 🎉",
        html: `
          <div style="font-family: 'Manrope', Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
              <div style="background-color: #f0f0f0; padding: 20px; text-align: center;">
                <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 150px;">
              </div>
              <div style="padding: 30px; color: #333;">
                <h2 style="color: #305CDE; text-align: center; margin-top: 0;">Property Created Successfully 🎉</h2>
                <p>Hi <strong>${displayName}</strong>,</p>
                <p>Your property has been successfully created on <strong>VenCome</strong>. Here are the details:</p>
                <div style="background-color: #f5f7ff; padding: 20px; margin: 25px 0; border-radius: 8px;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Property name</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                        property.title || "—"
                      }</td>
                    </tr>
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Location</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                        property.location.city || ""
                      }${
          property.location.country ? `, ${property.location.country}` : ""
        }</td>
                    </tr>
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Created on</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${new Date(
                        savedProperty.createdAt
                      ).toLocaleDateString()}</td>
                    </tr>
                  </table>
                </div>
                <p>You can now update availability, pricing, and amenities from your dashboard.</p>
                <p style="margin-bottom: 0;">If you didn't create this property, please contact our support team immediately.</p>
              </div>
              <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
                This is an automated message, please do not reply.<br />
                © ${new Date().getFullYear()} VenCome. All rights reserved.
              </div>
            </div>
          </div>
        `,
      });
    } catch (err) {
      console.error("Error creating property:", err);
      cleanupTempFiles([
        ...(req.files?.images || []),
        ...(req.files?.cqcDocuments || []),
        ...(req.files?.leaseFile || []), // ✅ NEW: Added lease file cleanup
        ...(req.files?.video || []),
      ]);
      res.status(500).json({ error: "Server error", details: err.message });
    }
};
router.post("/", auth, validatePricing, listingUpload, createListingHandler);

// ✅ Get all properties (paginated)
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const hostId = req.query.host;

    // Homepage's Featured Listings section hits this on every load
    // (GET /properties?limit=8) with no caching -- unlike /search and the
    // single-property route, which both cache for 600s. Same TTL-only
    // pattern here (no active invalidation on write, same as /search).
    const cacheKey = `properties:page:${page}:limit:${limit}${hostId ? `:host:${hostId}` : ""}`;
    const cached = await client.get(cacheKey);
    if (cached) {
      // Entries cached before hosts were made public still carry the flags.
      const payload = JSON.parse(cached);
      return res.json({ success: true, ...payload, properties: payload.properties?.map(publicListing), cached: true });
    }

    const filter = { isActive: true, ...(await publicListingFilter()), ...(hostId && { host: hostId }) };

    // Missing entirely before -- this is what Homepage.jsx's Featured
    // Listings section calls (GET /properties?limit=8), so an unpublished
    // listing kept showing there (and here generally) even though isActive
    // was correctly set to false by PATCH /:id/status.
    const [properties, total] = await Promise.all([
      // blockedDates can hold thousands of entries per listing (one had
      // 287 KB of them) and list views never show a calendar -- leave it out.
      Property.find(filter)
        .select("-blockedDates")
        .populate(publicHostPopulate("firstName lastName displayName profileImage"))
        .populate("category", "name")
        .populate("categories", "name")
        .sort({ order: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Property.countDocuments(filter),
    ]);

    const responsePayload = {
      count: properties.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      properties: await attachBuildingStats(properties),
    };

    await client.setEx(cacheKey, 600, JSON.stringify(responsePayload));

    res.json({ success: true, ...responsePayload });
  } catch (err) {
    console.error("Error fetching properties:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Great-circle distance in km from a fixed point to the listing's
// coordinates, as an aggregation expression so MongoDB can sort every
// active listing by distance (coordinates are plain {latitude, longitude}
// numbers with no geo index, so $geoNear isn't available). null when the
// listing has no coordinates yet.
function distanceKmExpression(lat, lng) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const lat2 = { $degreesToRadians: "$coordinates.latitude" };
  const halfDLat = { $divide: [{ $subtract: [lat2, toRad(lat)] }, 2] };
  const halfDLng = { $divide: [{ $degreesToRadians: { $subtract: ["$coordinates.longitude", lng] } }, 2] };
  const a = {
    $add: [
      { $pow: [{ $sin: halfDLat }, 2] },
      { $multiply: [Math.cos(toRad(lat)), { $cos: lat2 }, { $pow: [{ $sin: halfDLng }, 2] }] },
    ],
  };
  return {
    $cond: [
      { $and: [{ $isNumber: "$coordinates.latitude" }, { $isNumber: "$coordinates.longitude" }] },
      { $multiply: [2 * 6371, { $asin: { $sqrt: { $min: [a, 1] } } }] },
      null,
    ],
  };
}

// Homepage's "Popular Spaces Near You" reused the exact same unsorted
// /properties fetch as "Featured Spaces" -- no location logic at all, so it
// showed the same admin-drag-order/creation-date list to every visitor
// regardless of where they actually are. This geolocates the visitor by IP
// (geoip-lite, same package/pattern already used for admin visitor
// analytics -- no browser permission prompt, unlike navigator.geolocation)
// and sorts active listings by real distance from that point. Falls back to
// unsorted (sorted: false) when the IP can't be geolocated (localhost in
// dev, some VPNs/proxies) so the section still shows something.
router.get("/near-me", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const geo = geoip.lookup(ip);

    const listQuery = (filter) =>
      Property.find(filter)
        .select("-blockedDates") // list view, see GET / above
        .populate(publicHostPopulate("firstName lastName displayName profileImage"))
        .populate("category", "name")
        .populate("categories", "name");

    if (!geo?.ll) {
      const properties = await listQuery({ isActive: true, ...(await publicListingFilter()) }).limit(100);
      return res.json({ success: true, properties: await attachBuildingStats(properties), sorted: false });
    }

    // The nearest 100 of all active listings, sorted in the database.
    // Listings without coordinates yet (geocoding gap) sink to the end
    // rather than being dropped, so they're still discoverable.
    const [visitorLat, visitorLng] = geo.ll;
    const nearest = await Property.aggregate([
      { $match: { isActive: true, ...(await publicListingFilter()) } },
      { $project: { distance: distanceKmExpression(visitorLat, visitorLng) } },
      { $addFields: { hasDistance: { $cond: [{ $eq: ["$distance", null] }, 0, 1] } } },
      { $sort: { hasDistance: -1, distance: 1, _id: 1 } },
      { $limit: 100 },
    ]);
    const order = new Map(nearest.map((n, i) => [String(n._id), i]));
    const properties = (await listQuery({ _id: { $in: nearest.map((n) => n._id) } }))
      .sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));

    res.json({
      success: true,
      properties: await attachBuildingStats(properties),
      sorted: true,
      visitorCity: geo.city || null,
    });
  } catch (err) {
    console.error("Error fetching near-me properties:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Live city counts for the homepage "Browse by City" section — only
// countries/cities with at least one active listing are returned, so the
// frontend never has to show an empty city/country.
router.get("/cities", async (req, res) => {
  try {
    const rows = await Property.aggregate([
      { $match: { isActive: true, ...(await publicListingFilter()) } },
      {
        $group: {
          _id: { country: "$location.country", city: "$location.city" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const byCountry = {};
    for (const row of rows) {
      const country = row._id.country || "Other";
      const city = row._id.city;
      if (!city) continue;
      if (!byCountry[country]) byCountry[country] = [];
      byCountry[country].push({ name: city, count: row.count });
    }

    const countries = Object.entries(byCountry)
      .map(([country, cities]) => ({
        country,
        totalListings: cities.reduce((sum, c) => sum + c.count, 0),
        cities,
      }))
      .sort((a, b) => b.totalListings - a.totalListings);

    res.json({ success: true, countries });
  } catch (err) {
    console.error("Error fetching city counts:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Same shape as /cities above but grouped by the optional, host-fillable
// location.neighborhood field instead -- powers the location half of the
// /:subcategorySlug/:locationSlug landing pages. Empty values are skipped
// since most existing listings don't have this filled in yet.
router.get("/neighborhoods", async (req, res) => {
  try {
    const rows = await Property.aggregate([
      { $match: { isActive: true, ...(await publicListingFilter()), "location.neighborhood": { $nin: [null, ""] } } },
      { $group: { _id: "$location.neighborhood", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    const neighborhoods = rows.map((row) => ({
      name: row._id,
      slug: generateSlug(row._id),
      count: row.count,
    }));
    res.json({ success: true, neighborhoods });
  } catch (err) {
    console.error("Error fetching neighborhood counts:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Listings matching a specific service (subcategory) in a specific area --
// powers the /:subcategorySlug/:locationSlug landing pages. Matches
// location.neighborhood by comparing its slugified form against
// locationSlug, since neighborhood is stored as free text (e.g. "Islington")
// but the URL segment is slugified ("islington").
router.get("/by-service-location", async (req, res) => {
  try {
    const { subcategory, locationSlug } = req.query;
    if (!subcategory || !locationSlug) {
      return res.status(400).json({ error: "subcategory and locationSlug are required" });
    }

    const candidates = await Property.find({
      $or: [{ subcategory }, { subcategories: subcategory }],
      isActive: true,
      ...(await publicListingFilter()),
    })
      .populate(publicHostPopulate("firstName lastName displayName profileImage"))
      .populate("category", "name slug")
      .select("-__v");

    const properties = candidates.filter(
      (p) => p.location?.neighborhood && generateSlug(p.location.neighborhood) === locationSlug
    );

    res.json({ success: true, properties: await attachBuildingStats(properties) });
  } catch (err) {
    console.error("Error fetching service+location listings:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Search properties
router.get("/search", async (req, res) => {
  const {
    query: searchQuery,
    location,
    category,
    subcategory,
    minPrice,
    maxPrice,
    checkIn,
    checkOut,
    duration,
  } = req.query;

  const cacheKey = `search:${[
    searchQuery || "",
    location || "",
    category || "",
    subcategory || "",
    minPrice || "",
    maxPrice || "",
    checkIn || "",
    checkOut || "",
    duration || "",
  ].join(":")}`;

  try {
    const cached = await client.get(cacheKey);
    if (cached) {
      // Entries cached before hosts were made public still carry the flags.
      const payload = JSON.parse(cached);
      return res.json({ success: true, ...payload, properties: payload.properties?.map(publicListing), cached: true });
    }

    // Never returned unpublished listings -- unlike the other property
    // list routes (the aggregate route below, the sitemap route), this
    // one had no isActive filter at all, so unpublishing a listing via
    // My Listings never actually removed it from search/category
    // browsing/"Browse by City", only from the /properties/:id detail
    // page (which does check isActive) and the homepage's aggregate feed.
    let query = { isActive: true, ...(await publicListingFilter()) };

    const searchTerm = searchQuery || location;

    if (searchTerm) {
      // Escape regex metacharacters -- searchTerm is raw user input, and an
      // unescaped "(", "*", etc. throws inside new RegExp(), 500ing the
      // whole search for anyone who types one (found via a systematic
      // search-query test pass; special characters should just be matched
      // as literal text, not break the query).
      const escapedSearchTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escapedSearchTerm, "i");

      // Same test pass found that typing an exact category name (e.g.
      // "Beauty & Cosmetics") returned 0 results even with real listings in
      // it -- category/categories store the Category ObjectId, not its
      // name, so text search never matched them. Look up which categories'
      // names match the term, then match listings tagged with any of them.
      const matchingCategoryIds = (
        await Category.find({ name: regex }).select("_id")
      ).map((c) => c._id);

      query.$or = [
        { title: regex },
        { description: regex },
        // "Browse by City" (and typing a city into the main search box) sends
        // the city name as this same `location`/`query` param, but it was
        // never actually matched against the property's location fields —
        // only title/description — so clicking a city with real listings
        // returned 0 results unless that city name happened to also appear
        // in a listing's title or description text.
        { "location.city": regex },
        { "location.country": regex },
        { "location.address": regex },
        // subcategory/subcategories store the subcategory name as plain
        // text already, so these match directly.
        { subcategory: regex },
        { subcategories: regex },
        ...(matchingCategoryIds.length > 0
          ? [
              { category: { $in: matchingCategoryIds } },
              { categories: { $in: matchingCategoryIds } },
            ]
          : []),
      ];
    }

    if (category) {
      const categoryExists = await Category.findById(category);
      if (!categoryExists)
        return res.status(400).json({ error: "Invalid category ID" });
      query.$or = [
        ...(query.$or || []),
        { category: category },
        { categories: category },
      ];
    }

    if (subcategory) {
      query.$and = [
        ...(query.$and || []),
        { $or: [{ subcategory: subcategory }, { subcategories: subcategory }] },
      ];
    }

    if (minPrice || maxPrice) {
      query["pricing.weekdayPrice"] = {};
      if (minPrice) query["pricing.weekdayPrice"].$gte = Number(minPrice);
      if (maxPrice) query["pricing.weekdayPrice"].$lte = Number(maxPrice);
    }

    // Duration filter — maps slug to a min/max day range
    // Assumes properties have a `minRentalDays` field (adjust to your schema)
    const DURATION_RANGES = {
      less_than_1_month: { max: 29 },
      "1_to_3_months": { min: 30, max: 90 },
      "3_to_12_months": { min: 91, max: 364 },
      "12_plus_months": { min: 365 },
    };

    if (duration && DURATION_RANGES[duration]) {
      const { min, max } = DURATION_RANGES[duration];
      query["minRentalDays"] = {};
      if (min !== undefined) query["minRentalDays"].$gte = min;
      if (max !== undefined) query["minRentalDays"].$lte = max;
    }

    // Date-range availability (checkIn/checkOut) can't be expressed as a
    // single Mongo query filter anymore now that a listing can have more
    // than one bookable unit (Property.unitsCount) -- excluding "any
    // overlap" would wrongly hide a 5-chair listing the moment 1 chair is
    // booked. Fetch candidates first, then filter in memory using the same
    // occupancy logic routes/bookings.js uses for the actual booking
    // conflict check, so both stay consistent. Data scale here is small
    // (property count, not booking count), so this is cheap.
    let requestedStart = null;
    let requestedEnd = null;
    if (checkIn && checkOut) {
      const parsedStart = new Date(checkIn);
      const parsedEnd = new Date(checkOut);
      if (!Number.isNaN(parsedStart.getTime()) && !Number.isNaN(parsedEnd.getTime())) {
        requestedStart = parsedStart;
        requestedEnd = parsedEnd;
      }
    }

    let properties = await Property.find(query)
      .populate(publicHostPopulate("firstName lastName displayName profileImage"))
      .populate("category", "name")
      .populate("categories", "name")
      .sort({ createdAt: -1 });

    if (requestedStart && requestedEnd) {
      const availability = await Promise.all(
        properties.map((property) => getUnitOccupancy(property, requestedStart, requestedEnd))
      );
      properties = properties.filter(
        (property, index) => !isFullyBooked(availability[index], property.unitsCount)
      );
    }

    // blockedDates is needed above for the availability check, but list
    // views never show a calendar and it can be huge -- drop it from the
    // response (toJSON keeps the shape res.json would otherwise produce).
    const listed = properties.map((property) => {
      const json = property.toJSON();
      delete json.blockedDates;
      return json;
    });
    const cards = await attachBuildingStats(listed);
    const responsePayload = { count: cards.length, properties: cards };

    await client.setEx(cacheKey, 600, JSON.stringify(responsePayload));

    res.json({ success: true, ...responsePayload, cached: false });
  } catch (err) {
    console.error("Error searching properties:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Get all saved properties for the logged-in user
router.get("/saved/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate({
      path: "savedProperties",
      populate: { path: "category", select: "name" },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      success: true,
      properties: user.savedProperties || [],
    });
  } catch (err) {
    console.error("Error fetching saved properties:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Get authenticated user's own listings (incl. unpublished)
router.get("/me", auth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    const [properties, total] = await Promise.all([
      Property.find({ host: req.user.id, ...NOT_UNIT })
        .populate("category", "name")
        .populate("categories", "name")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Property.countDocuments({ host: req.user.id, ...NOT_UNIT }),
    ]);

    res.json({
      success: true,
      count: properties.length,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      properties: await attachBuildingStats(properties),
    });
  } catch (err) {
    console.error("Error fetching user properties:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Host analytics — revenue, bookings, occupancy for the logged-in host
router.get("/analytics/me", auth, async (req, res) => {
  try {
    const Booking = require("../models/Booking");
    const hostId = req.user.id;

    const properties = await Property.find({ host: hostId }).select(
      "_id title coverImage"
    );
    const propertyIds = properties.map((p) => p._id);

    const bookings = await Booking.find({
      property: { $in: propertyIds },
    }).select("property totalPrice hostAmount status checkIn checkOut createdAt");

    const completedBookings = bookings.filter((b) =>
      ["confirmed", "completed"].includes(b.status)
    );

    const totalRevenue = completedBookings.reduce(
      (sum, b) => sum + (b.hostAmount || b.totalPrice * 0.9 || 0),
      0
    );
    const totalBookings = completedBookings.length;
    const pendingBookings = bookings.filter((b) => b.status === "pending").length;
    const cancelledBookings = bookings.filter((b) =>
      ["declined", "cancelled"].includes(b.status)
    ).length;
    const avgBookingValue = totalBookings > 0
      ? totalRevenue / totalBookings
      : 0;

    // Revenue per listing
    const listingStats = properties.map((property) => {
      const propertyBookings = completedBookings.filter(
        (b) => b.property.toString() === property._id.toString()
      );
      const revenue = propertyBookings.reduce(
        (sum, b) => sum + (b.hostAmount || b.totalPrice * 0.9 || 0),
        0
      );
      return {
        propertyId: property._id,
        title: property.title,
        coverImage: property.coverImage,
        bookings: propertyBookings.length,
        revenue,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    // Monthly trend — last 6 months
    const now = new Date();
    const monthlyData = [];
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthLabel = monthDate.toLocaleDateString("en-GB", { month: "short" });
      const monthBookings = completedBookings.filter((b) => {
        const bDate = new Date(b.createdAt);
        return (
          bDate.getMonth() === monthDate.getMonth() &&
          bDate.getFullYear() === monthDate.getFullYear()
        );
      });
      const monthRevenue = monthBookings.reduce(
        (sum, b) => sum + (b.hostAmount || b.totalPrice * 0.9 || 0),
        0
      );
      monthlyData.push({
        month: monthLabel,
        bookings: monthBookings.length,
        revenue: Math.round(monthRevenue),
      });
    }

    res.json({
      success: true,
      totalRevenue: Math.round(totalRevenue),
      totalBookings,
      pendingBookings,
      cancelledBookings,
      avgBookingValue: Math.round(avgBookingValue),
      totalListings: properties.length,
      listingStats,
      monthlyData,
    });
  } catch (err) {
    console.error("Error fetching host analytics:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// The public single-listing routes are open to anyone, but an unpublished
// listing is only visible to its own host and to admins -- so they soft-decode
// whoever is asking without requiring a token.
async function softRequester(req) {
  let requesterId = null;
  let requesterIsAdmin = false;
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      requesterId = decoded.id;
      const requester = await User.findById(decoded.id).select("isAdmin");
      requesterIsAdmin = Boolean(requester?.isAdmin);
    } catch (_) {
      // invalid/expired token -- treat the request as anonymous rather than failing it
    }
  }
  return { requesterId, requesterIsAdmin };
}

const withListingRelations = (query) =>
  query
    .populate(publicHostPopulate("firstName lastName displayName profileImage slug"))
    .populate("category", "name")
    .populate("categories", "name")
    .populate({
      path: "reviews",
      populate: {
        path: "user",
        select: "firstName lastName displayName profileImage",
      },
    });

// A room (unit) as a guest reads it: the full listing plus what it takes from
// its building -- location, category and lease agreement -- the building's
// photos when it has none of its own, and its URL.
function roomPayload(unit, building) {
  const b = building.toObject ? building.toObject() : building;
  return {
    ...(unit.toJSON ? unit.toJSON() : unit),
    ...roomPhotos(unit, b),
    location: b.location,
    coordinates: b.coordinates,
    category: b.category,
    subcategory: b.subcategory,
    categories: b.categories,
    subcategories: b.subcategories,
    leaseAgreement: b.leaseAgreement ?? null,
    parentBuilding: { _id: b._id, slug: b.slug, title: b.title },
    isBuildingUnit: true,
    path: roomPath(b, unit),
  };
}

// Who may see a room: anyone, while the room and its building are published.
// Returns the payload, or null for a 404.
async function visibleRoom(unit, { requesterId, requesterIsAdmin }) {
  const isOwner = Boolean(requesterId) && String(unit.host?._id || unit.host) === requesterId;
  if (!unit.isActive && !isOwner && !requesterIsAdmin) return null;
  const building = await Property.findById(unit.parentBuilding).populate("category", "name").populate("categories", "name");
  if (!building || (!building.isActive && !isOwner && !requesterIsAdmin)) return null;
  return roomPayload(unit, building);
}

const isObjectId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value));

// ✅ Get a room by its building's and its own slug (or ids): the room as a
// full listing, plus parentBuilding { _id, slug, title } and isBuildingUnit.
router.get("/:buildingId/rooms/:roomId", async (req, res) => {
  try {
    const { buildingId, roomId } = req.params;
    const requester = await softRequester(req);
    const building = await (isObjectId(buildingId) ? Property.findById(buildingId) : Property.findOne({ slug: buildingId }));
    if (!building || building.listingType !== "building") return res.status(404).json({ error: "Property not found" });
    const room = await withListingRelations(
      Property.findOne({
        parentBuilding: building._id,
        listingType: "unit",
        $or: [{ roomSlug: roomId }, ...(isObjectId(roomId) ? [{ _id: roomId }] : [])],
      })
    );
    const payload = room && (await visibleRoom(room, requester));
    if (!payload) return res.status(404).json({ error: "Property not found" });
    res.json({ success: true, property: payload, cached: false });
  } catch (err) {
    console.error("Error fetching room:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Get single property
router.get("/:id", async (req, res) => {
  const propertyId = req.params.id;

  try {
    const requester = await softRequester(req);
    const { requesterId, requesterIsAdmin } = requester;

    // The cache has no notion of "who's asking", so a draft can never be
    // served from it -- caching it risks handing it to the next anonymous
    // visitor who hits the same URL. Cache hits are skipped entirely for
    // inactive listings and only re-populated below when active.
    const cached = await client.get(`property:${propertyId}`);
    if (cached) {
      const cachedProperty = JSON.parse(cached);
      // Units are never cached: their reply depends on the building's state.
      if (cachedProperty.isActive && cachedProperty.listingType !== "unit") {
        const publicProperty = publicListing(cachedProperty);
        if (publicProperty.listingType !== "building") return res.json({ success: true, property: publicProperty, cached: true });
        // A building shows only once it has an active room (its owner and admins always see it).
        const detail = await buildingUnitsDetail(publicProperty);
        const isOwner = Boolean(requesterId) && String(cachedProperty.host?._id || cachedProperty.host) === requesterId;
        if (!detail.units.length && !isOwner && !requesterIsAdmin) return res.status(404).json({ error: "Property not found" });
        return res.json({ success: true, property: { ...publicProperty, ...detail }, cached: true });
      }
    }

    // The URL param may be either a slug (SEO-friendly links) or a raw
    // ObjectId (older shared/indexed links, emails, sitemap entries created
    // before slugs existed) -- accept both so neither breaks.
    const baseQuery = isObjectId(propertyId)
      ? Property.findById(propertyId)
      : Property.findOne({ slug: propertyId });

    const property = await withListingRelations(baseQuery);

    if (!property) {
      return res.status(404).json({ error: "Property not found" });
    }

    if (!property.isActive) {
      const isOwner = requesterId && property.host?._id?.toString() === requesterId;
      if (!isOwner && !requesterIsAdmin) {
        // Same response as a genuinely missing property -- don't reveal
        // that a draft exists at this URL to anyone but its host/admins.
        return res.status(404).json({ error: "Property not found" });
      }
    }

    // A room is read exactly as GET /:building/rooms/:room returns it (old
    // links to a room's id or slug keep working; the client redirects them to
    // the room's own path). Never cached: it depends on its building's state.
    if (property.listingType === "unit") {
      const payload = await visibleRoom(property, requester);
      if (!payload) return res.status(404).json({ error: "Property not found" });
      return res.json({ success: true, property: payload, cached: false });
    }

    // A building is hidden from the public until it has at least one active
    // room (its owner and admins always see it).
    let buildingDetail;
    if (property.listingType === "building") {
      buildingDetail = await buildingUnitsDetail(property);
      const isOwner = Boolean(requesterId) && property.host?._id?.toString() === requesterId;
      if (!buildingDetail.units.length && !isOwner && !requesterIsAdmin) {
        return res.status(404).json({ error: "Property not found" });
      }
    }

    if (property.isActive) {
      await client.setEx(
        `property:${propertyId}`,
        3600,
        JSON.stringify(property)
      );
    }

    res.json({
      success: true,
      property: buildingDetail ? { ...property.toJSON(), ...buildingDetail } : property,
      cached: false,
    });
  } catch (err) {
    console.error("Error fetching property:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid property ID format" });
    }
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Get public availability for a property (blocked + booked dates)
router.get("/:id/availability", async (req, res) => {
  try {
    const property = await Property.findById(req.params.id).select(
      "blockedDates availability bookingSettings"
    );

    if (!property) {
      return res.status(404).json({ error: "Property not found" });
    }

    // Note: blockedDates already includes confirmed bookings — bookings.js pushes
    // a blockedDates entry (tagged with bookingId) on confirmation and pulls it on
    // decline/cancellation, so no separate Booking merge is needed here.
    res.json({
      success: true,
      availability: property.availability,
      blockedDates: property.blockedDates,
      bookingSettings: property.bookingSettings,
    });
  } catch (err) {
    console.error("Error fetching availability:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid property ID format" });
    }
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ====================== BUILDING ROOMS (UNITS) ======================
// A room is a Property with listingType "unit" under a "building": a full
// bookable listing (price, booking settings, availability, discounts, ...)
// with optional photos of its own (else it shows the building's). Its host,
// location and category come from the building, and it has no lease of its
// own. Creating and editing go through the same handlers as any listing
// (POST /properties, PUT /:id); the routes below are thin wrappers for them.

const MAX_ROOM_PHOTOS = 10;

const canManageListing = async (userId, property) => {
  if (property.host.toString() === userId) return true;
  const requester = await User.findById(userId).select("isAdmin");
  return Boolean(requester?.isAdmin);
};

// The building a room is being added to, if the requester may add to it.
async function loadBuildingForRoom(userId, buildingId) {
  if (!buildingId) return { status: 400, error: "parentBuilding is required for a room" };
  if (!isObjectId(buildingId)) return { status: 400, error: "Invalid property ID format" };
  const building = await Property.findById(buildingId);
  if (!building) return { status: 404, error: "Property not found" };
  if (!(await canManageListing(userId, building))) {
    return { status: 403, error: "Unauthorized: You are not the host of this property" };
  }
  if (building.listingType !== "building") return { status: 400, error: "Rooms can only be added to a building listing" };
  const roomCount = await Property.countDocuments({ parentBuilding: building._id, listingType: "unit" });
  if (roomCount >= MAX_UNITS_PER_BUILDING) {
    return { status: 400, error: `A building can have at most ${MAX_UNITS_PER_BUILDING} units` };
  }
  return { building };
}

// What a room's pricing must have: a price, and sane term and VAT figures
// (the schema would otherwise fail these with a 500).
function roomPricingError(pricing) {
  if (!["hourly", "daily", "weekly", "monthly", "annual", "weekdayPrice", "hourlyPrice"].some((key) => Number(pricing?.[key]) > 0)) {
    return "A room needs a price";
  }
  const term = pricing.minimumTermMonths;
  if (term !== undefined && term !== null && term !== "" && !(Number.isInteger(Number(term)) && Number(term) >= 2 && Number(term) <= 36)) {
    return "pricing.minimumTermMonths must be a whole number from 2 to 36";
  }
  for (const entry of Object.values(pricing.vat || {})) {
    if (entry && (!(Number(entry.enteredPence) >= 0) || !(Number(entry.ratePct ?? 20) >= 0 && Number(entry.ratePct ?? 20) <= 100))) {
      return "pricing.vat needs enteredPence of 0 or more and ratePct between 0 and 100";
    }
  }
  return null;
}

// The JSON wrappers send nested objects; the shared handlers read JSON text
// (the multipart form the listing editor sends).
const JSON_FORM_FIELDS = [
  "pricing", "discounts", "unitDetails", "bookingSettings", "availability", "blockedDates", "timeBlocks",
  "extras", "deposit", "depositPolicy", "features", "location", "coordinates", "existingImages",
];
const jsonBodyAsForm = (req, _res, next) => {
  for (const key of JSON_FORM_FIELDS) {
    if (req.body?.[key] !== undefined && typeof req.body[key] === "object") req.body[key] = JSON.stringify(req.body[key]);
  }
  next();
};

// ✅ Add a room to a building (building owner or admin): POST /properties for a unit
router.post("/:buildingId/units", auth, listingUpload, jsonBodyAsForm, (req, res) => {
  req.body.listingType = "unit";
  req.body.parentBuilding = req.params.buildingId;
  return createListingHandler(req, res);
});

// ✅ Edit a room (owner or admin): PUT /properties/:id for a unit; only the fields sent change
router.put("/units/:unitId", auth, listingUpload, jsonBodyAsForm, async (req, res) => {
  try {
    if (!isObjectId(req.params.unitId)) return res.status(400).json({ error: "Invalid property ID format" });
    const unit = await Property.findById(req.params.unitId).select("listingType");
    if (!unit || unit.listingType !== "unit") return res.status(404).json({ error: "Unit not found" });
    req.params.id = req.params.unitId;
    return updateListingHandler(req, res);
  } catch (err) {
    console.error("Error updating unit:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Deleting a listing: its photos, the listing, a building's rooms, the cache.
// Existing bookings are left exactly as they are.
async function removeListing(property) {
  if (property.images?.length > 0) {
    try {
      await deleteFilesFromR2(property.images);
    } catch (deleteError) {
      console.error("Error deleting images from R2:", deleteError);
    }
  }

  await property.deleteOne();
  // A building's rooms go with it (and with them their own photos).
  if (property.listingType === "building") {
    const rooms = await Property.find({ parentBuilding: property._id, listingType: "unit" }).select("images");
    for (const room of rooms) {
      if (room.images?.length > 0) await deleteFilesFromR2(room.images);
    }
    await Property.deleteMany({ parentBuilding: property._id, listingType: "unit" });
  }

  await client.del(`property:${property._id}`);
  if (property.slug) await client.del(`property:${property.slug}`);
}

// ✅ Delete a room (owner or admin)
router.delete("/units/:unitId", auth, async (req, res) => {
  try {
    if (!isObjectId(req.params.unitId)) return res.status(400).json({ error: "Invalid property ID format" });
    const unit = await Property.findById(req.params.unitId);
    if (!unit || unit.listingType !== "unit") return res.status(404).json({ error: "Unit not found" });
    if (!(await canManageListing(req.user.id, unit))) {
      return res.status(403).json({ error: "Unauthorized: You are not the host of this property" });
    }
    await removeListing(unit);
    res.status(204).send();
  } catch (err) {
    console.error("Error deleting unit:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Update a property (with R2 upload + cache bust). Also edits a room (unit):
// everything but its location, category and lease, which are its building's.
const updateListingHandler = async (req, res) => {
  try {
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(req.params.id);
    const property = isObjectId
      ? await Property.findById(req.params.id)
      : await Property.findOne({ slug: req.params.id });

    if (!property) {
      cleanupTempFiles([
        ...(req.files?.images || []),
        ...(req.files?.leaseFile || []),
        ...(req.files?.video || []),
      ]);
      return res.status(404).json({ error: "Property not found" });
    }

    const isOwnListing = property.host.toString() === req.user.id;
    if (!isOwnListing) {
      // Not the listing's own host -- still allow if the requester is an
      // admin, so the same EditSpace.jsx page hosts use also works as
      // admin's full listing editor (reused rather than duplicated).
      const requestingUser = await User.findById(req.user.id).select("isAdmin");
      if (!requestingUser?.isAdmin) {
        cleanupTempFiles([
          ...(req.files?.images || []),
          ...(req.files?.leaseFile || []),
          ...(req.files?.video || []),
        ]);
        return res.status(403).json({
          error: "Unauthorized: You are not the host of this property",
        });
      }
    }

    const isUnit = property.listingType === "unit";

    // A host editing their own rejected listing is trying to fix it, which
    // should send it back to the review queue -- but an admin using this
    // same shared editor on someone's listing shouldn't re-flag it for
    // their own future review, so this only applies to the host themselves.
    if (isOwnListing && property.moderationStatus === "rejected") {
      property.moderationStatus = "pending_review";
    }

    // Backfill for listings created before slugs existed -- the slug itself
    // stays stable across edits (never regenerated from an updated title) so
    // existing shared/indexed links never break.
    if (!property.slug) {
      property.slug = await generateUniqueSlug(Property, property.title);
    }

    // Parse JSON fields if provided
    const parseField = (key, label) => {
      if (!req.body[key]) return undefined;
      try {
        return JSON.parse(req.body[key]);
      } catch {
        throw Object.assign(new Error(`Invalid ${label} format`), {
          status: 400,
        });
      }
    };

    let location,
      coordinates,
      features,
      extras,
      pricing,
      bookingSettings,
      blockedDates,
      availability,
      deposit,
      depositPolicy;
    try {
      location = parseField("location", "location");
      coordinates = parseField("coordinates", "coordinates");
      features = parseField("features", "features");
      extras = parseField("extras", "extras");
      pricing = parseField("pricing", "pricing");
      bookingSettings = parseField("bookingSettings", "bookingSettings");
      blockedDates = parseField("blockedDates", "blockedDates");
      deposit = parseField("deposit", "deposit");
      depositPolicy = parseField("depositPolicy", "depositPolicy");
    } catch (e) {
      cleanupTempFiles([
        ...(req.files?.images || []),
        ...(req.files?.cqcDocuments || []),
      ]);
      return res.status(400).json({ error: e.message });
    }

    // A room's location, category and lease are its building's, not editable here.
    if (isUnit) {
      location = undefined;
      coordinates = undefined;
      cleanupTempFiles(req.files?.leaseFile);
    }
    const { title, description } = req.body;
    const category = isUnit ? undefined : req.body.category;

    // A room's own details; only what is sent changes.
    let unitDetails;
    if (isUnit && req.body.unitDetails !== undefined) {
      let sent = null;
      try {
        sent = JSON.parse(req.body.unitDetails);
      } catch {
        sent = null;
      }
      const merged = sent && typeof sent === "object" && !Array.isArray(sent) ? { ...property.unitDetails?.toObject?.(), ...sent } : sent;
      const cleaned = cleanUnitDetails(merged);
      if (cleaned.error) {
        cleanupTempFiles([...(req.files?.images || []), ...(req.files?.leaseFile || []), ...(req.files?.video || [])]);
        return res.status(400).json({ error: cleaned.error });
      }
      unitDetails = cleaned.value;
    }

    const minBookingHours = parseMinBookingHours(req.body.minBookingHours);
    if (minBookingHours === null) {
      cleanupTempFiles([
        ...(req.files?.images || []),
        ...(req.files?.leaseFile || []),
        ...(req.files?.video || []),
      ]);
      return res.status(400).json({ error: MIN_BOOKING_HOURS_ERROR });
    }

    if (req.body.availability) {
      try {
        availability =
          typeof req.body.availability === "string"
            ? JSON.parse(req.body.availability)
            : req.body.availability;
      } catch {
        availability = null;
      }
    }

    if (req.body.bookingSettings) {
      try {
        bookingSettings =
          typeof req.body.bookingSettings === "string"
            ? JSON.parse(req.body.bookingSettings)
            : req.body.bookingSettings;
      } catch {
        bookingSettings = null;
      }
    }

    if (req.body.features) {
      try {
        features =
          typeof req.body.features === "string"
            ? JSON.parse(req.body.features)
            : req.body.features;
      } catch {
        features = null;
      }
    }

    if (category && category.trim()) {
      const categoryExists = await Category.findById(category);
      if (!categoryExists) {
        cleanupTempFiles([
          ...(req.files?.images || []),
          ...(req.files?.cqcDocuments || []),
        ]);
        return res.status(400).json({ error: "Invalid category ID" });
      }
    }

    if (req.files?.images?.length > 0) {
      if (isUnit && property.images.length + req.files.images.length > MAX_ROOM_PHOTOS) {
        cleanupTempFiles(req.files.images);
        return res.status(400).json({ error: `A room can have at most ${MAX_ROOM_PHOTOS} photos` });
      }
      try {
        // If the DELETE /:id/images route auto-unpublished this listing
        // for having zero photos, bring it back now that it has at least
        // one again -- see that route for why it was turned off. (A room
        // needs no photos, so it is never turned off for having none.)
        const wasEmpty = property.images.length === 0;
        const newR2Urls = await uploadFilesToR2(req.files.images);
        property.images = [...property.images, ...newR2Urls];
        if (!property.coverImage) property.coverImage = newR2Urls[0];
        if (wasEmpty && !property.isActive && !isUnit) property.isActive = true;
      } catch (uploadError) {
        console.error("Error uploading to R2:", uploadError);
        return res.status(500).json({
          error: "Failed to upload images",
          details: uploadError.message,
        });
      }
    }

    if (title) property.title = title;
    if (description) property.description = description;
    if (req.body.whatsIncluded !== undefined) {
      property.whatsIncluded = req.body.whatsIncluded;
    }
    if (location) property.location = location;
    if (req.body.subcategory !== undefined && !isUnit) property.subcategory = req.body.subcategory;
    if (coordinates) property.coordinates = coordinates;

    // Same fallback as create -- if the property still has no real
    // coordinates after applying whatever this request sent (address
    // edited without re-picking a Places suggestion, or coordinates were
    // never set to begin with), geocode its current address so it isn't
    // permanently missing from the search page map.
    if (!isUnit && !property.coordinates?.latitude && !property.coordinates?.longitude) {
      const geocoded = await geocodeAddress(property.location || {});
      if (geocoded) property.coordinates = geocoded;
    }
    if (features) {
      const existingFeatures = property.features?.toObject
        ? property.features.toObject()
        : property.features || {};
      property.features = {
        ...existingFeatures,
        capacity: features.capacity ?? existingFeatures.capacity ?? 0,
        amenities: features.amenities ?? existingFeatures.amenities ?? [],
        houseRules: features.houseRules ?? existingFeatures.houseRules ?? "",
      };
      property.markModified("features");
    }
    if (extras) property.extras = extras;
    if (pricing) {
      // (toObject() is undefined when no VAT was ever saved; the empty vat
      // document itself must not be carried over.)
      const savedVat = property.pricing?.vat;
      const nextPricing = applyVatSettings(pricing, savedVat?.toObject ? savedVat.toObject() : savedVat);
      const pricingError = isUnit && roomPricingError(nextPricing);
      if (pricingError) {
        cleanupTempFiles([...(req.files?.images || []), ...(req.files?.video || [])]);
        return res.status(400).json({ error: pricingError });
      }
      property.pricing = nextPricing;
    }
    if (req.body.discounts) {
      try {
        const discounts = JSON.parse(req.body.discounts);
        property.pricing.discounts = { ...(property.pricing.discounts?.toObject?.() || property.pricing.discounts || {}), ...discounts };
        property.markModified("pricing");
      } catch {
        // ignore malformed discounts payload rather than failing the whole update
      }
    }
    if (bookingSettings) property.bookingSettings = bookingSettings;
    if (category) property.category = category;
    if (unitDetails) property.unitDetails = unitDetails;
    if (req.body.unitsCount !== undefined && !isUnit) {
      property.unitsCount = parseInt(req.body.unitsCount, 10) || 1;
    }
    if (minBookingHours !== undefined) property.minBookingHours = minBookingHours;
    // FIX: availability and blockedDates were missing from PUT
    if (availability) property.availability = availability;
    if (deposit) property.deposit = { enabled: !!deposit.enabled, amount: deposit.enabled ? Number(deposit.amount) || 0 : 0 };
    if (depositPolicy) property.depositPolicy = normaliseDepositPolicy(depositPolicy);
    if (blockedDates) {
      // Preserve bookingId/externalEventId/unitIndex -- dropping them here
      // (as this used to) breaks the auto-unblock on decline/cancel, the
      // iCal dedup logic, and now the unit-occupancy tracking too, since
      // EditSpace.jsx round-trips blockedDates through this route on every
      // listing save. Matches the PATCH /:id/availability handler below.
      property.blockedDates = blockedDates.map((d) => ({
        start: new Date(d.start),
        end: new Date(d.end),
        reason: d.reason || "personal",
        bookingId: d.bookingId || undefined,
        externalEventId: d.externalEventId || undefined,
        unitIndex: d.unitIndex ?? null,
      }));
    }
    if (req.body.listingTerms !== undefined) {
      property.listingTerms = String(req.body.listingTerms).trim();
    }

    const leaseFiles = isUnit ? [] : req.files?.leaseFile || [];
    if (leaseFiles.length > 0) {
      try {
        const uploadedLeaseUrls = await uploadFilesToR2(leaseFiles);
        property.leaseAgreement = uploadedLeaseUrls[0]; // Only one file expected
      } catch (uploadError) {
        console.error("Error uploading lease agreement to R2:", uploadError);
        return res.status(500).json({
          error: "Failed to upload lease agreement",
          details: uploadError.message,
        });
      }
    } else if (req.body.existingLeaseAgreement !== undefined && !isUnit) {
      property.leaseAgreement = req.body.existingLeaseAgreement || null;
    }

    const videoFiles = req.files?.video || [];
    if (videoFiles.length > 0) {
      try {
        const uploadedVideoUrls = await uploadFilesToR2(videoFiles);
        property.video = uploadedVideoUrls[0];
      } catch (uploadError) {
        console.error("Error uploading video to R2:", uploadError);
        return res.status(500).json({
          error: "Failed to upload video",
          details: uploadError.message,
        });
      }
    } else if (req.body.existingVideo !== undefined) {
      property.video = req.body.existingVideo || null;
    }

    const updatedProperty = await property.save();

    // A building's rooms carry copies of its title, location and category (for
    // booking emails, commission and the bookings checks) -- keep them in step.
    if (property.listingType === "building") {
      const building = property.toObject();
      const shared = { parentBuildingTitle: building.title, location: building.location, coordinates: building.coordinates, category: building.category, subcategory: building.subcategory, categories: building.categories, subcategories: building.subcategories };
      for (const key of Object.keys(shared)) if (shared[key] === undefined) delete shared[key];
      await Property.updateMany({ parentBuilding: property._id, listingType: "unit" }, { $set: shared });
    }

    // FIX: bust the cache after a successful update
    await client.del(`property:${req.params.id}`);
    if (property.slug) await client.del(`property:${property.slug}`);

    // A room comes back as it is read: with its building's photos if it has none.
    const parent = isUnit ? await Property.findById(property.parentBuilding) : null;
    const returned = parent ? roomPayload(updatedProperty, parent) : updatedProperty;
    res.json({
      success: true,
      message: "Property updated successfully",
      property: returned,
      ...(isUnit && { unit: returned }),
    });
  } catch (err) {
    console.error("Error updating property:", err);
    cleanupTempFiles([
      ...(req.files?.images || []),
      ...(req.files?.cqcDocuments || []),
    ]);
    res.status(500).json({ error: "Server error", details: err.message });
  }
};
router.put("/:id", auth, listingUpload, updateListingHandler);

// ✅ Publish / unpublish a property
router.patch("/:id/status", auth, async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ error: "isActive must be a boolean" });
    }

    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: "Property not found" });

    if (property.host.toString() !== req.user.id) {
      return res.status(403).json({
        error: "Unauthorized: You are not the host of this property",
      });
    }

    // A host can freely toggle their own already-approved listing on/off
    // (that's what this route is for), but can't use it to self-publish a
    // listing that's never been approved, or one an admin rejected -- both
    // still need to actually go through admin review first.
    if (isActive && property.moderationStatus !== "approved") {
      return res.status(400).json({
        error:
          property.moderationStatus === "rejected"
            ? "This listing was not approved. Please update it and it will go back to the review queue."
            : "This listing is still awaiting admin approval before it can go live.",
      });
    }

    property.isActive = isActive;
    await property.save();

    // Bust cache so listing visibility updates immediately
    await client.del(`property:${req.params.id}`);
    if (property.slug) await client.del(`property:${property.slug}`);

    res.json({
      success: true,
      message: `Property ${
        isActive ? "published" : "unpublished"
      } successfully`,
      isActive: property.isActive,
    });
  } catch (err) {
    console.error("Error updating property status:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid property ID format" });
    }
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Update blocked dates only (lightweight alternative to full PUT)
router.patch("/:id/availability", auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: "Property not found" });

    if (property.host.toString() !== req.user.id) {
      return res.status(403).json({
        error: "Unauthorized: You are not the host of this property",
      });
    }

    const { blockedDates, availability, bookingSettings } = req.body;

    if (blockedDates !== undefined) {
      if (!Array.isArray(blockedDates)) {
        return res.status(400).json({ error: "blockedDates must be an array" });
      }
      // Preserve bookingId/externalEventId so booking-derived and iCal-synced
      // blocks stay tagged — dropping them here would break the auto-unblock
      // on decline/cancel and the iCal dedup logic.
      property.blockedDates = blockedDates.map((d) => ({
        start: new Date(d.start),
        end: new Date(d.end),
        reason: d.reason || "personal",
        bookingId: d.bookingId || undefined,
        externalEventId: d.externalEventId || undefined,
        unitIndex: d.unitIndex ?? null,
      }));
    }

    if (availability !== undefined) {
      property.availability = { ...(property.availability?.toObject?.() || property.availability || {}), ...availability };
    }

    if (bookingSettings !== undefined) {
      property.bookingSettings = { ...(property.bookingSettings?.toObject?.() || property.bookingSettings || {}), ...bookingSettings };
    }

    await property.save();
    await client.del(`property:${req.params.id}`);
    if (property.slug) await client.del(`property:${property.slug}`);

    res.json({
      success: true,
      message: "Availability updated successfully",
      blockedDates: property.blockedDates,
      availability: property.availability,
      bookingSettings: property.bookingSettings,
    });
  } catch (err) {
    console.error("Error updating availability:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid property ID format" });
    }
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Set or clear the external calendar (iCal) URL for a listing
router.patch("/:id/calendar-sync", auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: "Property not found" });

    if (property.host.toString() !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized: You are not the host of this property" });
    }

    const { icalUrl } = req.body;
    if (icalUrl && !/^https?:\/\//i.test(icalUrl)) {
      return res.status(400).json({ error: "Calendar URL must start with http:// or https://" });
    }

    property.icalUrl = icalUrl || undefined;
    property.icalLastSyncedAt = undefined;
    property.icalLastSyncError = undefined;
    await property.save();

    res.json({ success: true, icalUrl: property.icalUrl });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Manually trigger a sync of the connected external calendar
router.post("/:id/calendar-sync/run", auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: "Property not found" });

    if (property.host.toString() !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized: You are not the host of this property" });
    }
    if (!property.icalUrl) {
      return res.status(400).json({ error: "No calendar URL connected for this listing" });
    }

    const syncExternalCalendar = require("../utils/syncIcal");
    const result = await syncExternalCalendar(property._id);
    await client.del(`property:${req.params.id}`);
    if (property.slug) await client.del(`property:${property.slug}`);

    res.json({ success: true, ...result, lastSyncedAt: new Date() });
  } catch (err) {
    res.status(500).json({ error: "Failed to sync calendar", details: err.message });
  }
});

// ✅ Duplicate a listing
router.post("/:id/duplicate", auth, async (req, res) => {
  try {
    const original = await Property.findById(req.params.id);
    if (!original) return res.status(404).json({ error: "Property not found" });

    if (original.host.toString() !== req.user.id) {
      return res.status(403).json({
        error: "Unauthorized: You are not the host of this property",
      });
    }
    if (original.listingType === "unit") {
      return res.status(400).json({ error: "A room cannot be duplicated. Add a new room instead." });
    }

    const duplicateData = original.toObject();
    delete duplicateData._id;
    delete duplicateData.createdAt;
    delete duplicateData.updatedAt;
    delete duplicateData.reviews;
    duplicateData.title = `${original.title} (Copy)`;
    duplicateData.isActive = false; // start unpublished so host can review before going live
    // toObject() above copied the original's moderationStatus too -- if the
    // original had been flagged/rejected, that status shouldn't carry over
    // to a fresh duplicate the host hasn't touched yet. Duplicates don't go
    // through admin approval (nothing does, by default) -- they just start
    // unpublished so the host can review their own copy before switching it
    // on with the normal publish toggle.
    duplicateData.moderationStatus = "approved";

    const duplicate = new Property(duplicateData);
    const saved = await duplicate.save();

    res.status(201).json({
      success: true,
      message: "Property duplicated successfully",
      property: saved,
    });
  } catch (err) {
    console.error("Error duplicating property:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid property ID format" });
    }
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Report a listing
router.post("/:id/report", auth, async (req, res) => {
  try {
    const { reason, description } = req.body;

    if (!reason) {
      return res
        .status(400)
        .json({ error: "A reason is required to submit a report" });
    }

    const property = await Property.findById(req.params.id).select(
      "_id title host"
    );
    if (!property) return res.status(404).json({ error: "Property not found" });

    if (property.host.toString() === req.user.id) {
      return res
        .status(400)
        .json({ error: "You cannot report your own property" });
    }

    const REPORT_REASONS = ["spam", "inappropriate", "fraud", "harassment", "fake_listing", "other"];
    const normalizedReason = REPORT_REASONS.includes(reason) ? reason : "other";

    await Report.create({
      reporter: req.user.id,
      type: "property",
      targetId: property._id,
      reason: normalizedReason,
      description: normalizedReason === reason ? description : `${reason}${description ? ": " + description : ""}`,
    });

    // Notify admins by email too, for immediate visibility
    sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `Property reported: ${property.title}`,
      html: `
        <p><strong>Property:</strong> ${property._id} — ${property.title}</p>
        <p><strong>Reported by:</strong> ${req.user.id}</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p><strong>Details:</strong> ${description || "None provided"}</p>
      `,
    });

    res
      .status(201)
      .json({ success: true, message: "Report submitted successfully" });
  } catch (err) {
    console.error("Error submitting report:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid property ID format" });
    }
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Delete a property (with R2 cleanup + cache bust)
router.delete("/:id", auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: "Property not found" });

    if (property.host.toString() !== req.user.id) {
      return res.status(403).json({
        error: "Unauthorized: You are not the host of this property",
      });
    }

    await removeListing(property);
    // The URL may have named it by slug rather than id.
    await client.del(`property:${req.params.id}`);

    // FIX: send email before res.send() so a throw here doesn't crash silently
    const user = await User.findById(req.user.id);
    const displayName = user?.displayName || user?.firstName || "there";
    sendEmail({
      to: user.email,
      subject: "Your property has been deleted",
      html: `
        <div style="font-family: 'Manrope', Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="background-color: #f0f0f0; padding: 20px; text-align: center;">
              <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 150px;">
            </div>
            <div style="padding: 30px; color: #333;">
              <h2 style="color: #305CDE; text-align: center; margin-top: 0;">Property Deleted</h2>
              <p>Hi <strong>${displayName}</strong>,</p>
              <p>This is to confirm that the following property has been successfully deleted from your VenCome account:</p>
              <div style="background-color: #f5f7ff; padding: 20px; margin: 25px 0; border-radius: 8px;">
                <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Property name</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                      property.title || "—"
                    }</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Location</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                      property.location.city || ""
                    }${
        property.location.country ? `, ${property.location.country}` : ""
      }</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #666;">Deleted on</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${new Date().toLocaleDateString()}</td>
                  </tr>
                </table>
              </div>
              <p>Once a property is deleted, it is no longer visible or bookable on VenCome.</p>
              <p style="margin-bottom: 0;">You can create a new property at any time from your dashboard.</p>
            </div>
            <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
              This is an automated message, please do not reply.<br />
              © ${new Date().getFullYear()} VenCome. All rights reserved.
            </div>
          </div>
        </div>
      `,
    });

    res.status(204).send();
  } catch (err) {
    console.error("Error deleting property:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Delete specific images from a property
router.delete("/:id/images", auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: "Property not found" });

    if (property.host.toString() !== req.user.id) {
      const requestingUser = await User.findById(req.user.id).select("isAdmin");
      if (!requestingUser?.isAdmin) {
        return res.status(403).json({
          error: "Unauthorized: You are not the host of this property",
        });
      }
    }

    const { imageUrls } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({
        error: "Please provide an array of image URLs to delete",
      });
    }

    // Hosts asked to be able to clear every photo and start fresh with new
    // uploads, rather than being forced to add a replacement before they're
    // allowed to remove the last old one. A listing with zero photos still
    // shouldn't be visible to guests though, so drop it from public search
    // instead of blocking the deletion -- it comes back automatically the
    // next time the host uploads a photo via the PUT /:id save.
    const remaining = property.images.filter((img) => !imageUrls.includes(img));
    const willBeEmpty = remaining.length === 0 && property.listingType !== "unit";
    if (willBeEmpty) {
      property.isActive = false;
    }

    try {
      await deleteFilesFromR2(imageUrls);
    } catch (deleteError) {
      console.error("Error deleting from R2:", deleteError);
      return res
        .status(500)
        .json({ error: "Failed to delete images from storage" });
    }

    property.images = property.images.filter((img) => !imageUrls.includes(img));
    if (imageUrls.includes(property.coverImage)) {
      property.coverImage =
        property.images.length > 0 ? property.images[0] : null;
    }

    await property.save();

    // Bust cache after image deletion
    await client.del(`property:${req.params.id}`);
    if (property.slug) await client.del(`property:${property.slug}`);

    res.json({
      success: true,
      message: willBeEmpty
        ? "Images deleted. This listing is now unpublished until you add a new photo."
        : "Images deleted successfully",
      unpublished: willBeEmpty,
      property,
    });
  } catch (err) {
    console.error("Error deleting images:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Toggle save/unsave a property
router.post("/:id/save", auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: "Property not found" });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const alreadySaved = user.savedProperties?.some(
      (id) => id.toString() === req.params.id
    );

    if (alreadySaved) {
      user.savedProperties = user.savedProperties.filter(
        (id) => id.toString() !== req.params.id
      );
    } else {
      user.savedProperties = [...(user.savedProperties || []), req.params.id];
    }

    await user.save();

    res.json({
      success: true,
      saved: !alreadySaved,
      savedProperties: user.savedProperties,
    });
  } catch (err) {
    console.error("Error toggling saved property:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Check if a specific property is saved by the logged-in user
router.get("/:id/is-saved", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("savedProperties");
    if (!user) return res.status(404).json({ error: "User not found" });

    const isSaved = user.savedProperties?.some(
      (id) => id.toString() === req.params.id
    );

    res.json({ success: true, isSaved: !!isSaved });
  } catch (err) {
    console.error("Error checking saved status:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
