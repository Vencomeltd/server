// The name a host is shown under to guests, decided here so the account
// flags (isTestAccount, accountFlag) and an unverified business name never
// leave the server. Order: their VERIFIED business name, else their profile
// name, else their first name, else "Host". A VenCome-sounding name is only
// ever shown for VenCome's own (internal) accounts -- a third-party host must
// never look like VenCome owns the space. The client keeps the same rule in
// src/utils/hostName.js as a backstop.
// Word start only, so a name like "Stevencombe" is not caught.
const VENCOME_NAME = /\bven\s*com/i;

// Fields hostPublicName() needs; publicHost() strips the private ones again.
const HOST_NAME_FIELDS = "displayName firstName businessVerification.companyName businessVerification.status accountFlag";

function verifiedCompanyName(user) {
  const verification = user?.businessVerification;
  return verification?.status === "verified" ? verification.companyName : undefined;
}

function hostPublicName(host) {
  if (!host) return "Host";
  const ownAccount = host.accountFlag === "internal";
  const candidates = [verifiedCompanyName(host), host.displayName, host.firstName];
  for (const candidate of candidates) {
    const name = (candidate || "").trim();
    if (name && (ownAccount || !VENCOME_NAME.test(name))) return name;
  }
  return "Host";
}

// A host as guests may see them: publicName added, the flags removed, and
// the business name kept only once it is verified. Takes a Mongoose doc or a
// plain object (cached JSON too); an unpopulated id is returned unchanged.
function publicHost(host) {
  if (!host || typeof host !== "object" || host._bsontype) return host;
  const plain = typeof host.toObject === "function" ? host.toObject() : { ...host };
  const companyName = verifiedCompanyName(plain);
  const { isTestAccount, accountFlag, businessVerification, ...rest } = plain;
  return {
    ...rest,
    ...(companyName && { businessVerification: { companyName, status: "verified" } }),
    // Already decided (a cached public copy no longer has accountFlag).
    publicName: plain.publicName ?? hostPublicName(plain),
  };
}

// Populate option for a guest-facing host: the given fields plus what the
// public name needs, passed through publicHost().
function publicHostPopulate(fields) {
  return { path: "host", select: `${fields} ${HOST_NAME_FIELDS}`, transform: publicHost };
}

// A listing (or cached listing JSON) with its host made public.
function publicListing(property) {
  return property?.host ? { ...property, host: publicHost(property.host) } : property;
}

module.exports = { hostPublicName, publicHost, publicHostPopulate, publicListing, HOST_NAME_FIELDS };
