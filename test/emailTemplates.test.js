// Run with: node --test test/emailTemplates.test.js
// Editable system emails: defaults, admin overrides, escaping, layout blocks;
// and the opening-hours rows added to booking confirmations.
const test = require("node:test");
const assert = require("node:assert/strict");

const EmailTemplate = require("../models/EmailTemplate");
let saved = [];
EmailTemplate.find = () => ({ lean: async () => saved });
let siteFooter = null;
require("../models/SiteContent").findOne = () => ({ lean: async () => siteFooter });

const { renderEmail, clearTemplateCache, blocks } = require("../utils/emailTemplates");
const { openingHoursRows } = require("../utils/bookingNotifications");

test.beforeEach(() => {
  saved = [];
  clearTemplateCache();
});

test("default wording, variables filled and escaped, bold and paragraphs", async () => {
  const email = await renderEmail("cancellation_host", {
    firstName: "Alex",
    whoCancelled: "The guest cancelled",
    spaceName: "Tom & Jo's <studio>",
    date: "4 Nov 2026",
  });
  assert.equal(email.subject, "A booking has been cancelled");
  assert.match(email.html, /<h2[^>]*>Booking cancelled<\/h2>/);
  assert.match(email.html, /Hi <strong>Alex<\/strong>,/);
  assert.match(email.html, /<strong>Tom &amp; Jo's &lt;studio&gt;<\/strong>/);
  assert.doesNotMatch(email.html, /<studio>/);
});

test("a block variable on its own line is placed as HTML", async () => {
  const email = await renderEmail("verification", { code: blocks.code("482913") });
  assert.match(email.html, /letter-spacing:6px;">482913<\/span>/);
  assert.match(email.html, /expires in <strong>10 minutes<\/strong>/);
});

test("an admin's saved version replaces the default; a draft (preview) beats both", async () => {
  saved = [{ key: "booking_request", subject: "Request: {{spaceName}}", heading: "Someone wants your space", body: "Hello {{firstName}}" }];
  const vars = { firstName: "Alex", spaceName: "Desk 4", guestName: "Sam" };
  const edited = await renderEmail("booking_request", vars);
  assert.equal(edited.subject, "Request: Desk 4");
  assert.match(edited.html, /Someone wants your space/);
  assert.match(edited.html, /Hello Alex/);

  const preview = await renderEmail("booking_request", vars, { draft: { subject: "Draft {{guestName}}", heading: "", body: "Draft body" } });
  assert.equal(preview.subject, "Draft Sam");
  assert.doesNotMatch(preview.html, /<h2/);
});

test("the Site content emails footer replaces the default footer line, with bold and links", async () => {
  siteFooter = { value: "Questions? [Email us](mailto:support@vencome.com) **today** <b>" };
  const email = await renderEmail("cancellation_host", { firstName: "Alex" });
  assert.match(email.html, /Questions\? <a href="mailto:support@vencome.com"[^>]*>Email us<\/a> <strong>today<\/strong> &lt;b&gt;/);
  assert.doesNotMatch(email.html, /automated message/);
  siteFooter = null;
});

test("a custom footer replaces the automated-message line (the reminder's unsubscribe link)", async () => {
  const email = await renderEmail("verify_reminder", { firstName: "Sam", button: "" }, { footer: '<a href="https://x/unsub">Unsubscribe</a>' });
  assert.match(email.html, /Unsubscribe<\/a>/);
  assert.doesNotMatch(email.html, /automated message/);
});

test("opening hours: one row per booked day; closed days say Closed; 24h listings say so", () => {
  const availability = { openDays: ["Monday", "Tuesday"], openTime: "09:00", closeTime: "17:00" };
  // Mon 2 Nov 09:00 -> Wed 4 Nov 10:00 (UK, GMT): Mon, Tue and Wed are booked days
  const rows = openingHoursRows([{ checkIn: new Date("2026-11-02T09:00:00Z"), checkOut: new Date("2026-11-04T10:00:00Z") }], availability);
  assert.match(rows, /Opening hours/);
  assert.match(rows, />Mon 2 Nov<\/td>\s*<td[^>]*>09:00–17:00/);
  assert.match(rows, />Tue 3 Nov<\/td>\s*<td[^>]*>09:00–17:00/);
  assert.match(rows, />Wed 4 Nov<\/td>\s*<td[^>]*>Closed/);

  const allDay = openingHoursRows([{ checkIn: new Date("2026-11-02T09:00:00Z"), checkOut: new Date("2026-11-02T12:00:00Z") }], { is24Hours: true });
  assert.match(allDay, /Open 24 hours/);
});

test("opening hours: a month-long booking shows the weekly pattern instead of 30 rows", () => {
  const availability = { openDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], openTime: "08:00", closeTime: "18:00" };
  const rows = openingHoursRows([{ checkIn: new Date("2026-11-01T09:00:00Z"), checkOut: new Date("2026-12-01T09:00:00Z") }], availability);
  assert.match(rows, /Opening hours/);
  assert.match(rows, /Monday<\/td>\s*<td[^>]*>08:00–18:00/);
  assert.match(rows, /Sunday<\/td>\s*<td[^>]*>Closed/);
  assert.equal((rows.match(/<tr>/g) || []).length, 8);
});
