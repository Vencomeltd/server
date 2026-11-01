// "Verify your account" reminders: accounts that signed up but never finished
// verifying (User.isVerified) get a reminder every Monday and Thursday for
// their first REMINDER_DAYS days, then never again. Stops as soon as the
// account verifies, or the user unsubscribes (link in every email,
// GET /api/auth/verify-reminders/unsubscribe). Each send is recorded on the
// user (verifyReminders.sentAt) for the admin user detail view.
const cron = require("node-cron");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const sendEmail = require("./sendEmail");
const { renderEmail, blocks } = require("./emailTemplates");

const REMINDER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const clientUrl = () => process.env.CLIENT_URL || "https://www.vencome.com";
const serverUrl = () => process.env.SERVER_URL || "https://vencome-server.onrender.com";

// Signed, purpose-limited token: it can only unsubscribe this user from these
// reminders, nothing else.
const unsubscribeToken = (userId) =>
  jwt.sign({ id: String(userId), purpose: "verify-reminders-unsubscribe" }, process.env.JWT_SECRET, { expiresIn: "60d" });

const unsubscribeUrl = (userId) => `${serverUrl()}/api/auth/verify-reminders/unsubscribe?token=${unsubscribeToken(userId)}`;

// The reminder email (template "verify_reminder"); the unsubscribe link is
// always in the footer, whatever the template says.
const reminderEmail = (user) =>
  renderEmail(
    "verify_reminder",
    { firstName: user.displayName || user.firstName || "there", button: blocks.button(`${clientUrl()}/login`, "Verify my account") },
    {
      footer: `You're receiving this because an account was created with this email on VenCome.<br><a href="${unsubscribeUrl(user._id)}" style="color:#888;">Unsubscribe from these reminders</a>`,
    }
  );

// Everyone due a reminder right now: unverified, signed up in the last
// REMINDER_DAYS days, not opted out, not banned or a test/internal account,
// and not already reminded today.
async function sendDueVerifyReminders(now = new Date()) {
  const users = await User.find({
    isVerified: { $ne: true },
    createdAt: { $gte: new Date(now.getTime() - REMINDER_DAYS * DAY_MS) },
    "verifyReminders.optedOut": { $ne: true },
    isBanned: { $ne: true },
    isTestAccount: { $ne: true },
    "verifyReminders.lastSentAt": { $not: { $gte: new Date(now.getTime() - 12 * 60 * 60 * 1000) } },
  }).select("email firstName displayName");

  let sent = 0;
  for (const user of users) {
    try {
      await sendEmail({ to: user.email, ...(await reminderEmail(user)), category: "reminder" });
      await User.updateOne(
        { _id: user._id },
        { $push: { "verifyReminders.sentAt": now }, $set: { "verifyReminders.lastSentAt": now } }
      );
      sent += 1;
    } catch (err) {
      console.error(`[Verify reminders] Failed for user ${user._id}:`, err.message);
    }
  }
  if (sent) console.log(`[Verify reminders] Sent ${sent} reminder(s)`);
  return sent;
}

function setupVerifyReminders() {
  // Mondays and Thursdays, 10:00 UK time.
  cron.schedule("0 10 * * 1,4", () => sendDueVerifyReminders().catch((err) => console.error("[Verify reminders] Error:", err.message)), {
    timezone: "Europe/London",
  });
}

module.exports = setupVerifyReminders;
module.exports.sendDueVerifyReminders = sendDueVerifyReminders;
module.exports.REMINDER_DAYS = REMINDER_DAYS;
