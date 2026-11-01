// Editable system emails (admin Broadcast -> Email templates). Each template
// has a subject, a heading and a plain-text body with {{variables}}; admin
// can override any of them (models/EmailTemplate.js) and reset to the
// defaults below. The layout around them -- logo, footer, the booking-details
// table, buttons -- stays in code and comes in through "block" variables
// such as {{details}}, so an edit can't break it.
//
// Body format: a blank line starts a new paragraph, a single newline is a
// line break, **text** is bold. A block variable on its own line is placed
// as-is (it's HTML built by the code). Every other value is escaped.
const EmailTemplate = require("../models/EmailTemplate");

const TEMPLATES = {
  verification: {
    name: "Verification code",
    description: "Sent at sign-up, and when an unverified account logs in.",
    variables: { code: "123456" },
    blocks: ["code"],
    subject: "Verify Your Email Address",
    heading: "Welcome! Verify Your Email",
    body: "Your verification code is:\n\n{{code}}\n\nThis code expires in **10 minutes**.",
  },
  verify_reminder: {
    name: "Verify your account reminder",
    description: "Mondays and Thursdays for 2 weeks to accounts that haven't verified. An unsubscribe link is always added.",
    variables: { firstName: "Sam", button: "" },
    blocks: ["button"],
    subject: "Verify your VenCome account",
    heading: "Verify your account",
    body:
      "Hi **{{firstName}}**,\n\nYou started creating a VenCome account but haven't verified your email yet. Log in with your email and we'll send you a one-time code — it takes less than a minute.\n\n{{button}}\n\nThe VenCome Team",
  },
  finish_listing: {
    name: "Finish your listing",
    description: "Weekly to hosts with a saved, unpublished listing draft.",
    variables: { firstName: "Sam", spaceName: "Private two desk office", details: "", button: "" },
    blocks: ["details", "button"],
    subject: "Finish your listing on VenCome",
    heading: "Finish your listing 📋",
    body:
      "Hi **{{firstName}}**,\n\nYour listing is still saved as a draft and isn't visible to tenants yet. It only takes a few minutes to finish and start receiving bookings.\n\n{{details}}\n\n{{button}}\n\nWe'll keep saving your progress, and remind you again if it's still incomplete.",
  },
  booking_request: {
    name: "Booking request (to host)",
    description: "To the host when a guest requests to book (Request to Book).",
    variables: { firstName: "Alex", guestName: "Sam", spaceName: "Private two desk office", details: "", actionButtons: "" },
    blocks: ["details", "actionButtons"],
    subject: "New booking request for {{spaceName}}",
    heading: "New Booking Request",
    body:
      "Hi **{{firstName}}**,\n\n**{{guestName}}** has requested to book your space. Please log in to approve or decline.\n\n{{details}}\n\n{{actionButtons}}\n\nYou can manage all your bookings from your VenCome host dashboard.",
  },
  booking_confirmation: {
    name: "Booking confirmation (to guest)",
    description: "To the guest when a booking is confirmed (Instant Book, or the host approves).",
    variables: { firstName: "Sam", spaceName: "Private two desk office", details: "", button: "" },
    blocks: ["details", "button"],
    subject: "Your booking has been confirmed 🎉",
    heading: "Booking Confirmed 🎉",
    body:
      "Hi **{{firstName}}**,\n\nGreat news! Your booking for **{{spaceName}}** is confirmed.\n\n{{details}}\n\nYour payment is securely held in escrow and will be released to the host after your booking is completed.\n\n{{button}}",
  },
  cancellation_guest: {
    name: "Cancellation (to guest)",
    description: "To the guest when a booking is cancelled by either side.",
    variables: { firstName: "Sam", whoCancelled: "You cancelled", spaceName: "Private two desk office", date: "4 Nov 2026, 09:00", refundLine: "A refund of £120.00 (100%) has been issued to the original payment method." },
    blocks: [],
    subject: "Your booking has been cancelled",
    heading: "Booking cancelled",
    body: "Hi **{{firstName}}**,\n\n{{whoCancelled}} your booking at **{{spaceName}}** on {{date}}.\n\n{{refundLine}}",
  },
  cancellation_host: {
    name: "Cancellation (to host)",
    description: "To the host when a booking is cancelled by either side.",
    variables: { firstName: "Alex", whoCancelled: "The guest cancelled", spaceName: "Private two desk office", date: "4 Nov 2026, 09:00" },
    blocks: [],
    subject: "A booking has been cancelled",
    heading: "Booking cancelled",
    body: "Hi **{{firstName}}**,\n\n{{whoCancelled}} the booking at **{{spaceName}}** on {{date}}. The dates are available again.",
  },
  broadcast: {
    name: "Broadcast",
    description: "The frame around every broadcast. {{message}} is what you write when sending; the broadcast's own subject is used.",
    variables: { firstName: "Sam", message: "Your broadcast message goes here.", subject: "News from VenCome" },
    blocks: [],
    subject: "{{subject}}",
    heading: "",
    body: "Hi {{firstName}},\n\n{{message}}",
  },
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fill = (text, vars, escape) => text.replace(/\{\{(\w+)\}\}/g, (_, name) => (escape ? escapeHtml(vars[name]) : String(vars[name] ?? "")));

// Body text -> HTML paragraphs. A paragraph that is only a block variable is
// replaced by that block's HTML.
function bodyToHtml(body, vars, blockNames) {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => {
      const block = paragraph.trim().match(/^\{\{(\w+)\}\}$/);
      if (block && blockNames.includes(block[1])) return vars[block[1]] || "";
      const html = fill(paragraph.trim(), vars, true)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
      return `<p style="margin:0 0 14px;">${html}</p>`;
    })
    .join("\n");
}

// The site's standard email frame (logo, heading, footer).
const frame = (heading, inner, footer) => `<div style="font-family:'Manrope',Arial,sans-serif;background:#f4f4f7;padding:20px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
    <div style="background:#f0f0f0;padding:20px;text-align:center;"><img src="https://www.vencome.com/logo-blue.png" alt="VenCome" style="max-width:150px;height:auto;"></div>
    <div style="padding:30px;color:#333;font-size:15px;line-height:1.6;">
      ${heading ? `<h2 style="color:#305CDE;margin-top:0;text-align:center;">${heading}</h2>` : ""}
      ${inner}
    </div>
    <div style="background:#f0f0f0;padding:20px;text-align:center;font-size:12px;color:#888;">
      ${footer || "This is an automated message, please do not reply."}<br>© ${new Date().getFullYear()} VenCome. All rights reserved.
    </div>
  </div>
</div>`;

// Shared building blocks for the code that sends these emails.
const blocks = {
  button: (href, label) =>
    `<p style="text-align:center;margin:28px 0;"><a href="${href}" style="display:inline-block;background:#305CDE;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;">${label}</a></p>`,
  code: (code) =>
    `<div style="background:#f4f4f4;padding:20px;text-align:center;margin:25px 0;border-radius:8px;"><span style="font-size:28px;font-weight:bold;color:#305CDE;letter-spacing:6px;">${escapeHtml(code)}</span></div>`,
  // rows: [[label, valueHtml], ...]
  details: (rows) =>
    `<div style="background:#f5f7ff;padding:20px;margin:20px 0;border-radius:8px;"><table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">${rows
      .map(([label, value]) => `<tr><td style="padding:6px 0;color:#666;" valign="top">${label}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${value}</td></tr>`)
      .join("")}</table></div>`,
};

// Admin overrides, cached briefly so every email isn't a DB read.
let cache = { at: 0, byKey: {} };
async function overrides() {
  if (Date.now() - cache.at < 60 * 1000) return cache.byKey;
  try {
    const saved = await EmailTemplate.find().lean();
    cache = { at: Date.now(), byKey: Object.fromEntries(saved.map((t) => [t.key, t])) };
  } catch (err) {
    console.error("[Email templates] Couldn't load overrides, using defaults:", err.message);
  }
  return cache.byKey;
}
const clearTemplateCache = () => {
  cache = { at: 0, byKey: {} };
};

// { subject, heading, body } for a template: the admin's version if saved,
// otherwise the default. `draft` (admin preview / test send) wins over both.
async function resolveTemplate(key, draft) {
  const def = TEMPLATES[key];
  if (!def) throw new Error(`Unknown email template "${key}"`);
  const saved = draft ? null : (await overrides())[key];
  const source = draft || saved || def;
  return {
    subject: source.subject ?? def.subject,
    heading: source.heading ?? def.heading,
    body: source.body ?? def.body,
  };
}

// The finished email for `key` with `vars`. `footer` replaces the standard
// "automated message" line (e.g. the reminder's unsubscribe link).
async function renderEmail(key, vars = {}, { draft, footer } = {}) {
  const def = TEMPLATES[key];
  const t = await resolveTemplate(key, draft);
  return {
    subject: fill(t.subject, vars, false),
    html: frame(fill(t.heading, vars, true), bodyToHtml(t.body, vars, def.blocks), footer),
  };
}

module.exports = { TEMPLATES, renderEmail, resolveTemplate, clearTemplateCache, blocks, escapeHtml };
