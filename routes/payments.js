const express = require("express");
require("dotenv").config({ path: "config.env" });
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Booking = require("../models/Booking");
const auth = require("../middleware/auth");
const User = require("../models/User");
const router = express.Router();
const Payment = require("../models/Payment");

// POST: Create Checkout Session
router.post("/create-checkout-session", auth, async (req, res) => {
  const { bookingId } = req.body;

  try {
    const booking = await Booking.findOne({
      _id: bookingId,
      guest: req.user.id,
    }).populate("property", "title coverImage");

    if (!booking) {
      return res.status(400).json({ error: "Booking not found" });
    }
    if (booking.isPaid) {
      return res.status(400).json({ error: "Booking already paid" });
    }

    const rawImage = booking.property?.coverImage || "";
    const isValidImageUrl = rawImage.startsWith("https://") || rawImage.startsWith("http://");
    const imageUrl = isValidImageUrl ? encodeURI(rawImage) : undefined;

    // Instant Book charges are captured immediately. Request to Book only
    // authorizes the card — the charge is captured on host approval (or
    // released on decline / 24h expiry) in routes/bookings.js.
    const isDeferred = booking.status === "pending";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      billing_address_collection: "required",
      custom_text: isDeferred
        ? {
            submit: {
              message:
                "You will only be charged if your request is accepted by the host. If declined or not answered within 24 hours, this authorization is released and you are not charged.",
            },
          }
        : undefined,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: booking.property.title,
              images: imageUrl ? [imageUrl] : undefined,
            },
            unit_amount: Math.round(booking.totalPrice * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      payment_intent_data: isDeferred ? { capture_method: "manual" } : undefined,
      // success_url: `${process.env.CLIENT_URL_DEV}/my-bookings?success=true`,
      // cancel_url: `${process.env.CLIENT_URL_DEV}/my-bookings?cancel=true`,
      success_url: `${process.env.CLIENT_URL}/property/${booking.property._id}?success=true&bookingId=${booking._id}&value=${booking.totalPrice}`,
      cancel_url: `${process.env.CLIENT_URL}/property/${booking.property._id}?cancel=true`,
      metadata: { bookingId: booking._id.toString() },
    });

    // Save session ID
    await booking.save();

    res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err); // ← See the real problem
    res.status(500).json({ error: err.message });
  }
});

// Add payment method
router.post("/", auth, async (req, res) => {
  const { tokenId, last4, brand } = req.body;

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Verify token is valid
    const token = await stripe.tokens.retrieve(tokenId);
    if (!token || token.used) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    // Create Stripe customer if doesn't exist
    if (!user.stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        source: tokenId,
      });
      user.stripeCustomerId = customer.id;
    } else {
      // Add card to existing customer
      const card = await stripe.customers.createSource(user.stripeCustomerId, {
        source: tokenId,
      });
    }

    // Set first card as default
    const isDefault = user.paymentMethods.length === 0;

    // If this should be default, unset others
    if (isDefault) {
      user.paymentMethods.forEach((method) => {
        method.isDefault = false;
      });
    }

    // Add payment method
    user.paymentMethods.push({
      type: "card",
      brand: brand.toLowerCase(),
      cardNumber: `************${last4}`,
      last4: last4,
      stripeCardId: token.card.id,
      isDefault: isDefault,
    });

    await user.save();

    // Return sanitized data
    res.status(201).json({
      success: true,
      paymentMethods: user.paymentMethods.map((method) => ({
        _id: method._id,
        type: method.type,
        brand: method.brand,
        last4: method.last4,
        isDefault: method.isDefault,
        createdAt: method.createdAt,
      })),
    });
  } catch (err) {
    console.error("Add payment method error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Get payment methods
router.get("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("paymentMethods");
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      paymentMethods: user.paymentMethods.map((method) => ({
        _id: method._id,
        type: method.type,
        brand: method.brand,
        last4: method.last4,
        isDefault: method.isDefault,
        createdAt: method.createdAt,
      })),
    });
  } catch (err) {
    console.error("Get payment methods error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/payment-history", auth, async (req, res) => {
  try {
    const payments = await Payment.find({ user: req.user.id })
      .populate({
        path: "booking",
        populate: {
          path: "property",
          select: "title images",
        },
      })
      .sort({ createdAt: -1 })
      .limit(50); // Limit to last 50 payments

    res.json({
      success: true,
      payments: payments.map((payment) => ({
        _id: payment._id,
        amount: payment.amount,
        status: payment.status,
        paymentMethod: payment.paymentMethod,
        paymentMethodBrand: payment.paymentMethodBrand,
        last4: payment.last4,
        booking: payment.booking,
        createdAt: payment.createdAt,
        refundAmount: payment.refundAmount,
        refundedAt: payment.refundedAt,
      })),
    });
  } catch (err) {
    console.error("Get payment history error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Delete payment method
router.delete("/:methodId", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const methodIndex = user.paymentMethods.findIndex(
      (m) => m._id.toString() === req.params.methodId
    );

    if (methodIndex === -1) {
      return res.status(404).json({ error: "Payment method not found" });
    }

    const method = user.paymentMethods[methodIndex];

    // Prevent deleting default or last method
    if (method.isDefault && user.paymentMethods.length > 1) {
      return res.status(400).json({
        error:
          "Cannot delete default payment method. Set another as default first.",
      });
    }

    if (user.paymentMethods.length === 1) {
      return res.status(400).json({
        error: "Cannot delete your only payment method.",
      });
    }

    // Optional: Delete from Stripe
    if (user.stripeCustomerId && method.stripeCardId) {
      try {
        await stripe.customers.deleteSource(
          user.stripeCustomerId,
          method.stripeCardId
        );
      } catch (stripeErr) {
        console.error("Stripe card deletion error:", stripeErr);
        // Continue anyway - we'll delete from our DB
      }
    }

    user.paymentMethods.splice(methodIndex, 1);
    await user.save();

    res.json({
      success: true,
      message: "Payment method deleted successfully",
    });
  } catch (err) {
    console.error("Delete payment method error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Set default payment method
router.patch("/:methodId/default", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const method = user.paymentMethods.find(
      (m) => m._id.toString() === req.params.methodId
    );

    if (!method) {
      return res.status(404).json({ error: "Payment method not found" });
    }

    // Unset all defaults and set the new one
    user.paymentMethods.forEach((m) => {
      m.isDefault = m._id.toString() === req.params.methodId;
    });

    // Optional: Set as default in Stripe
    if (user.stripeCustomerId && method.stripeCardId) {
      try {
        await stripe.customers.update(user.stripeCustomerId, {
          default_source: method.stripeCardId,
        });
      } catch (stripeErr) {
        console.error("Stripe default card error:", stripeErr);
        // Continue anyway
      }
    }

    await user.save();

    res.json({
      success: true,
      message: "Default payment method updated successfully",
    });
  } catch (err) {
    console.error("Set default payment method error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
