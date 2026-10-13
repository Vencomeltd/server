// Strict URL slug for landing pages (spec rule 8): English, lowercase ASCII,
// single hyphens, no leading/trailing hyphens. Deliberately separate from
// utils/slugify.js generateSlug, whose output is baked into live URLs today
// (e.g. /hair-studio/islington-london-) and must not change until those
// URLs are redirected.
function toUrlSlug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { toUrlSlug };
