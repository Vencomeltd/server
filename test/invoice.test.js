// Real PDF output, using wholly synthetic booking and account data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { inflateSync } = require("node:zlib");
const { generateInvoicePDF } = require("../utils/generateInvoice");

function textOf(pdf) {
  let text = "";
  for (const match of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let stream;
    try { stream = inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"); }
    catch { continue; }
    text += [...stream.matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("");
  }
  return text;
}

const sample = () => ({
  booking: {
    _id: "64b00000000000004f2a91c7", isPaid: true, totalPrice: 660, totalNights: 5,
    pricingUnit: "day", totalUnits: 5, checkIn: "2026-11-02T09:00:00Z", checkOut: "2026-11-06T17:00:00Z",
    pricingBreakdown: { corePence: 50000, utilitiesPence: 5000, vatPence: 11000, vatRatePct: 20, totalPence: 66000, commissionPence: 5000 },
  },
  property: { title: "Agent-created QA office", location: { address: "12 Example Street", city: "London", country: "United Kingdom" } },
  guest: { displayName: "Sam Taylor", businessVerification: { companyName: "Taylor Design Studio Ltd" }, email: "sam@example.com" },
  host: { businessVerification: { companyName: "Synthetic Workspaces" }, email: "host@example.com" },
});
const render = (s) => generateInvoicePDF(s.booking, s.property, s.guest, s.host);

test("approved invoice uses the logo, tagline and VenCome company details", async () => {
  const pdf = await render(sample());
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(/\/Subtype \/Image/.test(pdf.toString("latin1")), "logo image is embedded");
  assert.equal([...pdf.toString("latin1").matchAll(/\/Type \/Page\b/g)].length, 1);
  const text = textOf(pdf);
  assert.match(text, /Commercial spaces booked simply/);
  assert.match(text, /17182804/);
  assert.match(text, /Flat 4, Spring House/);
  assert.match(text, /Kingston Road/);
  assert.match(text, /SW19 3NJ/);
  assert.doesNotMatch(text, /pending confirmation/);
  assert.match(text, /Synthetic Workspaces/);
  assert.doesNotMatch(text, /VAT no\.|GB 000|00000000/);
});

test("booking VAT is preserved without presenting a VenCome VAT number or commission fee", async () => {
  const s = sample();
  const before = JSON.stringify(s);
  const text = textOf(await render(s));
  for (const amount of ["£500.00", "£50.00", "£110.00", "£660.00"]) assert.ok(text.includes(amount), amount);
  assert.match(text, /VAT at 20%/);
  assert.doesNotMatch(text, /Platform fee|commission/i);
  assert.equal(JSON.stringify(s), before);
});

test("legacy invoices preserve the stored total without adding VAT", async () => {
  const s = sample();
  delete s.booking.pricingBreakdown;
  s.booking.totalPrice = 100;
  const text = textOf(await render(s));
  assert.ok(text.includes("£100.00"));
  assert.doesNotMatch(text, /VAT at/);
});

test("monthly invoices use the saved billing units rather than the number of days", async () => {
  const s = sample();
  Object.assign(s.booking, { pricingUnit: "month", totalUnits: 1, totalNights: 30, totalPrice: 869.4 });
  s.booking.pricingBreakdown = { corePence: 72450, utilitiesPence: 0, vatPence: 14490, vatRatePct: 20, totalPence: 86940 };
  assert.match(textOf(await render(s)), /Space hire \(core price\)1£724\.50£724\.50/);
});
