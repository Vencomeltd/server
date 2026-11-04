const PDFDocument = require("pdfkit");
const path = require("path");

const COMPANY = {
  name: "Vencome Ltd",
  number: "17182804",
  address: "Registered address pending confirmation",
  email: "support@vencome.com",
};

async function generateInvoicePDF(booking, property, guest, host) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const NAVY = "#0A1628";
    const BLUE = "#305CDE";
    const GREY = "#6B7280";
    const LINE = "#E5E7EB";
    const left = 50;
    const width = doc.page.width - 100;
    const right = left + width;
    const money = (pence) => `£${(pence / 100).toFixed(2)}`;
    const date = (value) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
    const name = (person) => person?.displayName || [person?.firstName, person?.lastName].filter(Boolean).join(" ") || person?.email || "";
    const put = (value, x, y, w, size = 9, font = "Helvetica", color = GREY, align = "left") => {
      doc.font(font).fontSize(size).fillColor(color).text(String(value), x, y, { width: w, align });
      return doc.y;
    };
    const line = (y) => doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
    const ref = booking._id.toString().slice(-8).toUpperCase();
    const invoiceNumber = `VC-${ref}`;

    doc.image(path.join(__dirname, "../assets/vencome-logo-blue.png"), left, 48, { width: 122 });
    put("Commercial spaces booked simply", left, 91, 260, 9);
    put("INVOICE", 365, 48, 180, 26, "Helvetica-Bold", NAVY, "right");
    put(invoiceNumber, 365, 82, 180, 10, "Helvetica", GREY, "right");
    doc.moveTo(left, 113).lineTo(right, 113).lineWidth(2).strokeColor(BLUE).stroke();

    const metadata = [["INVOICE NUMBER", invoiceNumber], ["ISSUE DATE", date(new Date())], ["BOOKING REFERENCE", ref]];
    metadata.forEach(([label, value], i) => {
      put(label, left + i * 170, 133, 150, 8, "Helvetica-Bold");
      put(value, left + i * 170, 147, 150, 10, "Helvetica-Bold", NAVY);
    });

    const address = [property.location?.address, property.location?.city, property.location?.country].filter(Boolean).join(", ");
    const parties = [
      ["FROM", COMPANY.name, `Company no. ${COMPANY.number}\n${COMPANY.address}\n${COMPANY.email}`],
      ["BILLED TO (CUSTOMER)", name(guest), [guest.businessVerification?.companyName, guest.email].filter(Boolean).join("\n")],
      ["HOST", host?.businessVerification?.companyName || name(host) || "Host", [property.title, address].filter(Boolean).join("\n")],
    ];
    const columnWidth = (width - 48) / 3;
    const partyHeight = Math.max(...parties.map(([, title, body]) => {
      doc.font("Helvetica-Bold").fontSize(10);
      const titleHeight = doc.heightOfString(title, { width: columnWidth });
      doc.font("Helvetica").fontSize(9);
      return 44 + titleHeight + doc.heightOfString(body, { width: columnWidth });
    }));
    doc.roundedRect(left, 177, width, partyHeight, 8).fill("#F5F7FF");
    parties.forEach(([label, title, body], i) => {
      const x = left + 12 + i * (columnWidth + 12);
      put(label, x, 191, columnWidth, 8, "Helvetica-Bold");
      const end = put(title, x, 205, columnWidth, 10, "Helvetica-Bold", NAVY);
      put(body, x, end + 4, columnWidth, 9, "Helvetica", NAVY);
    });

    const bd = booking.pricingBreakdown;
    // Use stored booking amounts. Never reprice an existing booking here.
    const total = Math.round(Number(booking.totalPrice) * 100);
    const core = bd?.totalPence ? bd.corePence : total;
    const utilities = bd?.totalPence ? bd.utilitiesPence || 0 : 0;
    const vat = bd?.totalPence ? bd.vatPence || 0 : 0;
    const quantity = booking.totalUnits || booking.totalNights || booking.totalHours || 1;
    let y = 177 + partyHeight + 19;
    y = put(`Booking: ${property.title || "Commercial Space"} · ${date(booking.checkIn)} – ${date(booking.checkOut)}`, left, y, width, 9) + 17;
    put("DESCRIPTION", left + 6, y, 245, 8, "Helvetica-Bold");
    put("QTY", 306, y, 35, 8, "Helvetica-Bold", GREY, "right");
    put("RATE", 351, y, 78, 8, "Helvetica-Bold", GREY, "right");
    put("AMOUNT", 441, y, right - 441, 8, "Helvetica-Bold", GREY, "right");
    y += 18;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1.2).strokeColor(NAVY).stroke();

    const rows = [["Space hire (core price)", quantity, core], ...(utilities ? [["Utilities", quantity, utilities]] : []), ["Service fee", 1, 0]];
    for (const [label, qty, amount] of rows) {
      y += 12;
      put(label, left + 6, y, 245, 10, "Helvetica", NAVY);
      put(qty, 306, y, 35, 10, "Helvetica", NAVY, "right");
      put(money(amount / qty), 351, y, 78, 10, "Helvetica", NAVY, "right");
      put(money(amount), 441, y, right - 441, 10, "Helvetica", NAVY, "right");
      y += 25;
      line(y);
    }

    y += 18;
    const totalX = 315;
    const totalWidth = right - totalX;
    put("Subtotal (ex VAT)", totalX + 6, y, 145, 9, "Helvetica", NAVY);
    put(money(core + utilities), totalX, y, totalWidth, 9, "Helvetica", NAVY, "right");
    y += 21;
    if (vat) {
      put(`VAT at ${bd.vatRatePct}%`, totalX + 6, y, 145, 9, "Helvetica", NAVY);
      put(money(vat), totalX, y, totalWidth, 9, "Helvetica", NAVY, "right");
      y += 21;
    }
    doc.roundedRect(totalX, y, totalWidth, 34, 6).fill(NAVY);
    put("Total", totalX + 9, y + 10, 80, 12, "Helvetica-Bold", "#FFFFFF");
    put(money(total), totalX + 90, y + 10, totalWidth - 100, 12, "Helvetica-Bold", "#FFFFFF", "right");
    y += 45;
    put(booking.isPaid ? "PAID" : "Payment pending", totalX, y, totalWidth, 9, "Helvetica-Bold", booking.isPaid ? "#059669" : GREY, "right");

    // Keep footer text inside the printable area so PDFKit doesn't add blank pages.
    const footerY = Math.max(y + 38, doc.page.height - 137);
    line(footerY);
    put("Payment terms.", left, footerY + 15, 285, 8, "Helvetica-Bold", NAVY);
    put("This invoice covers the booking charges shown above. Payments and refunds follow the terms accepted for this booking.", left, footerY + 29, 285, 8);
    put("Questions about this invoice?", 355, footerY + 15, right - 355, 8, "Helvetica-Bold", NAVY);
    put(`${COMPANY.email}\nwww.vencome.com`, 355, footerY + 29, right - 355, 8);
    put(`${COMPANY.name} · Registered in England and Wales · Company no. ${COMPANY.number}`, left, footerY + 70, width, 8);
    doc.end();
  });
}

module.exports = { generateInvoicePDF };
