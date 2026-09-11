// Proxies Google Cloud Translation API v2 so the client never needs (or
// exposes) the API key directly. Whole-page dynamic translation -- the
// client walks the rendered DOM and sends batches of visible text here,
// rather than maintaining per-string translation files per language.
//
// Graceful no-op when GOOGLE_TRANSLATE_API_KEY isn't set: echoes the
// original text back unchanged instead of erroring, so the language
// switcher still "works" (just doesn't translate) until a key is added.
const express = require("express");
const router = express.Router();

router.post("/", async (req, res) => {
  const { texts, target } = req.body;
  if (!Array.isArray(texts) || texts.length === 0 || !target) {
    return res.status(400).json({ error: "texts (array) and target are required" });
  }
  if (texts.length > 100) {
    return res.status(400).json({ error: "Max 100 texts per request" });
  }

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    return res.json({ translations: texts });
  }

  try {
    const response = await fetch(
      `https://translation.googleapis.com/language/translate2?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: texts, target, format: "text" }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      console.error("Google Translate error:", data.error?.message || data);
      return res.json({ translations: texts });
    }
    const translations = data.data.translations.map((t) => t.translatedText);
    res.json({ translations });
  } catch (err) {
    console.error("Translate request failed:", err.message);
    res.json({ translations: texts });
  }
});

module.exports = router;
