const router = require("express").Router();
const auth = require("../middleware/auth");

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const containsBlockedContent = require("../utils/messageFilter");

/**
 * Get or create conversation
 */
router.post("/conversation/:bookingId", auth, async (req, res) => {
  const { bookingId } = req.params;

  let conversation = await Conversation.findOne({ booking: bookingId });

  if (!conversation) {
    conversation = await Conversation.create({
      booking: bookingId,
      guest: req.user.id,
      host: req.body.hostId,
    });
  }

  res.json(conversation);
});

router.get("/conversations", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Find conversations where user is guest or host
    const conversations = await Conversation.find({
      $or: [{ guest: userId }, { host: userId }],
    })
      .populate("guest", "displayName profileImage") // only select what you need
      .populate("host", "displayName profileImage businessVerification.companyName accountFlag")
      .sort({ updatedAt: -1 }) // latest updated first
      .lean(); // return plain JS objects

    // Fetch last message for each conversation
    const result = await Promise.all(
      conversations.map(async (conv) => {
        const lastMessage = await Message.findOne({ conversation: conv._id })
          .sort({ createdAt: -1 })
          .lean();

        return {
          ...conv,
          lastMessage: lastMessage ? lastMessage.text : null,
          lastMessageAt: lastMessage ? lastMessage.createdAt : conv.updatedAt,
        };
      })
    );

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

router.get("/:conversationId", auth, async (req, res) => {
  try {
    // Fetch the conversation with guest and host details
    const conversation = await Conversation.findById(req.params.conversationId)
      .populate("guest", "displayName profileImage")
      .populate("host", "displayName profileImage businessVerification.companyName accountFlag")
      .lean();

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    // Fetch messages
    const messages = await Message.find({
      conversation: req.params.conversationId,
    })
      .populate("sender", "displayName profileImage")
      .sort({ createdAt: 1 }) // oldest first
      .lean();

    res.json({
      conversation,
      messages,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch conversation" });
  }
});

/**
 * Send message
 */
router.post("/:conversationId", auth, async (req, res) => {
  const io = req.app.get("io");
  const { text } = req.body;
  console.log(req.params);

  if (containsBlockedContent(text)) {
    return res.status(400).json({
      error: "Sharing contact details or social media is not allowed.",
    });
  }

  const message = await Message.create({
    conversation: req.params.conversationId,
    sender: req.user.id,
    text,
  });

  io.to(req.params.conversationId).emit("new_message", message);

  res.status(201).json(message);
});

router.post("/read/:conversationId", auth, async (req, res) => {
  await Message.updateMany(
    {
      conversation: req.params.conversationId,
      readBy: { $ne: req.user._id },
    },
    {
      $push: { readBy: req.user._id },
    }
  );

  const io = req.app.get("io");
  io.to(req.params.conversationId).emit("read_receipt", {
    userId: req.user._id,
  });

  res.json({ success: true });
});

module.exports = router;
