const express = require("express");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const Property = require("../models/Property");
const Booking = require("../models/Booking");
const User = require("../models/User");
const auth = require("../middleware/auth");
const sendEmail = require("../utils/sendEmail");
const containsBlockedContent = require("../utils/messageFilter");
const router = express.Router();

// GET: Get all conversations for current user
router.get("/conversations", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversations = await Conversation.find({
      $or: [{ host: userId }, { guest: userId }],
    })
      .populate("host", "firstName lastName displayName profileImage name email")
      .populate("guest", "firstName lastName displayName profileImage name email")
      .populate("property", "title coverImage")
      .sort({ lastMessageAt: -1 });

    res.json(conversations);
  } catch (err) {
    console.error("Get conversations error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET: unread message count for the logged-in user across all conversations
router.get("/unread-count", auth, async (req, res) => {
  try {
    const Message = require("../models/Message");
    const Conversation = require("../models/Conversation");

    const conversations = await Conversation.find({
      $or: [{ host: req.user.id }, { guest: req.user.id }],
    }).select("_id");

    const conversationIds = conversations.map((c) => c._id);

    const unreadCount = await Message.countDocuments({
      conversation: { $in: conversationIds },
      sender: { $ne: req.user.id },
      read: false,
    });

    res.json({ success: true, unreadCount });
  } catch (err) {
    console.error("Error fetching unread count:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET: Get or create conversation for a property
router.get("/property/:propertyId", auth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const guestId = req.user.id;

    let conversation = await Conversation.findOne({
      property: propertyId,
      guest: guestId,
    })
      .populate("host", "firstName lastName displayName profileImage name email")
      .populate("guest", "firstName lastName displayName profileImage name email")
      .populate("property", "title coverImage");

    if (!conversation) {
      const property = await Property.findById(propertyId);
      if (!property) return res.status(404).json({ error: "Property not found" });

      conversation = new Conversation({
        property: propertyId,
        host: property.host,
        guest: guestId,
        participants: [property.host, guestId],
      });
      await conversation.save();
      await conversation.populate([
        { path: "host", select: "firstName lastName displayName profileImage name email" },
        { path: "guest", select: "firstName lastName displayName profileImage name email" },
        { path: "property", select: "title coverImage" },
      ]);
    }

    const messages = await Message.find({ conversation: conversation._id })
      .sort({ createdAt: 1 })
      .populate("sender", "firstName lastName displayName profileImage");

    res.json({ conversation, messages });
  } catch (err) {
    console.error("Get property conversation error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET: Get or create conversation for a booking (works for either the guest
// or the host on that booking — unlike GET /property/:propertyId, which
// always assumes the caller is the guest).
router.get("/booking/:bookingId", auth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;

    const booking = await Booking.findById(bookingId).select("property guest host");
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (booking.guest.toString() !== userId && booking.host.toString() !== userId) {
      return res.status(403).json({ error: "Not authorised" });
    }

    let conversation = await Conversation.findOne({
      property: booking.property,
      guest: booking.guest,
      host: booking.host,
    })
      .populate("host", "firstName lastName displayName profileImage name email")
      .populate("guest", "firstName lastName displayName profileImage name email")
      .populate("property", "title coverImage");

    if (!conversation) {
      conversation = new Conversation({
        property: booking.property,
        host: booking.host,
        guest: booking.guest,
        participants: [booking.host, booking.guest],
      });
      await conversation.save();
      await conversation.populate([
        { path: "host", select: "firstName lastName displayName profileImage name email" },
        { path: "guest", select: "firstName lastName displayName profileImage name email" },
        { path: "property", select: "title coverImage" },
      ]);
    }

    const messages = await Message.find({ conversation: conversation._id })
      .sort({ createdAt: 1 })
      .populate("sender", "firstName lastName displayName profileImage");

    res.json({ conversation, messages });
  } catch (err) {
    console.error("Get booking conversation error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST: Create enquiry conversation with booking details
router.post("/enquiry", auth, async (req, res) => {
  try {
    const { propertyId, checkIn, checkOut, guests, durationType, totalPrice, message } = req.body;
    const guestId = req.user.id;

    if (message && containsBlockedContent(message)) {
      return res.status(400).json({
        error: "Sharing contact details or social media is not allowed.",
      });
    }

    const property = await Property.findById(propertyId).populate("host", "firstName lastName displayName profileImage name email");
    if (!property) return res.status(404).json({ error: "Property not found" });

    // Find existing conversation or create new one
    let conversation = await Conversation.findOne({
      property: propertyId,
      guest: guestId,
    });

    if (!conversation) {
      conversation = new Conversation({
        property: propertyId,
        host: property.host._id,
        guest: guestId,
        participants: [property.host._id, guestId],
        enquiryDetails: { checkIn, checkOut, guests, durationType, totalPrice, message },
        lastMessageAt: new Date(),
      });
      await conversation.save();
    }

    // Create the enquiry message
    const enquiryText = `📅 Booking Enquiry\n\nDates: ${new Date(checkIn).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} → ${new Date(checkOut).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}\nDuration: ${durationType}\nGuests: ${guests}\nTotal: £${totalPrice}${message ? `\n\nMessage: ${message}` : ""}`;

    const msg = new Message({
      conversation: conversation._id,
      sender: guestId,
      text: enquiryText,
    });
    await msg.save();
    await msg.populate("sender", "firstName lastName displayName profileImage");

    await Conversation.findByIdAndUpdate(conversation._id, {
      lastMessage: enquiryText.slice(0, 100),
      lastMessageAt: new Date(),
    });

    res.json({ conversation, message: msg });
  } catch (err) {
    console.error("Create enquiry error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET: Get messages for a conversation
router.get("/:conversationId", auth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const conversation = await Conversation.findById(conversationId)
      .populate("host", "firstName lastName displayName profileImage name email")
      .populate("guest", "firstName lastName displayName profileImage name email")
      .populate("property", "title coverImage location");

    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    if (
      conversation.host._id.toString() !== userId &&
      conversation.guest._id.toString() !== userId
    ) {
      return res.status(403).json({ error: "Not authorised" });
    }

    const messages = await Message.find({ conversation: conversationId })
      .sort({ createdAt: 1 })
      .populate("sender", "firstName lastName displayName profileImage");

    // Mark messages as read
    await Message.updateMany(
      { conversation: conversationId, sender: { $ne: userId }, read: false },
      { read: true }
    );

    res.json({ conversation, messages });
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST: Send message in a conversation
router.post("/", auth, async (req, res) => {
  try {
    const { conversationId, text } = req.body;
    const userId = req.user.id;

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    if (
      conversation.host.toString() !== userId &&
      conversation.guest.toString() !== userId
    ) {
      return res.status(403).json({ error: "Not authorised" });
    }

    if (containsBlockedContent(text)) {
      return res.status(400).json({
        error: "Sharing contact details or social media is not allowed.",
      });
    }

    const message = new Message({
      conversation: conversationId,
      sender: userId,
      text,
    });
    await message.save();
    await message.populate("sender", "firstName lastName displayName profileImage");

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: text.slice(0, 100),
      lastMessageAt: new Date(),
    });

    // Emit via socket
    const io = req.app.get("io");
    const recipientIsHost = conversation.host.toString() !== userId;
    const recipientId = recipientIsHost
      ? conversation.host.toString()
      : conversation.guest.toString();

    if (io) {
      io.to(conversationId).emit("message", message);
      io.to(`user_${recipientId}`).emit("newMessage", {
        conversationId,
        message,
      });

      // Email the recipient only if they don't currently have this
      // conversation open (i.e. none of their active sockets are in the
      // conversation room) — avoids spamming someone who is actively
      // chatting right now.
      const recipientSocketIds = io.sockets.adapter.rooms.get(`user_${recipientId}`);
      const conversationSocketIds = io.sockets.adapter.rooms.get(conversationId);
      const recipientViewing =
        recipientSocketIds &&
        conversationSocketIds &&
        [...recipientSocketIds].some((id) => conversationSocketIds.has(id));

      if (!recipientViewing) {
        User.findById(recipientId)
          .select("email displayName firstName")
          .then((recipientUser) => {
            if (!recipientUser?.email) return;
            const recipientName = recipientUser.displayName || recipientUser.firstName || "there";
            sendEmail({
              to: recipientUser.email,
              subject: "New message on VenCome",
              html: `<div style="font-family:'Manrope',Arial,sans-serif;background:#f4f4f7;padding:20px;">
                <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
                  <div style="background:#f0f0f0;padding:20px;text-align:center;"><img src="${process.env.CLIENT_URL}/logo-blue.png" alt="VenCome" style="max-width:150px;"></div>
                  <div style="padding:30px;color:#333;">
                    <h2 style="color:#305CDE;">New message</h2>
                    <p>Hi ${recipientName}, you have a new message on VenCome:</p>
                    <p style="background:#F8F6F0;border-radius:8px;padding:16px;color:#111827;">${text.slice(0, 200)}</p>
                    <a href="${process.env.CLIENT_URL}/${recipientIsHost ? "dashboard" : "customer"}/messages/${conversationId}" style="display:inline-block;margin-top:8px;padding:12px 24px;background:#0A1628;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">View message</a>
                  </div>
                  <div style="background:#f0f0f0;padding:20px;text-align:center;font-size:12px;color:#888;">© ${new Date().getFullYear()} VenCome. All rights reserved.</div>
                </div>
              </div>`,
            }).catch((err) => console.error("New message email failed:", err.message));
          })
          .catch((err) => console.error("Recipient lookup for message email failed:", err.message));
      }
    }

    res.json(message);
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
