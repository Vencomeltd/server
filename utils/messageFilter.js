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

  const hasBannedWord = bannedWords.some((word) => lower.includes(word));
  const hasLink = linkRegex.test(lower);
  const hasEmail = emailRegex.test(text);
  const hasPhone = containsPhoneNumber(text);

  return hasBannedWord || hasLink || hasEmail || hasPhone;
}

module.exports = containsBlockedContent;
