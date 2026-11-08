const bannedWords = [
  "instagram",
  "insta",
  "facebook",
  "fb",
  "twitter",
  "x.com",
  "snapchat",
  "snap",
  "whatsapp",
  "telegram",
  "t.me",
  "discord",
  "linkedin",
  "gmail",
  "email",
  "phone",
];

// Whole words only, so "instant book", "snapshot" and "instance" are not
// caught by "insta" / "snap".
const escapeRegex = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bannedWordRegex = new RegExp(`\\b(${bannedWords.map(escapeRegex).join("|")})\\b`, "i");

// A social handle such as "@studio_jane" (an email is caught separately).
const handleRegex = /(^|[^\w.])@[a-z0-9_.]{2,}/i;

// UK postcodes, e.g. "SW19 3NJ", "M1 1AE", "sw193nj".
const postcodeRegex = /\b(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})\b/i;

// "flat 4", "unit 12".
const flatOrUnitRegex = /\b(flat|unit)\s+\d+[a-z]?\b/i;

// A house number, one to three name words, then a street type, e.g.
// "12 High Street". Words like "close", "way" and "place" are also ordinary
// English ("2 rooms close to the station"), so for those the name words must
// be capitalised.
const streetTypes = ["street", "st", "road", "rd", "avenue", "ave", "lane", "ln", "close", "drive", "way", "court", "place", "square", "crescent", "terrace"];
const unambiguousStreetTypes = ["street", "road", "rd", "avenue", "ave", "ln", "crescent", "terrace"];
const notNameWords = ["the", "a", "an", "on", "in", "to", "of", "at", "for", "and", "or", "by", "from", "near"];
function containsStreetAddress(text) {
  const words = text.split(/[^A-Za-z0-9'-]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (!/^\d+[a-z]?$/i.test(words[i])) continue;
    // Try one, two and three name words before a street type.
    for (let n = 1; n <= 3 && i + n + 1 < words.length; n++) {
      const names = words.slice(i + 1, i + 1 + n);
      const type = words[i + 1 + n].toLowerCase();
      if (!streetTypes.includes(type)) continue;
      if (names.some((word) => notNameWords.includes(word.toLowerCase()) || /^\d/.test(word))) continue;
      if (unambiguousStreetTypes.includes(type)) return true;
      if (names.every((word) => /^[A-Z]/.test(word))) return true;
    }
  }
  return false;
}

const linkRegex = /(https?:\/\/|www\.|\.com|\.net|\.org|\.io|\.me)/i;

// Matches any real email address, not just ones mentioning "gmail" by name.
const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Phone numbers weren't detected at all before -- only the literal word
// "phone" was banned, not an actual number. Requires 8+ digits once
// separators (spaces/dashes/dots/parens) are stripped out, which covers UK
// mobiles/landlines and +44 international format while not flagging
// ordinary short numbers like a price or a room size.
const phoneCandidateRegex = /(\+?\d[\d\s\-().]{6,}\d)/g;
function containsPhoneNumber(text) {
  const matches = text.match(phoneCandidateRegex) || [];
  return matches.some((match) => match.replace(/\D/g, "").length >= 8);
}

function containsBlockedContent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  const hasBannedWord = bannedWordRegex.test(lower) || handleRegex.test(text);
  const hasLink = linkRegex.test(lower);
  const hasEmail = emailRegex.test(text);
  const hasPhone = containsPhoneNumber(text);
  const hasAddress = postcodeRegex.test(text) || flatOrUnitRegex.test(text) || containsStreetAddress(text);

  return hasBannedWord || hasLink || hasEmail || hasPhone || hasAddress;
}

module.exports = containsBlockedContent;
