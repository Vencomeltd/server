const express = require("express");
const { generateInvoicePDF } = require("../utils/generateInvoice");
const Booking = require("../models/Booking");
const Property = require("../models/Property");
const Payment = require("../models/Payment");
const createNotification = require("../utils/notify");
const auth = require("../middleware/auth");
const sendEmail = require("../utils/sendEmail");
const sendSMS = require("../utils/sendSMS");
const User = require("../models/User");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const { randomUUID, createHash } = require("crypto");
const uploadToR2 = require("../utils/uploadService");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { getUnitOccupancy, isFullyBooked, pickAvailableUnit } = require("../utils/unitAvailability");
const {
  calculateDailyPriceWithBreakdown,
  calculateHourlyPriceWithBreakdown,
  resolveDayHours,
} = require("../utils/pricing");
const { resolveCommissionRate } = require("../utils/commission");
const { creditDepositToWallet, refundDeposit } = require("../utils/wallet");
const googleCalendar = require("../utils/googleCalendar");
const outlookCalendar = require("../utils/outlookCalendar");

// Pushes a confirmed booking out to the host's connected Google/Outlook
// calendar so it shows up alongside their other events, with the actual
// check-in/check-out time (not just the date). Only Google and Outlook
// support creating an event this way -- Cal.com, Calendly, and Apple
// Calendar are pull-only on VenCome's side (see their respective utils/*
// files for why), so a booking never pushes out to those three, only pulls
// blocks in from them. Never throws -- calendar sync is a convenience, it
// should never be able to break the booking flow itself.
async function pushBookingToHostCalendars(booking, property) {
  try {
    const hostUser = await User.findById(booking.host).select(
      "googleCalendar outlookCalendar"
    );
    if (!hostUser) return;

    const eventPayload = {
      summary: `VenCome booking — ${property.title}`,
      description: `Booking ref ${booking._id.toString().slice(-8).toUpperCase()} via VenCome.`,
      location: property.location?.address || property.title,
      start: booking.checkIn,
      end: booking.checkOut,
    };

    let changed = false;

    if (!booking.googleCalendarEventId && hostUser.googleCalendar?.connected) {
      try {
        booking.googleCalendarEventId = await googleCalendar.createEvent(
          hostUser.googleCalendar.refreshToken,
          eventPayload
        );
        changed = true;
      } catch (calErr) {
        console.error(`Google Calendar push failed for booking ${booking._id}:`, calErr.message);
      }
    }

    if (!booking.outlookCalendarEventId && hostUser.outlookCalendar?.connected) {
      try {
        booking.outlookCalendarEventId = await outlookCalendar.createEvent(
          hostUser.outlookCalendar.refreshToken,
          eventPayload
        );
        changed = true;
      } catch (calErr) {
        console.error(`Outlook push failed for booking ${booking._id}:`, calErr.message);
      }
    }

    if (changed) await booking.save();
  } catch (err) {
    console.error(`Calendar push error for booking ${booking._id}:`, err.message);
  }
}

const pdfStorage = multer.diskStorage({
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

const uploadPdf = multer({
  storage: pdfStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed"), false);
    }
    cb(null, true);
  },
});

router.post(
  "/",
  auth,
  (req, res, next) => {
    uploadPdf.single("licensePdf")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      } else if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    const extras = JSON.parse(req.body.extras || "[]");
    const { propertyId, checkIn, checkOut, guests, pricingUnit, agreedToTerms } = req.body;
    const guestId = req.user.id;

    // 1. Find property
    const property = await Property.findOne({ _id: propertyId }).populate(
      "host"
    );

    if (!property) {
      return res
        .status(404)
        .json({ error: "Property not found or unavailable" });
    }

    // If the host has set listing-specific terms, the customer must have
    // agreed to them (checkbox ticked in the post-click terms gate on the
    // frontend) before the booking can be created at all. If the listing
    // has no terms, this is skipped entirely -- agreedToTerms won't even be
    // sent by the frontend in that case.
    if (property.listingTerms?.trim() && agreedToTerms !== "true") {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: "You must agree to the host's listing terms before booking.",
      });
    }

    // ✅ CATEGORY CHECK BEFORE ANY PDF UPLOAD
    if (req.file && property.category === "Medical Rooms") {
      // delete uploaded temp file
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

      return res.status(400).json({
        error: "License PDF is only allowed for Medical Rooms properties",
      });
    }

    // 2. Upload PDF to R2 (ONLY if allowed)
    let licensePdfUrl = null;

    if (req.file && property.category === "Medical Rooms") {
      try {
        const result = await uploadToR2(req.file.path, req.file.filename, req.file.mimetype);
        licensePdfUrl = result.location;
      } catch (uploadErr) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(500).json({ error: "Failed to upload license PDF" });
      }
    }

    try {
      // 1. Find property
      const property = await Property.findOne({ _id: propertyId }).populate(
        "host"
      );
      if (!property) {
        return res
          .status(404)
          .json({ error: "Property not found or unavailable" });
      }

      // 2. Parse and validate dates
      const checkInDate = new Date(checkIn);
      const checkOutDate = new Date(checkOut);

      if (isNaN(checkInDate) || isNaN(checkOutDate)) {
        return res.status(400).json({ error: "Invalid date format" });
      }
      if (checkOutDate < checkInDate) {
        return res
          .status(400)
          .json({ error: "Check-out must be after check-in" });
      }
      if (checkOutDate < new Date()) {
        return res.status(400).json({ error: "Cannot book in the past" });
      }

      // 3/4. Prevent double booking -- checks both existing bookings and
      // host-blocked dates together, accounting for Property.unitsCount
      // (identical bookable units, e.g. 5 chairs on one listing) so up to
      // unitsCount overlapping bookings can coexist instead of only 1.
      const occupancy = await getUnitOccupancy(property, checkInDate, checkOutDate);
      if (isFullyBooked(occupancy, property.unitsCount)) {
        return res.status(409).json({ error: "These dates are unavailable" });
      }
      const assignedUnit = pickAvailableUnit(occupancy, property.unitsCount);

      // 5. Check availability setting
      if (property.availability && property.availability !== "all") {
        const days = [];
        const cursor = new Date(checkInDate);
        while (cursor < checkOutDate) {
          days.push(cursor.getDay());
          cursor.setDate(cursor.getDate() + 1);
        }
        if (property.availability === "weekdays") {
          const hasWeekend = days.some((d) => d === 0 || d === 6);
          if (hasWeekend) {
            return res
              .status(409)
              .json({ error: "This space is only available on weekdays" });
          }
        }
        if (property.availability === "weekends") {
          const hasWeekday = days.some((d) => d >= 1 && d <= 5);
          if (hasWeekday) {
            return res
              .status(409)
              .json({ error: "This space is only available on weekends" });
          }
        }
      }

      // 5b. Check open days — if host has set specific days,
      // all booking days must be within those days
      const availOpenDays = property.availability?.openDays || [];
      if (availOpenDays.length > 0) {
        const DAY_MAP = {
          sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
          thursday: 4, friday: 5, saturday: 6,
        };
        const allowedDayNumbers = availOpenDays.map(
          (d) => DAY_MAP[d.toLowerCase()]
        ).filter((d) => d !== undefined);

        if (allowedDayNumbers.length > 0) {
          const bookedDays = [];
          const cur = new Date(checkInDate);
          while (cur < checkOutDate) {
            bookedDays.push(cur.getDay());
            cur.setDate(cur.getDate() + 1);
          }
          const hasClosedDay = bookedDays.some(
            (d) => !allowedDayNumbers.includes(d)
          );
          if (hasClosedDay) {
            return res.status(409).json({
              error: "One or more selected days are outside the space's open days",
            });
          }
        }
      }

      // Resolve daily/hourly price and which duration type this booking
      // actually is. Needed here (not just for pricing below) because the
      // open-hours check right after this must only ever apply to HOURLY
      // bookings -- a per-day/week/month/year booking isn't tied to a
      // single hour-of-day window, so it should never be blocked by one.
      const dailyPrice = Number(property.pricing.weekdayPrice) ||
                         Number(property.pricing.daily) || 0;
      const hourlyPrice = Number(property.pricing.hourlyPrice) ||
                          Number(property.pricing.hourly) || 0;

      // Use explicit pricingUnit from frontend if provided,
      // otherwise fall back to auto-detection
      const effectivePricingType = (() => {
        if (pricingUnit === "hour") return "HOURLY";
        if (pricingUnit === "day") return "DAILY";
        if (pricingUnit === "week") return "WEEKLY";
        if (pricingUnit === "month") return "MONTHLY";
        if (pricingUnit === "year") return "ANNUAL";
        // Fallback: auto-detect from property pricing config
        if (property.pricing.pricingType === "HOURLY") return "HOURLY";
        if (property.pricing.pricingType === "DAILY") {
          return dailyPrice > 0 ? "DAILY" : hourlyPrice > 0 ? "HOURLY" : "DAILY";
        }
        if (dailyPrice > 0) return "DAILY";
        if (hourlyPrice > 0) return "HOURLY";
        return "DAILY";
      })();

      // 5c. Check open hours — only applies to HOURLY bookings. Daily,
      // weekly, monthly, and annual bookings are for the full day(s)
      // selected and must not be blocked by a listing's hour-of-day
      // opening window (that only makes sense for hourly slots).
      // Resolves per-day-of-week hours when the listing uses custom hours
      // (availability.hoursMode === "custom") -- the flat openTime/closeTime
      // above stay empty in that mode, so reading them directly here used to
      // silently skip this check entirely for those listings.
      const dayWindow = resolveDayHours(checkInDate, property.availability);

      if (effectivePricingType === "HOURLY" && dayWindow && dayWindow.openTime && dayWindow.closeTime) {
        const { openTime, closeTime } = dayWindow;
        const [openH, openM] = openTime.split(":").map(Number);
        const [closeH, closeM] = closeTime.split(":").map(Number);

        const checkInH = checkInDate.getUTCHours();
        const checkInMin = checkInDate.getUTCMinutes();
        const checkOutH = checkOutDate.getUTCHours();
        const checkOutMin = checkOutDate.getUTCMinutes();

        const checkInMinutes = checkInH * 60 + checkInMin;
        const checkOutMinutes = checkOutH * 60 + checkOutMin;
        const openMinutes = openH * 60 + openM;
        const closeMinutes = closeH * 60 + closeM;

        if (checkInMinutes < openMinutes || checkOutMinutes > closeMinutes) {
          return res.status(409).json({
            error: `This space is only available between ${openTime} and ${closeTime}`,
          });
        }
      }

      // 6. Calculate total price
      let totalPrice = 0;
      let totalNights = 0;
      let totalHours = 0;
      let totalUnits = 0;
      let priceBreakdown = [];

      const pricingType = property.pricing.pricingType || "DAILY";
      // dailyPrice, hourlyPrice, and effectivePricingType are already
      // resolved above (needed early for the open-hours gate in 5c).

      const diffMs = checkOutDate - checkInDate;
      const diffHours = diffMs / (1000 * 60 * 60);

      const weeklyPrice = Number(property.pricing.weekly) || 0;
      const monthlyPrice = Number(property.pricing.monthly) || 0;
      const annualPrice = Number(property.pricing.annual) || 0;

      if (effectivePricingType === "HOURLY") {
        if (diffHours < 1) {
          return res.status(400).json({ error: "Minimum 1 hour required" });
        }
        if (hourlyPrice <= 0) {
          return res.status(400).json({ error: "Hourly price not configured for this space" });
        }
        totalHours = Math.ceil(diffHours * 10) / 10;
        totalUnits = totalHours;
        {
          const hourlyResult = calculateHourlyPriceWithBreakdown(
            checkInDate,
            totalHours,
            hourlyPrice,
            property.pricing.customDayPricing
          );
          totalPrice = hourlyResult.totalPrice;
          priceBreakdown = hourlyResult.breakdown;
        }

      } else if (effectivePricingType === "DAILY") {
        if (dailyPrice <= 0) {
          return res.status(400).json({ error: "Daily price not configured for this space" });
        }
        // Count calendar days (date difference only, ignore time)
        const checkInDay = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
        const checkOutDay = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
        const calendarDays = Math.round((checkOutDay - checkInDay) / (1000 * 60 * 60 * 24));
        if (property.bookingSettings?.singleDayOnly && calendarDays > 1) {
          return res.status(400).json({
            error: "This space only accepts single-day bookings — please select one calendar day",
          });
        }
        totalNights = Math.max(1, calendarDays);
        totalUnits = totalNights;
        {
          const dailyResult = calculateDailyPriceWithBreakdown(
            checkInDate,
            totalNights,
            dailyPrice,
            property.pricing.customDayPricing
          );
          totalPrice = dailyResult.totalPrice;
          priceBreakdown = dailyResult.breakdown;
        }

      } else if (effectivePricingType === "WEEKLY") {
        if (weeklyPrice <= 0) {
          return res.status(400).json({ error: "Weekly price not configured for this space" });
        }
        const checkInDay = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
        const checkOutDay = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
        const calendarDays = Math.round((checkOutDay - checkInDay) / (1000 * 60 * 60 * 24));
        totalUnits = Math.max(1, Math.ceil(calendarDays / 7));
        const graduated = property.pricing.graduatedWeekly;
        if (graduated?.enabled && graduated.thresholdWeeks > 0 && totalUnits > graduated.thresholdWeeks) {
          const weeksAtBase = graduated.thresholdWeeks;
          const weeksAtSteppedRate = totalUnits - graduated.thresholdWeeks;
          totalPrice = weeksAtBase * weeklyPrice + weeksAtSteppedRate * (graduated.rateAfterThreshold || weeklyPrice);
        } else {
          totalPrice = totalUnits * weeklyPrice;
        }

      } else if (effectivePricingType === "MONTHLY") {
        if (monthlyPrice <= 0) {
          return res.status(400).json({ error: "Monthly price not configured for this space" });
        }
        const checkInDay = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
        const checkOutDay = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
        const calendarDays = Math.round((checkOutDay - checkInDay) / (1000 * 60 * 60 * 24));
        totalUnits = Math.max(1, Math.ceil(calendarDays / 31));
        totalPrice = totalUnits * monthlyPrice;

      } else if (effectivePricingType === "ANNUAL") {
        if (annualPrice <= 0) {
          return res.status(400).json({ error: "Annual price not configured for this space" });
        }
        const checkInDay = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
        const checkOutDay = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());
        const calendarDays = Math.round((checkOutDay - checkInDay) / (1000 * 60 * 60 * 24));
        totalUnits = Math.max(1, Math.ceil(calendarDays / 366));
        totalPrice = totalUnits * annualPrice;

      } else {
        return res.status(400).json({ error: "Invalid pricing type" });
      }

      // 7. Add extras
      const validExtras = Array.isArray(property.extras) ? property.extras : [];
      const selectedExtras = validExtras.filter((e) => extras.includes(e.name));
      const extrasTotal = selectedExtras.reduce(
        (sum, e) => sum + (Number(e.price) || 0),
        0
      );
      totalPrice += extrasTotal;

      // 8. Apply discounts
      let discount = 0;
      if (property.pricing.pricingType === "DAILY") {
        if (property.pricing.discounts?.newListing)
          discount += totalPrice * 0.2;
        // "Booking within a few days of arrival" -- 48h is the common
        // last-minute-deal threshold and matches the discount's own copy
        // in CreateSpace.jsx/EditSpace.jsx ("within a few days of arrival").
        const hoursUntilCheckIn = (checkInDate - new Date()) / (1000 * 60 * 60);
        if (hoursUntilCheckIn <= 48 && property.pricing.discounts?.lastMinute)
          discount += totalPrice * 0.01;
        if (totalNights >= 7 && property.pricing.discounts?.weekly)
          discount += totalPrice * 0.1;
        if (totalNights >= 30 && property.pricing.discounts?.monthly)
          discount += totalPrice * 0.2;
      }
      // Extended Hours Discount -- HOURLY bookings only, host sets their own
      // rate (0 = disabled), applies once a single booking exceeds 3 hours.
      if (effectivePricingType === "HOURLY" && totalHours > 3) {
        const extendedHoursRate = Number(property.pricing.discounts?.extendedHours) || 0;
        if (extendedHoursRate > 0) {
          discount += totalPrice * (extendedHoursRate / 100);
        }
      }
      totalPrice = Math.round((totalPrice - discount) * 100) / 100;
      if (isNaN(totalPrice) || totalPrice < 0) totalPrice = 0;

      // Commission rate: fixed for ANNUAL/MONTHLY, otherwise the platform
      // default unless the property's market has an active override — see
      // utils/commission.js and the admin Commission Settings page.
      const commissionRate = await resolveCommissionRate(effectivePricingType, property);

      const platformFee = Math.round(totalPrice * commissionRate * 100) / 100;
      const hostAmount = Math.round((totalPrice - platformFee) * 100) / 100;

      // 9. Create booking
      const isInstantBook = Boolean(property.bookingSettings?.instantBook);
      // Only pending bookings need a host decision, so only they get a
      // token -- lets the "New booking request" email carry one-click
      // Approve/Decline links (see /:id/quick-action below) without the
      // host having to log in first.
      const hostActionToken = isInstantBook ? undefined : randomUUID();
      const booking = new Booking({
        property: propertyId,
        guest: guestId,
        host: property.host._id,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        unitIndex: assignedUnit,
        guests: guests || 1,
        extras: selectedExtras,
        totalPrice,
        platformFee,
        hostAmount,
        // Optional security deposit, charged alongside rent as a second
        // Stripe Checkout line item (see routes/payments.js) but kept
        // entirely separate from totalPrice/platformFee/hostAmount above --
        // it must never factor into commission or the rent escrow-release
        // transfer, only into the host's wallet (see HostWallet).
        deposit: {
          amount: property.deposit?.enabled ? property.deposit.amount : 0,
          status: "none",
        },
        discountApplied: Math.round(discount * 100) / 100,
        // Gated on effectivePricingType (what this booking actually used),
        // not property.pricing.pricingType (the property's single default
        // tier) -- a property can have multiple pricing tiers enabled, so
        // those can differ, and using the wrong one silently dropped
        // totalNights/totalHours for any booking made on a non-default tier.
        totalNights:
          effectivePricingType === "DAILY" ? totalNights : undefined,
        totalHours:
          effectivePricingType === "HOURLY"
            ? Number(totalHours.toFixed(2))
            : undefined,
        pricingUnit: pricingUnit || (
          {
            HOURLY: "hour",
            DAILY: "day",
            WEEKLY: "week",
            MONTHLY: "month",
            ANNUAL: "year",
          }[effectivePricingType]
        ),
        totalUnits,
        // Only HOURLY/DAILY populate this (see calculation above) --
        // WEEKLY/MONTHLY/ANNUAL bookings span all 7 days regardless of
        // start day, so day-of-week variance isn't meaningful for them.
        priceBreakdown,
        // Snapshot the exact terms text the customer agreed to (validated
        // above), plus when -- guest identity is already captured via the
        // `guest` field above, so together this is a permanent record of
        // what was agreed to, when, and by whom.
        listingTermsSnapshot: property.listingTerms?.trim() || undefined,
        listingTermsAgreedAt: property.listingTerms?.trim() ? new Date() : undefined,
        status: isInstantBook ? "confirmed" : "pending",
        licensePdfUrl,
        ...(hostActionToken && {
          hostActionToken,
          hostActionTokenExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        }),
      });

      await booking.save();
      await booking.populate(["guest", "property", "host"]);

      // 10. Block dates if instantly confirmed
      if (booking.status === "confirmed") {
        await Property.findByIdAndUpdate(propertyId, {
          $push: {
            blockedDates: {
              start: checkInDate,
              end: checkOutDate,
              reason: "booked",
              bookingId: booking._id,
              unitIndex: booking.unitIndex,
            },
          },
        });

        // Push instant-book confirmations straight to the host's connected
        // Google/Outlook calendar, same as a request-to-book approval does.
        pushBookingToHostCalendars(booking, property).catch((err) =>
          console.error(`Calendar push failed for booking ${booking._id}:`, err.message)
        );
      }

      // 11. Notify host
      const user = await User.findById(req.user.id);
      const displayName = user.displayName || user.firstName || "there";

      await createNotification(req.app.get("io"), {
        userId: property.host._id,
        type: "booking_request",
        title: "New Booking",
        body: `${displayName} booked ${property.title}`,
        link: `/bookings/${booking._id}`,
        meta: { bookingId: booking._id },
      });

      // 12. Send confirmation email
      sendEmail({
        to: user.email,
        subject: booking.status === "confirmed" ? "Your booking is confirmed 🎉" : "Your booking request has been received",
        html: `
          <div style="font-family: 'Manrope', Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
              <div style="background-color: #f0f0f0; padding: 20px; text-align: center;">
                <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 150px;">
              </div>
              <div style="padding: 30px; color: #333;">
                <h2 style="color: #305CDE; text-align: center; margin-top: 0;">
                  ${booking.status === "confirmed" ? "Booking Confirmed 🎉" : "Booking Request Received 📋"}
                </h2>
                <p>Hi <strong>${displayName}</strong>,</p>
                <p>${booking.status === "confirmed" 
                  ? "Great news! Your booking has been <strong>successfully confirmed</strong>."
                  : "We've received your booking request. The host will review and respond within 24 hours."
                }</p>
                <div style="background-color: #f5f7ff; padding: 20px; margin: 25px 0; border-radius: 8px;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Property</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                        property.title || "—"
                      }</td>
                    </tr>
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Location</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                        property.location?.city || ""
                      }${
          property.location?.country ? `, ${property.location.country}` : ""
        }</td>
                    </tr>
                    ${booking.status === "confirmed" && property.location?.address ? `
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Full Address</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #305CDE;">${
                        [property.location.address, property.location.city, property.location.country].filter(Boolean).join(", ")
                      }</td>
                    </tr>
                    ` : ''}
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Check-in</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.checkIn.toLocaleDateString()}</td>
                    </tr>
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Check-out</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.checkOut.toLocaleDateString()}</td>
                    </tr>
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Guests</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                        booking.guests
                      }</td>
                    </tr>
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Total to be paid</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">£${
                        booking.totalPrice
                      }</td>
                    </tr>
                  </table>
                </div>
                ${booking.status === "pending" ? `
                <div style="background-color: #FFF7ED; border: 1px solid #FED7AA; border-radius: 8px; padding: 16px; margin: 20px 0;">
                  <p style="margin: 0; color: #92400E; font-size: 14px;">
                    ⏳ <strong>Awaiting host approval</strong> — You will not be charged until the host approves your request.
                  </p>
                </div>
                ` : ''}
                <p>The host has been notified and may contact you with additional details before your stay.</p>
                ${booking.status === "pending" ? `
                <p>Your payment will only be captured once the host confirms your booking. If the host declines or does not respond within 24 hours, your request will automatically expire and your card authorization will simply be released — you will not be charged.</p>
                ` : `
                <p>Your payment has been securely held in escrow and will be released to the host after your booking is completed. If anything changes, our team is here to help.</p>
                `}
                <p>You can view or manage your booking anytime from your VenCome dashboard.</p>
                <p style="margin-bottom: 0;">We wish you a wonderful stay!</p>
              </div>
              <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
                This is an automated message, please do not reply.<br />
                © ${new Date().getFullYear()} VenCome. All rights reserved.
              </div>
            </div>
          </div>
        `,
      });

      // Instant-book only -- a "pending" booking's guest SMS fires later,
      // when the host actually approves it (see PUT /:id/status below).
      if (booking.status === "confirmed" && user.phoneNumber && user.isPhoneVerified) {
        sendSMS({
          to: user.phoneNumber,
          body: `VenCome: Your booking at "${property.title}" is confirmed! Check-in ${checkInDate.toLocaleDateString()}.`,
        }).catch((err) => {
          if (err.code !== "SMS_NOT_CONFIGURED") console.error("Booking-confirmed SMS to guest failed:", err.message);
        });
      }

      const hostUser = await User.findById(property.host._id);

      if (hostUser) {
        const hostDisplayName = hostUser.displayName || hostUser.firstName || "there";
        const guestDisplayName = user.displayName || user.firstName || "A guest";

        sendEmail({
          to: hostUser.email,
          subject: `New booking request for ${property.title}`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
              <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                <div style="background-color: #0A1628; padding: 24px; text-align: center;">
                  <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 140px;">
                </div>
                <div style="padding: 30px; color: #333;">
                  <h2 style="color: #0A1628; text-align: center; margin-top: 0;">
                    ${booking.status === "confirmed" ? "New Booking Confirmed" : "New Booking Request"}
                  </h2>
                  <p>Hi <strong>${hostDisplayName}</strong>,</p>
                  <p>
                    ${
                      booking.status === "confirmed"
                        ? `<strong>${guestDisplayName}</strong> has instantly booked your space.`
                        : `<strong>${guestDisplayName}</strong> has requested to book your space. Please log in to approve or decline.`
                    }
                  </p>
                  <div style="background-color: #f5f7ff; padding: 20px; margin: 25px 0; border-radius: 8px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
                      <tr>
                        <td style="padding: 6px 0; color: #666;">Property</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 600;">${property.title}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #666;">Guest</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 600;">${guestDisplayName}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #666;">Check-in</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.checkIn.toLocaleDateString()}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #666;">Check-out</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 600;">${booking.checkOut.toLocaleDateString()}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #666;">Total</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 600;">£${booking.totalPrice}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #666;">Status</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 600; color: ${
                          booking.status === "confirmed" ? "#16A34A" : "#D97706"
                        };">
                          ${booking.status === "confirmed" ? "Confirmed" : "Pending Approval"}
                        </td>
                      </tr>
                    </table>
                  </div>
                  ${
                    booking.status === "pending" && booking.hostActionToken
                      ? `
                  <div style="text-align: center; margin: 24px 0;">
                    <a href="https://vencome-server.onrender.com/api/bookings/${booking._id}/quick-action?token=${booking.hostActionToken}&action=confirmed" style="background: #16A34A; color: #fff; padding: 14px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin-right: 10px; display: inline-block;">
                      Approve
                    </a>
                    <a href="https://vencome-server.onrender.com/api/bookings/${booking._id}/quick-action?token=${booking.hostActionToken}&action=declined" style="background: #fff; color: #DC2626; padding: 14px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; border: 1.5px solid #DC2626; display: inline-block;">
                      Decline
                    </a>
                  </div>
                  <p style="text-align: center; margin: 0 0 8px;">
                    <a href="https://www.vencome.com/dashboard/bookings" style="color: #305CDE; font-size: 13px; text-decoration: none; font-weight: 600;">Or review full details on your dashboard</a>
                  </p>
                  `
                      : ""
                  }
                  <p style="margin-bottom: 0; color: #6B7280; font-size: 13px;">
                    You can manage all your bookings from your VenCome host dashboard.
                  </p>
                </div>
                <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
                  This is an automated message, please do not reply.<br />
                  © ${new Date().getFullYear()} VenCome. All rights reserved.
                </div>
              </div>
            </div>
          `,
        });

        if (hostUser.phoneNumber && hostUser.isPhoneVerified) {
          sendSMS({
            to: hostUser.phoneNumber,
            body:
              booking.status === "confirmed"
                ? `VenCome: ${guestDisplayName} just instantly booked "${property.title}". Check your dashboard for details.`
                : `VenCome: ${guestDisplayName} requested to book "${property.title}". Log in to approve or decline.`,
          }).catch((err) => {
            if (err.code !== "SMS_NOT_CONFIGURED") console.error("Booking-request SMS to host failed:", err.message);
          });
        }
      }

      return res.status(201).json(booking);
    } catch (err) {
      if (req.file && fs.existsSync(req.file.path))
        fs.unlinkSync(req.file.path);
      console.error("Booking creation failed:", err.message, err.stack);
      return res.status(500).json({ error: err.message });
    }
  }
);

// GET: Host's bookings
router.get("/host", auth, async (req, res) => {
  try {
    const bookings = await Booking.find({ host: req.user.id })
      .populate("property", "title coverImage")
      .populate("guest", "firstName lastName displayName profileImage")
      .sort({ createdAt: -1 });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET: Guest's bookings
router.get("/", auth, async (req, res) => {
  try {
    const bookings = await Booking.find({ guest: req.user.id })
      .populate("property", "title coverImage")
      .populate("host", "firstName lastName displayName profileImage")
      .sort({ createdAt: -1 });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/past", auth, async (req, res) => {
  // const bookings = await Booking.find({
  //   guest: req.user._id,
  //   checkOut: { $gt: new Date() },
  // })
  const bookings = await Booking.find({ guest: req.user._id })
    .populate("property", "title images coverImage location pricing")
    .sort({ checkOut: -1 });

  res.json(bookings);
});

// GET: pending bookings count for the logged-in user (host or guest)
router.get("/pending-count", auth, async (req, res) => {
  try {
    const count = await Booking.countDocuments({
      $or: [{ host: req.user.id }, { guest: req.user.id }],
      status: "pending",
    });
    res.json({ success: true, pendingCount: count });
  } catch (err) {
    console.error("Error fetching pending bookings count:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id", auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.json(booking);
  } catch (err) {
    console.error("Fetch booking error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Builds a minimal .ics calendar attachment for a confirmed booking --
// Gmail/Outlook/Apple Mail all recognize this and show a native "Add to
// Calendar" prompt on the email itself, no custom link/button needed.
function buildBookingICS(booking, property) {
  const toICSDate = (date) =>
    new Date(date).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const address = property?.location
    ? [property.location.address, property.location.city, property.location.country].filter(Boolean).join(", ")
    : "";
  const escapeText = (text) => String(text || "").replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//VenCome//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${booking._id}@vencome.com`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(booking.checkIn)}`,
    `DTEND:${toICSDate(booking.checkOut)}`,
    `SUMMARY:${escapeText(property?.title ? `VenCome: ${property.title}` : "VenCome Booking")}`,
    address ? `LOCATION:${escapeText(address)}` : null,
    `DESCRIPTION:${escapeText(`Your confirmed booking on VenCome. View details: https://www.vencome.com/customer/bookings`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

// Shared by PUT /:id/status (authenticated dashboard action) and
// /:id/quick-action (token-based one-click email action, added below) --
// payment capture/release, date blocking, calendar push, socket events, and
// the guest confirmation/decline email, all in one place so the two entry
// points can never drift out of sync. Returns { ok: true, booking } or
// { ok: false, statusCode, error, detail? }.
async function applyBookingDecision(booking, status, io) {
  const property = await Property.findById(booking.property);
  if (!property) return { ok: false, statusCode: 404, error: "Property not found" };

  const previousStatus = booking.status;

  // Request to Book authorizes the card but doesn't capture it (see
  // routes/payments.js). Resolve that hold here, before committing the
  // status change, so a failed capture doesn't leave the booking confirmed
  // with no payment behind it.
  const awaitingCapture = Boolean(booking.paymentIntentId) && !booking.isPaid;

  if (status === "confirmed" && awaitingCapture) {
    try {
      await stripe.paymentIntents.capture(booking.paymentIntentId);
    } catch (captureErr) {
      console.error(`Payment capture failed for booking ${booking._id}:`, captureErr.message);
      return {
        ok: false,
        statusCode: 502,
        error: "Could not charge the guest's card — booking was not confirmed.",
        detail: captureErr.message,
      };
    }

    booking.isPaid = true;
    const releaseDate = new Date(booking.checkOut);
    releaseDate.setHours(releaseDate.getHours() + 24);
    booking.escrowReleaseDate = releaseDate;
    await creditDepositToWallet(booking);

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      { status: "paid", escrowReleaseAt: releaseDate }
    );
  }

  if (status === "declined" && awaitingCapture) {
    try {
      await stripe.paymentIntents.cancel(booking.paymentIntentId);
    } catch (cancelErr) {
      // Log and continue — the booking should still be declined even if
      // Stripe's hold was already released/expired on their side.
      console.error(`Failed to release payment hold for booking ${booking._id}:`, cancelErr.message);
    }

    await Payment.findOneAndUpdate({ booking: booking._id }, { status: "released" });
  }

  booking.status = status;
  // Single-use -- once a decision is made (through either entry point),
  // the email link must stop working.
  booking.hostActionToken = undefined;
  booking.hostActionTokenExpires = undefined;
  await booking.save();

  if (status === "confirmed") {
    const updateOps = {};

    const alreadyBlocked = property.blockedDates.some(
      (b) => b.bookingId?.toString() === booking._id.toString()
    );

    if (!alreadyBlocked) {
      updateOps.$push = {
        blockedDates: {
          start: booking.checkIn,
          end: booking.checkOut,
          reason: "booked",
          bookingId: booking._id,
          unitIndex: booking.unitIndex,
        },
      };
    }

    if (
      property.bookingSettings.approveFirstFive &&
      property.firstFiveApproved < 5
    ) {
      updateOps.$inc = { firstFiveApproved: 1 };
    }

    if (Object.keys(updateOps).length) {
      await Property.findByIdAndUpdate(booking.property, updateOps);
    }
  }

  // Only confirmed bookings block dates, so only unblock on confirmed → declined
  if (status === "declined" && previousStatus === "confirmed") {
    await Property.findByIdAndUpdate(booking.property, {
      $pull: { blockedDates: { bookingId: booking._id } },
    });
  }

  // Push to the host's connected calendar(s), if any. Never block the
  // booking flow on this -- calendar sync is a convenience, not a
  // requirement.
  if (status === "confirmed") {
    await pushBookingToHostCalendars(booking, property);
  }

  await booking.populate(["guest", "property"]);

  const eventName = status === "confirmed" ? "bookingConfirmed" : "bookingDeclined";
  io.to(`guest_${booking.guest._id}`).emit(eventName, booking);
  io.to(`host_${booking.host.toString()}`).emit(eventName, booking);

  // Send email to guest on approval or decline
  try {
    const guestUser = await User.findById(booking.guest._id || booking.guest);
    if (guestUser?.email) {
      const guestName = guestUser.displayName || guestUser.firstName || "there";
      const prop = await Property.findById(booking.property._id || booking.property);
      const fullAddress = prop?.location ? [prop.location.address, prop.location.city, prop.location.country].filter(Boolean).join(", ") : "";

      if (status === "confirmed") {
        // Generate invoice PDF
        let invoiceAttachment = null;
        try {
          const invoiceBuffer = await generateInvoicePDF(booking, prop, guestUser, await User.findById(booking.host));
          invoiceAttachment = {
            filename: `VenCome-Invoice-${booking._id.toString().slice(-8).toUpperCase()}.pdf`,
            content: invoiceBuffer,
            contentType: "application/pdf",
          };
        } catch (invoiceErr) {
          console.error("Invoice generation error:", invoiceErr.message);
        }

        const calendarAttachment = {
          filename: "VenCome-Booking.ics",
          // sendEmail base64-encodes via content.toString("base64") -- a
          // plain string's toString() ignores that argument and would send
          // raw unencoded text where SendGrid expects base64. Must be a
          // Buffer, same as the PDF invoice attachment already is.
          content: Buffer.from(buildBookingICS(booking, prop), "utf-8"),
          contentType: "text/calendar",
        };

        sendEmail({
          to: guestUser.email,
          subject: "Your booking has been confirmed 🎉",
          attachments: [calendarAttachment, ...(invoiceAttachment ? [invoiceAttachment] : [])],
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
              <h2 style="color:#0A1628;">Booking Confirmed 🎉</h2>
              <p>Hi ${guestName},</p>
              <p>Great news! The host has confirmed your booking for <strong>${prop?.title || "your space"}</strong>.</p>
              <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#F8F6F0;border-radius:8px;padding:16px;">
                <tr><td style="padding:8px 0;color:#666;">Space</td><td style="padding:8px 0;text-align:right;font-weight:700;">${prop?.title || ""}</td></tr>
                ${fullAddress ? `<tr><td style="padding:8px 0;color:#666;">Full Address</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#305CDE;">${fullAddress}</td></tr>` : ""}
                <tr><td style="padding:8px 0;color:#666;">Check-in</td><td style="padding:8px 0;text-align:right;font-weight:700;">${new Date(booking.checkIn).toLocaleDateString()}</td></tr>
                <tr><td style="padding:8px 0;color:#666;">Check-out</td><td style="padding:8px 0;text-align:right;font-weight:700;">${new Date(booking.checkOut).toLocaleDateString()}</td></tr>
                <tr><td style="padding:8px 0;color:#666;">Total Paid</td><td style="padding:8px 0;text-align:right;font-weight:700;">£${booking.totalPrice}</td></tr>
              </table>
              <p>Your payment is securely held in escrow and will be released to the host after your booking is completed.</p>
              <a href="https://www.vencome.com/customer/bookings" style="display:inline-block;padding:14px 28px;background:#305CDE;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">View My Booking</a>
              <p style="margin-top:24px;color:#6B7280;font-size:13px;">The VenCome Team</p>
            </div>
          `,
        });

        if (guestUser.phoneNumber && guestUser.isPhoneVerified) {
          sendSMS({
            to: guestUser.phoneNumber,
            body: `VenCome: Your booking at "${prop?.title || "your space"}" is confirmed! Check-in ${new Date(booking.checkIn).toLocaleDateString()}.`,
          }).catch((err) => {
            if (err.code !== "SMS_NOT_CONFIGURED") console.error("Booking-approved SMS to guest failed:", err.message);
          });
        }
      } else if (status === "declined") {
        sendEmail({
          to: guestUser.email,
          subject: "Your booking request was declined",
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="height:40px;margin-bottom:24px;" />
              <h2 style="color:#0A1628;">Booking Not Confirmed</h2>
              <p>Hi ${guestName},</p>
              <p>Unfortunately, the host was unable to confirm your booking request for <strong>${prop?.title || "the space"}</strong>.</p>
              <p>You have not been charged. If a payment was captured, a full refund will be processed within 5-10 business days.</p>
              <a href="https://www.vencome.com/search" style="display:inline-block;padding:14px 28px;background:#0A1628;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">Find Another Space</a>
              <p style="margin-top:24px;color:#6B7280;font-size:13px;">The VenCome Team</p>
            </div>
          `,
        });
      }
    }
  } catch (emailErr) {
    console.error("Approval email error:", emailErr.message);
  }

  return { ok: true, booking };
}

// PUT: Host approve/decline
router.put("/:id/status", auth, async (req, res) => {
  const { status } = req.body;

  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      host: req.user.id,
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (!["confirmed", "declined"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const result = await applyBookingDecision(booking, status, req.app.get("io"));
    if (!result.ok) {
      return res
        .status(result.statusCode)
        .json({ error: result.error, ...(result.detail && { detail: result.detail }) });
    }

    res.json(result.booking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Minimal branded HTML page used by the token-based quick-action routes
// below -- these are opened straight from an email, so they can't reuse the
// React client (no auth session to render the dashboard).
function quickActionPage({ title, body }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — VenCome</title>
</head>
<body style="font-family: Arial, sans-serif; background: #F8F6F0; margin: 0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); text-align: center;">
    <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 130px; margin-bottom: 24px;">
    <h1 style="color: #0A1628; font-size: 20px; margin: 0 0 12px;">${title}</h1>
    <div style="color: #333; font-size: 15px; line-height: 1.6;">${body}</div>
    <p style="margin-top: 28px;"><a href="https://www.vencome.com/dashboard/bookings" style="color: #305CDE; font-weight: 600; text-decoration: none;">Go to your dashboard</a></p>
  </div>
</body>
</html>`;
}

// GET: one-click email action landing page. Renders a confirmation screen
// with a real button (which POSTs) rather than performing the action on
// GET itself, so an email client's link-prefetch/security scanner can't
// silently approve or decline a booking just by following the link.
router.get("/:id/quick-action", async (req, res) => {
  const { token, action } = req.query;
  const label = action === "confirmed" ? "Approve" : action === "declined" ? "Decline" : null;

  res.set("Content-Type", "text/html");

  try {
    if (!token || !label) {
      return res.status(400).send(quickActionPage({
        title: "Invalid link",
        body: "This link is missing or has an invalid action.",
      }));
    }

    const booking = await Booking.findById(req.params.id).populate("property");
    if (!booking || !booking.hostActionToken || booking.hostActionToken !== token) {
      return res.status(404).send(quickActionPage({
        title: "Link not found",
        body: "This booking link is invalid or has already been used.",
      }));
    }
    if (booking.hostActionTokenExpires && booking.hostActionTokenExpires < new Date()) {
      return res.status(410).send(quickActionPage({
        title: "Link expired",
        body: "This link has expired. Please log in to your VenCome dashboard to respond to this booking.",
      }));
    }
    if (booking.status !== "pending") {
      return res.send(quickActionPage({
        title: "Already handled",
        body: `This booking has already been ${booking.status}.`,
      }));
    }

    res.send(quickActionPage({
      title: `${label} this booking?`,
      body: `
        <p>${booking.property?.title || "This space"}<br>
        ${new Date(booking.checkIn).toLocaleDateString()} – ${new Date(booking.checkOut).toLocaleDateString()}</p>
        <form method="POST" action="/api/bookings/${booking._id}/quick-action">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="action" value="${action}">
          <button type="submit" style="margin-top: 12px; padding: 14px 32px; background: ${action === "confirmed" ? "#16A34A" : "#DC2626"}; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer;">
            Yes, ${label.toLowerCase()} booking
          </button>
        </form>
      `,
    }));
  } catch (err) {
    console.error("Quick-action GET error:", err);
    res.status(500).send(quickActionPage({
      title: "Something went wrong",
      body: "Please try again or log in to your dashboard.",
    }));
  }
});

// POST: actually performs the approve/decline from the confirmation page
// above. Same token checks as the GET above, repeated -- the GET only ever
// rendered a form, it never validated on the caller's behalf.
router.post("/:id/quick-action", express.urlencoded({ extended: false }), async (req, res) => {
  const { token, action } = req.body;
  const status = action === "confirmed" ? "confirmed" : action === "declined" ? "declined" : null;

  res.set("Content-Type", "text/html");

  try {
    if (!token || !status) {
      return res.status(400).send(quickActionPage({
        title: "Invalid request",
        body: "This action is invalid.",
      }));
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking || !booking.hostActionToken || booking.hostActionToken !== token) {
      return res.status(404).send(quickActionPage({
        title: "Link not found",
        body: "This booking link is invalid or has already been used.",
      }));
    }
    if (booking.hostActionTokenExpires && booking.hostActionTokenExpires < new Date()) {
      return res.status(410).send(quickActionPage({
        title: "Link expired",
        body: "This link has expired. Please log in to your VenCome dashboard to respond to this booking.",
      }));
    }
    if (booking.status !== "pending") {
      return res.send(quickActionPage({
        title: "Already handled",
        body: `This booking has already been ${booking.status}.`,
      }));
    }

    const result = await applyBookingDecision(booking, status, req.app.get("io"));
    if (!result.ok) {
      return res.status(result.statusCode).send(quickActionPage({
        title: "Something went wrong",
        body: result.error,
      }));
    }

    res.send(quickActionPage({
      title: status === "confirmed" ? "Booking approved ✓" : "Booking declined",
      body:
        status === "confirmed"
          ? "The guest has been notified and charged. You can view full details on your dashboard."
          : "The guest has been notified. You can view full details on your dashboard.",
    }));
  } catch (err) {
    console.error("Quick-action POST error:", err);
    res.status(500).send(quickActionPage({
      title: "Something went wrong",
      body: "Please try again or log in to your dashboard.",
    }));
  }
});

// ─── Refund policy helper ─────────────────────────────────────────────────────
// Single platform-wide policy (client-confirmed, latest version -- supersedes
// both the old host-selectable moderate/strict/flexible/non-refundable tiers
// and the earlier "Aug 8" 72h/120h version. Property.bookingSettings.refundPolicy
// is no longer read here):
//   >48h before check-in: 100% refund
//   24h-48h before check-in: 75% refund (host keeps 25%)
//   <24h before check-in: 50% refund (host keeps 50%)
// `policy` param kept (unused) so call sites don't need to change.
function getRefundPolicy(policy, checkIn) {
  const now = new Date();
  const checkInDate = new Date(checkIn);
  const hoursUntilCheckIn = (checkInDate - now) / (1000 * 60 * 60);

  if (hoursUntilCheckIn > 48) {
    return {
      refundPercent: 100,
      reason: "Cancelled more than 48 hours before check-in — full refund",
    };
  }
  if (hoursUntilCheckIn >= 24) {
    return {
      refundPercent: 75,
      reason: "Cancelled 24-48 hours before check-in — 75% refund",
    };
  }
  return {
    refundPercent: 50,
    reason: "Cancelled within 24 hours of check-in — 50% refund",
  };
}

// ─── Cancel booking ───────────────────────────────────────────────────────────
// DELETE /bookings/:id/cancel
// Accessible by: guest (own booking) or host (their property's booking)
router.delete("/:id/cancel", auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate("property");

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const isGuest = booking.guest.toString() === req.user.id;
    const isHost = booking.host.toString() === req.user.id;

    if (!isGuest && !isHost) {
      return res
        .status(403)
        .json({ error: "Not authorised to cancel this booking" });
    }

    if (["cancelled", "completed"].includes(booking.status)) {
      return res
        .status(400)
        .json({ error: `Booking is already ${booking.status}` });
    }

    const cancelledBy = isHost ? "host" : "guest";

    // ── Refund logic ──────────────────────────────────────────────────────────
    let refundAmount = 0;
    let refundPercent = 0;
    let refundReason = "No payment on record";
    let stripeRefund = null;

    // Request to Book bookings only authorize the card until the host
    // approves (see routes/payments.js / routes/bookings.js PUT /:id/status).
    // If no capture ever happened, there's nothing to refund — just release
    // the hold so the guest's bank shows no charge at all.
    const awaitingCapture = Boolean(booking.paymentIntentId) && !booking.isPaid;

    if (awaitingCapture) {
      try {
        await stripe.paymentIntents.cancel(booking.paymentIntentId);
      } catch (cancelErr) {
        console.error(`Failed to release payment hold for booking ${booking._id}:`, cancelErr.message);
      }
      await Payment.findOneAndUpdate({ booking: booking._id }, { status: "released" });
      refundPercent = 0;
      refundReason = "Booking was never charged — card authorization released";
    } else {

    const refundPolicy =
      booking.property?.bookingSettings?.refundPolicy || "non-refundable";
    const { refundPercent: pct, reason } = getRefundPolicy(
      refundPolicy,
      booking.checkIn
    );

    refundPercent = pct;
    refundReason = reason;

    // Hosts who cancel always give a full refund to the guest
    if (isHost && pct < 100) {
      refundPercent = 100;
      refundReason = "Host-initiated cancellation — full refund issued";
    }

    if (
      booking.paymentIntentId &&
      booking.totalPrice > 0 &&
      refundPercent > 0
    ) {
      refundAmount = Math.round(
        ((booking.totalPrice * refundPercent) / 100) * 100
      ); // in cents

      try {
        stripeRefund = await stripe.refunds.create({
          payment_intent: booking.paymentIntentId,
          amount: refundAmount, // partial or full
          reason: "requested_by_customer",
          metadata: {
            bookingId: booking._id.toString(),
            cancelledBy,
            policy: refundPolicy,
          },
        });
      } catch (stripeErr) {
        console.error("Stripe refund failed:", stripeErr.message);
        return res.status(502).json({
          error: "Cancellation recorded but Stripe refund failed",
          detail: stripeErr.message,
        });
      }
    }

    } // end awaitingCapture / normal-refund branch

    // Deposit always fully refunds on a pre-checkin cancellation, regardless
    // of whichever rent-refund tier applied above (the deposit isn't rent --
    // there's nothing to claim against since no stay ever happened).
    try {
      await refundDeposit(booking);
    } catch (depositRefundErr) {
      console.error(`Deposit refund failed for booking ${booking._id}:`, depositRefundErr.message);
    }

    // ── Update booking ────────────────────────────────────────────────────────
    booking.status = "cancelled";
    booking.cancelledBy = cancelledBy;
    booking.cancelledAt = new Date();
    booking.refund = {
      percent: refundPercent,
      amount: refundAmount / 100, // back to £/$/€
      reason: refundReason,
      stripeRefundId: stripeRefund?.id || null,
      processedAt: stripeRefund ? new Date() : null,
    };
    await booking.save();

    // ── Unblock dates on property ─────────────────────────────────────────────
    await Property.findByIdAndUpdate(booking.property._id, {
      $pull: { blockedDates: { bookingId: booking._id } },
    });

    // ── Remove any pushed calendar events ──────────────────────────────────────
    if (booking.googleCalendarEventId || booking.outlookCalendarEventId) {
      const hostUser = await User.findById(booking.host).select("googleCalendar outlookCalendar");

      if (booking.googleCalendarEventId && hostUser?.googleCalendar?.connected) {
        try {
          await googleCalendar.deleteEvent(hostUser.googleCalendar.refreshToken, booking.googleCalendarEventId);
        } catch (calErr) {
          console.error(`Google Calendar delete failed for booking ${booking._id}:`, calErr.message);
        }
      }

      if (booking.outlookCalendarEventId && hostUser?.outlookCalendar?.connected) {
        try {
          await outlookCalendar.deleteEvent(hostUser.outlookCalendar.refreshToken, booking.outlookCalendarEventId);
        } catch (calErr) {
          console.error(`Outlook delete failed for booking ${booking._id}:`, calErr.message);
        }
      }
    }

    // ── Notify the other party via socket ─────────────────────────────────────
    const notifyUserId = isHost ? booking.guest : booking.host;
    req.app.get("io").to(`guest_${notifyUserId}`).emit("bookingCancelled", {
      bookingId: booking._id,
      cancelledBy,
      refundAmount: booking.refund.amount,
      refundPercent,
    });

    return res.json({
      message: "Booking cancelled successfully",
      booking,
      refund: booking.refund,
    });
  } catch (err) {
    console.error("Cancellation error:", err);
    return res.status(500).json({ error: "Failed to cancel booking" });
  }
});

// ─── Deposit: clean refund ────────────────────────────────────────────────────
// POST /bookings/:id/deposit/refund -- host triggers a full deposit refund
// (the "Refund deposit" button on a completed booking).
router.post("/:id/deposit/refund", auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.host.toString() !== req.user.id) {
      return res.status(403).json({ error: "Only the host can refund this deposit" });
    }
    if (booking.deposit?.status !== "charged") {
      return res.status(400).json({ error: `Deposit is not in a refundable state (status: ${booking.deposit?.status || "none"})` });
    }

    await refundDeposit(booking);
    await booking.save();

    res.json({ success: true, deposit: booking.deposit });
  } catch (err) {
    console.error("Deposit refund error:", err);
    res.status(500).json({ error: "Failed to refund deposit", detail: err.message });
  }
});

// ─── Deposit: file a damage claim ─────────────────────────────────────────────
// POST /bookings/:id/deposit/claim -- host files a claim instead of refunding.
// Opens a 48h window for the guest to dispute before it auto-settles (see the
// auto-release cron in utils/depositAutoRelease.js).
router.post("/:id/deposit/claim", auth, async (req, res) => {
  try {
    const { amount, reason, photoUrls } = req.body;
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.host.toString() !== req.user.id) {
      return res.status(403).json({ error: "Only the host can file a claim on this deposit" });
    }
    if (booking.deposit?.status !== "charged") {
      return res.status(400).json({ error: `Deposit is not in a claimable state (status: ${booking.deposit?.status || "none"})` });
    }
    const claimAmount = Number(amount);
    if (!claimAmount || claimAmount <= 0 || claimAmount > booking.deposit.amount) {
      return res.status(400).json({ error: `Claim amount must be between 0 and the deposit amount (£${booking.deposit.amount})` });
    }
    if (!reason || !Array.isArray(photoUrls) || photoUrls.length === 0) {
      return res.status(400).json({ error: "A reason and at least one photo are required" });
    }

    const disputeDeadline = new Date();
    disputeDeadline.setHours(disputeDeadline.getHours() + 48);

    booking.deposit.status = claimAmount >= booking.deposit.amount ? "claimed" : "partially_claimed";
    booking.deposit.claim = {
      amount: claimAmount,
      reason,
      photoUrls,
      filedAt: new Date(),
      disputeDeadline,
      disputeStatus: "none",
    };
    await booking.save();

    res.json({ success: true, deposit: booking.deposit });
  } catch (err) {
    console.error("Deposit claim error:", err);
    res.status(500).json({ error: "Failed to file claim", detail: err.message });
  }
});

// ─── Deposit: guest disputes a filed claim ────────────────────────────────────
// POST /bookings/:id/deposit/claim/dispute -- within the 48h window. Freezes
// the claim for manual admin review instead of letting it auto-settle.
router.post("/:id/deposit/claim/dispute", auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.guest.toString() !== req.user.id) {
      return res.status(403).json({ error: "Only the guest can dispute this claim" });
    }
    const claim = booking.deposit?.claim;
    if (!claim?.filedAt) {
      return res.status(400).json({ error: "No claim has been filed on this deposit" });
    }
    if (claim.disputeStatus !== "none") {
      return res.status(400).json({ error: `Claim is already ${claim.disputeStatus}` });
    }
    if (new Date() > new Date(claim.disputeDeadline)) {
      return res.status(400).json({ error: "The 48-hour dispute window has passed" });
    }

    booking.deposit.claim.disputeStatus = "disputed";
    await booking.save();

    res.json({ success: true, deposit: booking.deposit });
  } catch (err) {
    console.error("Deposit dispute error:", err);
    res.status(500).json({ error: "Failed to dispute claim", detail: err.message });
  }
});

// ====================== MULTER SETUP ======================

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

const uploadLease = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error("Only PDF, DOC, and DOCX files are allowed!"), false);
    }
    cb(null, true);
  },
});

// ====================== HELPERS ======================

/**
 * Clean up temporary files
 */
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

/**
 * Upload file to R2 storage
 * Assumes you have uploadToR2 function from your R2 config
 */
const uploadFileToR2 = async (
  filePath,
  fileName,
  contentType,
  folder = "lease-agreements"
) => {
  try {
    const result = await uploadToR2(filePath, `${folder}/${fileName}`, contentType);
    return result.location; // Return the full URL
  } catch (error) {
    console.error(`Error uploading ${fileName} to R2:`, error);
    throw error;
  }
};

/**
 * Delete file from R2 storage
 */
const deleteFileFromR2 = async (fileUrl) => {
  try {
    if (!fileUrl) return;
    const fileName = fileUrl.split("/").pop();
    await uploadToR2.deleteFromR2(fileName);
  } catch (error) {
    console.error(`Error deleting ${fileUrl} from R2:`, error);
  }
};

// ====================== ROUTES ======================

/**
 * ✅ Upload lease agreement for a booking
 * POST /bookings/upload-lease
 * Used by HOST when opening booking details modal
 */
router.post(
  "/upload-lease",
  auth,
  uploadLease.single("leaseFile"),
  async (req, res) => {
    try {
      const { bookingId } = req.body;
      const userId = req.user.id;

      // ── Validate required fields ──
      if (!bookingId || !req.file) {
        cleanupTempFiles([req.file]);
        return res.status(400).json({
          error: "Missing required fields: bookingId and leaseFile",
        });
      }

      // ── Fetch booking ──
      const booking = await Booking.findById(bookingId).populate("property");
      if (!booking) {
        cleanupTempFiles([req.file]);
        return res.status(404).json({ error: "Booking not found" });
      }

      // ── Verify user is the host ──
      const property = await Property.findById(booking.property._id);
      if (!property || property.host.toString() !== userId) {
        cleanupTempFiles([req.file]);
        return res.status(403).json({
          error: "You are not authorized to upload a lease for this booking",
        });
      }

      // ── Delete old lease if exists ──
      if (booking.leaseUrl) {
        await deleteFileFromR2(booking.leaseUrl);
      }

      // ── Upload new lease to R2 ──
      let leaseUrl;
      try {
        const fileName = `${bookingId}-${req.file.filename}`;
        leaseUrl = await uploadFileToR2(req.file.path, fileName, req.file.mimetype);
      } catch (uploadError) {
        console.error("Error uploading lease to R2:", uploadError);
        cleanupTempFiles([req.file]);
        return res.status(500).json({
          error: "Failed to upload lease agreement",
          details: uploadError.message,
        });
      }

      // ── Update booking with lease URL ──
      booking.leaseUrl = leaseUrl;
      const updatedBooking = await booking.save();

      // ── Cleanup temp file ──
      cleanupTempFiles([req.file]);

      res.status(200).json({
        success: true,
        message: "Lease agreement uploaded successfully",
        leaseUrl: updatedBooking.leaseUrl,
      });
    } catch (err) {
      console.error("Error uploading lease:", err);
      cleanupTempFiles([req.file]);
      res.status(500).json({
        error: "Server error",
        details: err.message,
      });
    }
  }
);

/**
 * ✅ Sign lease agreement
 * PUT /bookings/:id/sign-lease
 * Used by GUEST to confirm they've read and agreed to the lease
 */
router.put("/sign-lease/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { signatureType, signatureDataUrl, typedName } = req.body;

    // ── Validate signature payload ──
    if (signatureType !== "drawn" && signatureType !== "typed") {
      return res.status(400).json({
        error: "signatureType must be 'drawn' or 'typed'",
      });
    }
    if (signatureType === "drawn" && !signatureDataUrl) {
      return res.status(400).json({ error: "A drawn signature is required" });
    }
    const trimmedTypedName = typeof typedName === "string" ? typedName.trim() : "";
    if (signatureType === "typed" && (!trimmedTypedName || trimmedTypedName.length > 200)) {
      return res.status(400).json({ error: "A typed signature name is required" });
    }

    // ── Fetch booking ──
    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // ── Verify user is the guest ──
    if (booking.guest.toString() !== userId) {
      return res.status(403).json({
        error: "You are not authorized to sign this lease",
      });
    }

    // ── Check if lease exists ──
    if (!booking.leaseUrl) {
      return res.status(400).json({
        error: "No lease agreement has been uploaded for this booking",
      });
    }

    // ── Hash the lease document's actual bytes at signing time, so there's
    // a tamper-evident record of exactly what was agreed to (the lease URL
    // alone doesn't prove the file wasn't swapped afterwards). Never blocks
    // signing if this fails -- the signature itself is still captured.
    let leaseDocumentHash = null;
    try {
      const leaseResponse = await fetch(booking.leaseUrl);
      if (leaseResponse.ok) {
        const leaseBuffer = Buffer.from(await leaseResponse.arrayBuffer());
        leaseDocumentHash = createHash("sha256").update(leaseBuffer).digest("hex");
      }
    } catch (hashErr) {
      console.error(`Failed to hash lease document for booking ${id}:`, hashErr.message);
    }

    // ── Update booking with lease signature ──
    booking.leaseSignedAt = new Date();
    booking.signatureType = signatureType;
    booking.signatureDataUrl = signatureType === "drawn" ? signatureDataUrl : undefined;
    booking.signatureTypedName = signatureType === "typed" ? trimmedTypedName : undefined;
    booking.signedIp = req.ip;
    booking.leaseDocumentHash = leaseDocumentHash;
    const updatedBooking = await booking.save();

    // ── Optional: Send email notification to host ──
    const property = await Property.findById(booking.property).populate("host");
    const guest = await User.findById(booking.guest);

    if (property && guest) {
      const hostUser = property.host;
      sendEmail({
        to: hostUser.email,
        subject: `Guest signed lease agreement for ${property.title}`,
        html: `
          <div style="font-family: 'Manrope', Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
              <div style="background-color: #f0f0f0; padding: 20px; text-align: center;">
                <img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width: 150px;">
              </div>
              <div style="padding: 30px; color: #333;">
                <h2 style="color: #305CDE; text-align: center; margin-top: 0;">Lease Agreement Signed ✓</h2>
                <p>Hi <strong>${hostUser.firstName || "there"}</strong>,</p>
                <p><strong>${guest.firstName} ${
          guest.lastName
        }</strong> has signed the lease agreement for <strong>${
          property.title
        }</strong>.</p>
                <div style="background-color: #f5f7ff; padding: 20px; margin: 25px 0; border-radius: 8px;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Guest</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                        guest.firstName
                      } ${guest.lastName}</td>
                    </tr>
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Property</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${
                        property.title
                      }</td>
                    </tr>
                    <tr>
                      <td style="padding: 6px 0; color: #666;">Signed on</td>
                      <td style="padding: 6px 0; text-align: right; font-weight: 600;">${new Date().toLocaleDateString()}</td>
                    </tr>
                  </table>
                </div>
                <p>The booking is now ready to proceed. You can message the guest or update the booking status from your dashboard.</p>
              </div>
              <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
                This is an automated message, please do not reply.<br />
                © ${new Date().getFullYear()} VenCome. All rights reserved.
              </div>
            </div>
          </div>
        `,
      });
    }

    res.status(200).json({
      success: true,
      message: "Lease agreement signed successfully",
      leaseSignedAt: updatedBooking.leaseSignedAt,
      signatureType: updatedBooking.signatureType,
      signedIp: updatedBooking.signedIp,
    });
  } catch (err) {
    console.error("Error signing lease:", err);
    res.status(500).json({
      error: "Server error",
      details: err.message,
    });
  }
});

/**
 * ✅ Get lease agreement details for a booking
 * GET /bookings/:id/lease
 * Used to check lease status and URL
 */
router.get("/:id/lease", auth, async (req, res) => {
  try {
    const { id } = req.params;

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.status(200).json({
      success: true,
      leaseUrl: booking.leaseUrl || null,
      leaseSignedAt: booking.leaseSignedAt || null,
      leaseStatus: booking.leaseSignedAt ? "signed" : "pending",
    });
  } catch (err) {
    console.error("Error fetching lease details:", err);
    res.status(500).json({
      error: "Server error",
      details: err.message,
    });
  }
});

/**
 * ✅ Delete lease agreement
 * DELETE /bookings/:id/lease
 * Used by HOST to remove a lease (only if not yet signed by guest)
 */
router.delete("/:id/lease", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const booking = await Booking.findById(id).populate("property");
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // ── Verify user is the host ──
    const property = await Property.findById(booking.property._id);
    if (!property || property.host.toString() !== userId) {
      return res.status(403).json({
        error: "You are not authorized to delete this lease",
      });
    }

    // ── Prevent deletion if already signed ──
    if (booking.leaseSignedAt) {
      return res.status(400).json({
        error: "Cannot delete a lease that has already been signed",
      });
    }

    // ── Delete from R2 ──
    if (booking.leaseUrl) {
      await deleteFileFromR2(booking.leaseUrl);
    }

    // ── Update booking ──
    booking.leaseUrl = null;
    await booking.save();

    res.status(200).json({
      success: true,
      message: "Lease agreement deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting lease:", err);
    res.status(500).json({
      error: "Server error",
      details: err.message,
    });
  }
});

// Guest-facing visibility into Property.unitsCount (identical bookable
// units, e.g. "5 identical chairs" on one listing) for a specific date
// range -- reuses the exact same getUnitOccupancy logic that POST /bookings
// uses to actually assign/reject bookings, so what the guest sees here is
// guaranteed consistent with what the booking endpoint will do. Only
// meaningful when unitsCount > 1, but returns correct numbers regardless.
router.get("/property/:propertyId/unit-availability", async (req, res) => {
  try {
    const { checkIn, checkOut } = req.query;
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    if (!checkIn || !checkOut || isNaN(checkInDate) || isNaN(checkOutDate)) {
      return res.status(404).json({ error: "Property not found" });
    }

    // Same slug-or-ObjectId resolution as GET /property/:propertyId/booked-dates
    // just below -- property pages are accessed by slug, not just raw
    // ObjectId, so both need to resolve to the real _id.
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(req.params.propertyId);
    const property = isObjectId
      ? await Property.findById(req.params.propertyId).select("_id unitsCount blockedDates")
      : await Property.findOne({ slug: req.params.propertyId }).select("_id unitsCount blockedDates");
    if (!property) {
      return res.status(404).json({ error: "Property not found" });
    }

    const unitsCount = property.unitsCount || 1;
    const occupancy = await getUnitOccupancy(property, checkInDate, checkOutDate);
    const fullyBooked = isFullyBooked(occupancy, unitsCount);
    const unitsAvailable = occupancy.blockedAll
      ? 0
      : Math.max(0, unitsCount - occupancy.takenUnits.size);

    res.json({
      unitsCount,
      unitsAvailable,
      isFullyBooked: fullyBooked,
      // Specific unit numbers occupied for this exact date range, so the
      // client can render per-unit state (e.g. gray out unit 2 specifically)
      // instead of just a count. blockedAll means every unit is closed
      // regardless of individual unitIndex, so report all of them taken.
      takenUnits: occupancy.blockedAll
        ? Array.from({ length: unitsCount }, (_, i) => i + 1)
        : Array.from(occupancy.takenUnits),
    });
  } catch (err) {
    console.error("Error fetching unit availability:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/property/:propertyId/booked-dates", async (req, res) => {
  try {
    const Booking = require("../models/Booking");
    // Property pages are now accessed by slug (the canonical URL), not just
    // raw ObjectId -- resolve either one to the real _id before querying,
    // same pattern as routes/categories.js. Without this, a slug here threw
    // a Mongoose CastError on every request, flattened into a silent 500.
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(req.params.propertyId);
    const property = isObjectId
      ? await Property.findById(req.params.propertyId).select("_id")
      : await Property.findOne({ slug: req.params.propertyId }).select("_id");
    if (!property) {
      return res.json({ success: true, bookedDates: [] });
    }

    const bookings = await Booking.find({
      property: property._id,
      status: { $in: ["confirmed", "pending"] },
    }).select("checkIn checkOut");

    const bookedDates = bookings.map((b) => ({
      start: b.checkIn,
      end: b.checkOut,
    }));

    res.json({ success: true, bookedDates });
  } catch (err) {
    console.error("Error fetching booked dates:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// NOTE: booking cancellation (customer or host) is handled by the single
// policy-aware DELETE /:id/cancel route above — it actually talks to Stripe
// (refund or release-hold as appropriate) and respects the property's
// refund policy. This used to be a second, parallel POST /:id/cancel route
// that only flipped the status and emailed "a refund will be processed"
// without ever refunding anything. Removed to avoid two conflicting cancel
// paths; the client now calls DELETE /:id/cancel everywhere.

module.exports = router;
