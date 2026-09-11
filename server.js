const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const authRoutes = require("./routes/auth");
const propertyRoutes = require("./routes/properties");
const categoryRoutes = require("./routes/categories");
const bookingRoutes = require("./routes/bookings");
const availabiltyRoutes = require("./routes/availability");
const reviewsRoutes = require("./routes/reviews");
const settingsRoutes = require("./routes/settings");
const profileRoutes = require("./routes/profile");
const uploadRoutes = require("./routes/upload");
const messageRoutes = require("./routes/messages");
const hostRoutes = require("./routes/hosts");
const paymentsWebhook = require("./routes/paymentsWebhook");
const paymentRoutes = require("./routes/payments");
const payoutRoutes = require("./routes/payouts");
const walletRoutes = require("./routes/wallet");
const visitorTrackingRoutes = require("./routes/visitorTracking");
const geocodeRoutes = require("./routes/geocode");
const notificationRoutes = require("./routes/notifications");
const verificationRoutes = require("./routes/verification");
const draftRoutes = require("./routes/drafts");
const chatRoutes = require("./routes/chat");
const http = require("http");
const socketIo = require("socket.io");
const Message = require("./models/Message");
const Conversation = require("./models/Conversation");
const SupportTicket = require("./models/SupportTicket");
const User = require("./models/User");
const setupEscrowRelease = require("./utils/releaseEscrow");
const setupDepositAutoRelease = require("./utils/depositAutoRelease");
const setupWalletBalanceRelease = require("./utils/releaseWalletBalance");
const setupScheduledBroadcasts = require("./utils/sendScheduledBroadcasts");
const setupBookingExpiry = require("./utils/expirePendingBookings");
const setupGoogleCalendarSync = require("./utils/syncGoogleCalendars");
const setupOutlookCalendarSync = require("./utils/syncOutlookCalendars");
const setupCalcomCalendarSync = require("./utils/syncCalcomCalendars");
const setupCalendlyCalendarSync = require("./utils/syncCalendlyCalendars");
const setupAppleCalendarSync = require("./utils/syncAppleCalendars");

const cron = require("node-cron");
const markCompletedBookings = require("./jobs/markCompletedBookings");
const revealPastDueReviews = require("./utils/revealPastDueReviews");
const isSuspicious = require("./utils/suspicionEngine");
const { connectRedis } = require("./utils/redisClient");

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: "./config.env" });
}

const app = express();

connectRedis().catch(console.error);

app.set("trust proxy", 1);
const server = http.createServer(app);
const allowedOrigins = [
  "http://localhost:5173",
  "https://vencome.netlify.app",
  "https://client-inky-nu-61.vercel.app",
  "https://vencome.com",
  "https://www.vencome.com",
  "https://vencome.co.uk",
  "https://www.vencome.co.uk",
];

const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// const io = socketIo(server, {
//   cors: {
//     origin: true,
//     credentials: true,
//   },
// });

// Socket.IO Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.user.id);

  socket.join(`user_${socket.user.id}`);

  socket.on("joinConversation", (conversationId) => {
    socket.join(conversationId);
  });

  socket.on("typing", ({ conversationId }) => {
    socket.to(conversationId).emit("typing", {
      userId: socket.user.id,
    });
  });

  socket.on("stopTyping", ({ conversationId }) => {
    socket.to(conversationId).emit("stopTyping", {
      userId: socket.user.id,
    });
  });

  // Support ticket real-time chat — siblings of joinConversation/typing above,
  // rooms are scoped to `ticket_${ticketId}` so only the ticket's owner or an
  // admin can join and receive live replies.
  socket.on("joinTicket", async (ticketId) => {
    try {
      const ticket = await SupportTicket.findById(ticketId).select("user");
      if (!ticket) return;
      const requester = await User.findById(socket.user.id).select("isAdmin");
      if (ticket.user.toString() === socket.user.id || requester?.isAdmin) {
        socket.join(`ticket_${ticketId}`);
      }
    } catch (err) {
      console.error("joinTicket error:", err.message);
    }
  });

  socket.on("ticket_typing", ({ ticketId }) => {
    socket.to(`ticket_${ticketId}`).emit("ticket_typing", { userId: socket.user.id });
  });

  socket.on("sendMessage", async ({ conversationId, text }) => {
    const flagged = isSuspicious(text);

    const message = new Message({
      conversation: conversationId,
      sender: socket.user.id,
      text,
      blocked: flagged,
      blockReason: flagged ? "Suspicious content detected" : null,
    });
    await message.save();
    await message.populate("sender", "name profileImage");

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: text,
      lastMessageAt: new Date(),
    });

    io.to(conversationId).emit("message", message);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.user.id);
  });
});
app.set("io", io);

// Middleware
const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Range", "X-Content-Range"],
  maxAge: 86400, // 24 hours
};
// Apply CORS before other middleware
app.use(cors(corsOptions));

cron.schedule("0 0 * * *", async () => {
  console.log("Running daily booking cleanup...");
  await markCompletedBookings();
  await revealPastDueReviews().catch((err) =>
    console.error("[Review Reveal] Cron error:", err.message)
  );
});

// Sync connected external calendars (Google Calendar / Outlook / iCal feeds)
// every 6 hours so external bookings block VenCome availability.
cron.schedule("0 */6 * * *", async () => {
  console.log("[Calendar Sync] Syncing connected external calendars...");
  try {
    const Property = require("./models/Property");
    const syncExternalCalendar = require("./utils/syncIcal");
    const properties = await Property.find({ icalUrl: { $exists: true, $ne: null } }).select("_id");
    for (const property of properties) {
      await syncExternalCalendar(property._id).catch((err) =>
        console.error(`[Calendar Sync] Failed for property ${property._id}:`, err.message)
      );
    }
    console.log(`[Calendar Sync] Done — checked ${properties.length} listing(s)`);
  } catch (err) {
    console.error("[Calendar Sync] Cron error:", err.message);
  }
});

// Auto-expire unanswered support-access requests after 24h — an unanswered
// request never falls back to silent access, it just expires.
cron.schedule("0 * * * *", async () => {
  try {
    const SupportAccessRequest = require("./models/SupportAccessRequest");
    const SupportAccessLog = require("./models/SupportAccessLog");
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await SupportAccessRequest.find({ status: "pending", requestedAt: { $lt: cutoff } });
    for (const request of stale) {
      request.status = "expired";
      await request.save();
      await SupportAccessLog.create({ user: request.user, request: request._id, action: "expired" });
    }
    if (stale.length > 0) console.log(`[Support Access] Expired ${stale.length} unanswered request(s)`);
  } catch (err) {
    console.error("[Support Access] Expiry cron error:", err.message);
  }
});

// Remind hosts with an incomplete draft listing every 24h until they finish
// it. Runs hourly and checks each draft's own clock (createdAt, then
// lastReminderSentAt) rather than firing on a single fixed time of day,
// since drafts are abandoned at all hours.
cron.schedule("0 * * * *", async () => {
  try {
    const Draft = require("./models/Draft");
    const sendEmail = require("./utils/sendEmail");
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dueDrafts = await Draft.find({
      $or: [
        { lastReminderSentAt: null, createdAt: { $lte: cutoff } },
        { lastReminderSentAt: { $lte: cutoff } },
      ],
    }).populate("host", "email firstName displayName");

    for (const draft of dueDrafts) {
      if (!draft.host?.email) continue;
      try {
        const name = draft.host.firstName || draft.host.displayName || "there";
        const resumeUrl = `${process.env.CLIENT_URL}/create-space`;
        await sendEmail({
          to: draft.host.email,
          subject: "Finish your listing on VenCome",
          text: `Hi ${name}, your listing "${draft.title}" is still saved as a draft. Log in to VenCome and finish it to start receiving bookings: ${resumeUrl}`,
          html: `
            <div style="font-family: 'Manrope', Arial, sans-serif; background-color: #f4f4f7; padding: 20px;">
              <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                <div style="background-color: #f0f0f0; padding: 20px; text-align: center;">
                  <img src="https://vencome.com/VenCome.jpg" alt="VenCome" style="max-width: 150px;">
                </div>
                <div style="padding: 30px; color: #333;">
                  <h2 style="color: #305CDE; text-align: center; margin-top: 0;">Finish your listing 📋</h2>
                  <p>Hi <strong>${name}</strong>,</p>
                  <p>Your listing is still saved as a draft and isn't visible to tenants yet. It only takes a few minutes to finish and start receiving bookings.</p>
                  <div style="background-color: #f5f7ff; padding: 20px; margin: 25px 0; border-radius: 8px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
                      <tr>
                        <td style="padding: 6px 0; color: #666;">Listing</td>
                        <td style="padding: 6px 0; text-align: right; font-weight: 600;">${draft.title}</td>
                      </tr>
                    </table>
                  </div>
                  <div style="text-align: center; margin: 30px 0;">
                    <a href="${resumeUrl}" style="display: inline-block; background-color: #305CDE; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">Finish My Listing</a>
                  </div>
                  <p style="margin-bottom: 0;">We'll keep saving your progress, and remind you again if it's still incomplete.</p>
                </div>
                <div style="background-color: #f0f0f0; padding: 20px; text-align: center; font-size: 12px; color: #888;">
                  This is an automated message, please do not reply.<br />
                  © ${new Date().getFullYear()} VenCome. All rights reserved.
                </div>
              </div>
            </div>
          `,
        });
        draft.lastReminderSentAt = new Date();
        await draft.save();
      } catch (err) {
        console.error(`[Draft Reminder] Failed to email host for draft ${draft._id}:`, err.message);
      }
    }
    if (dueDrafts.length > 0) console.log(`[Draft Reminder] Sent ${dueDrafts.length} reminder(s)`);
  } catch (err) {
    console.error("[Draft Reminder] Cron error:", err.message);
  }
});

app.use(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  paymentsWebhook
);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Connect to MongoDB
mongoose
  .connect(process.env.DATABASE)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error(err));

// Blocks everything except admin + auth routes when Maintenance Mode is on
// (Settings -> Platform tab), so admins can still log in and turn it back off.
const PlatformSettings = require("./models/PlatformSettings");
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/admin") || req.path.startsWith("/api/auth")) return next();
  try {
    const settings = await PlatformSettings.getSettings();
    if (settings.maintenanceMode) {
      return res.status(503).json({ error: "VenCome is temporarily down for maintenance. Please check back shortly." });
    }
  } catch (err) {
    console.error("Maintenance mode check failed:", err);
  }
  next();
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/properties", propertyRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/availability", availabiltyRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/platform-reviews", require("./routes/platformReviews"));
app.use("/api/settings", settingsRoutes);
app.use("/api/profile", profileRoutes); // New
app.use("/api/messages", messageRoutes);
app.use("/api/chat/conversations", require("./routes/messages"));
app.use("/api/chat", chatRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/hosts", hostRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/payouts", payoutRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/track-visit", visitorTrackingRoutes);
app.use("/api/geocode", geocodeRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/drafts", draftRoutes);
app.use("/api/admin", require("./routes/admin"));
app.use("/api/calendar", require("./routes/calendarSync"));
app.use("/api/host-calendar", require("./routes/hostCalendar"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/support", require("./routes/support"));
app.use("/api/support-access", require("./routes/supportAccess"));
app.use("/uploads", express.static("uploads"));
app.use("/api/blog", require("./routes/blog"));
app.use("/api/contact", require("./routes/contact"));
app.use("/api/prospect-emails", require("./routes/prospectEmails"));
app.use("/api/platform-settings", require("./routes/publicSettings"));
app.use("/api/translate", require("./routes/translate"));

// Dynamic sitemap
app.get("/sitemap.xml", async (req, res) => {
  try {
    const Property = require("./models/Property");
    const Category = require("./models/Category");
    const { generateSlug } = require("./utils/slugify");
    const [properties, blogs, categories, serviceLocationCandidates, allCategories] = await Promise.all([
      Property.find({ isActive: true }).select("_id slug updatedAt").lean(),
      require("./models/Blog").find({ status: "published" }).select("slug updatedAt").lean(),
      Category.find({ status: "published" }).select("_id slug updatedAt").lean(),
      // Only listings that could possibly power a /:subcategorySlug/:locationSlug
      // page -- mirrors GET /properties/by-service-location's own match shape.
      Property.find({
        isActive: true,
        "location.neighborhood": { $nin: [null, ""] },
        $or: [{ subcategory: { $nin: [null, ""] } }, { subcategories: { $exists: true, $ne: [] } }],
      })
        .select("subcategory subcategories location.neighborhood")
        .lean(),
      // Subcategory name -> slug map, independent of the parent category's
      // published status (a service+location page is scoped to the
      // subcategory, not the category page).
      Category.find({}).select("subcategories.name subcategories.slug").lean(),
    ]);

    // Build every real (subcategorySlug, locationSlug) combo that has at
    // least one matching active listing, so nothing thin ever gets indexed.
    const subcategorySlugByName = new Map();
    for (const cat of allCategories) {
      for (const sub of cat.subcategories || []) {
        if (sub.name && sub.slug) subcategorySlugByName.set(sub.name, sub.slug);
      }
    }
    const serviceLocationCombos = new Map();
    for (const p of serviceLocationCandidates) {
      const locationSlug = generateSlug(p.location.neighborhood);
      const subcategoryNames = [p.subcategory, ...(p.subcategories || [])].filter(Boolean);
      for (const name of subcategoryNames) {
        const subcategorySlug = subcategorySlugByName.get(name);
        if (!subcategorySlug) continue;
        serviceLocationCombos.set(`${subcategorySlug}/${locationSlug}`, true);
      }
    }

    const allowedHosts = allowedOrigins.map((o) => o.replace(/^https?:\/\//, ""));
    const forwardedHost = req.headers["x-forwarded-host"];
    const host = allowedHosts.includes(forwardedHost) ? forwardedHost : "www.vencome.com";
    const baseUrl = `https://${host}`;
    const staticUrls = [
      { loc: `${baseUrl}/`, priority: "1.0", changefreq: "daily" },
      { loc: `${baseUrl}/search`, priority: "0.9", changefreq: "daily" },
      { loc: `${baseUrl}/about`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/contact`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/faq`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/privacy`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/terms-and-conditions`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/cancellation-options`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/careers`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/press`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/partners`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/safety`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/accessibility`, priority: "0.6", changefreq: "monthly" },
      { loc: `${baseUrl}/help-center`, priority: "0.6", changefreq: "monthly" },
    ];

    const propertyUrls = properties.map((p) => ({
      loc: `${baseUrl}/property/${p.slug || p._id}`,
      priority: "0.8",
      changefreq: "weekly",
      lastmod: p.updatedAt ? new Date(p.updatedAt).toISOString().split("T")[0] : undefined,
    }));

    const blogUrls = blogs.map((b) => ({
      loc: `${baseUrl}/blog/${b.slug}`,
      priority: "0.7",
      changefreq: "monthly",
      lastmod: b.updatedAt ? new Date(b.updatedAt).toISOString().split("T")[0] : undefined,
    }));

    const categoryUrls = categories.map((c) => ({
      loc: `${baseUrl}/category/${c.slug || c._id}`,
      priority: "0.7",
      changefreq: "weekly",
      lastmod: c.updatedAt ? new Date(c.updatedAt).toISOString().split("T")[0] : undefined,
    }));

    const serviceLocationUrls = Array.from(serviceLocationCombos.keys()).map((combo) => ({
      loc: `${baseUrl}/${combo}`,
      priority: "0.7",
      changefreq: "weekly",
    }));

    const allUrls = [...staticUrls, ...propertyUrls, ...blogUrls, ...categoryUrls, ...serviceLocationUrls];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls
  .map(
    (url) => `  <url>
    <loc>${url.loc}</loc>
    ${url.lastmod ? `<lastmod>${url.lastmod}</lastmod>` : ""}
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>`;

    res.set("Content-Type", "application/xml");
    // Response body now varies per-domain (baseUrl derived from the request's
    // forwarded host). Vercel's edge cache keys external rewrites by the
    // proxied destination URL, not the original incoming domain — since both
    // vencome.com and vencome.co.uk rewrite to this exact same backend route,
    // a public cache would let one domain's cached response leak into the
    // other's. Must stay uncached.
    res.set("Cache-Control", "no-store");
    res.send(xml);
  } catch (err) {
    console.error("Sitemap error:", err);
    res.status(500).send("Error generating sitemap");
  }
});

// llms.txt - for AI crawlers
app.get("/llms.txt", (req, res) => {
  res.set("Content-Type", "text/plain");
  res.send(`# VenCome
> VenCome is a B2B commercial space rental marketplace connecting business hosts with professional tenants across the UK and Middle East.

## What We Do
VenCome allows businesses to list and book commercial spaces including offices, studios, meeting rooms, event venues, co-working spaces, medical rooms, retail units, and warehouses.

## Target Markets
- United Kingdom (London, Manchester, Birmingham, Edinburgh)
- Middle East (Dubai, Abu Dhabi, Riyadh, Doha)

## Key Features
- Instant booking and request-to-book flows
- Hourly, daily, weekly, monthly, and annual pricing
- Escrow-based payments with 10% platform commission
- Host verification and trust scoring
- Google Maps integration with price pins
- Real-time availability calendar

## User Types
- Customers (tenants) - search, book, and pay for commercial spaces
- Hosts (landlords) - list and manage commercial properties
- Admins - platform management and oversight

## Links
- [Homepage](https://www.vencome.com)
- [Search spaces](https://www.vencome.com/search)
- [List a space](https://www.vencome.com/create-space)
- [Blog](https://www.vencome.com/blog)
- [Contact](https://www.vencome.com/contact)
`);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
setupEscrowRelease();
setupDepositAutoRelease();
setupWalletBalanceRelease();
setupScheduledBroadcasts();
setupBookingExpiry();
setupGoogleCalendarSync();
setupOutlookCalendarSync();
setupCalcomCalendarSync();
setupCalendlyCalendarSync();
setupAppleCalendarSync();
