// Admin Documents drive (build spec section 9.1), mounted at
// /api/admin/documents, full admins only. Folders, upload (up to 50 MB per
// file), rename, move, delete (with confirm, audit-logged), signed download
// links, folder download as a zip, and search by file name.
const express = require("express");
const multer = require("multer");
const archiver = require("archiver");
const { body, param, query, validationResult } = require("express-validator");
const { adminAuth, requireAdminRole } = require("../middleware/auth");
const Document = require("../models/Document");
const DocumentFolder = require("../models/DocumentFolder");
const storage = require("../utils/documentStorage");

const router = express.Router();
router.use(adminAuth, requireAdminRole());

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 20 } });

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

// "/ Contracts//2026 /" -> "Contracts/2026"; null if it isn't a valid path.
function cleanFolder(raw) {
  const parts = String(raw || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.length > 80) || parts.length > 8) return null;
  return parts.join("/");
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The folder itself and everything below it ("" = the whole drive).
const insideFolder = (folder) => (folder ? { $regex: `^${escapeRegex(folder)}(/|$)` } : { $exists: true });
const audit = (req, what) => console.log(`[Audit] Admin ${req.user.id} ${what}`);

// GET /?folder=Contracts -- that folder's subfolders and files.
// GET /?q=lease -- files anywhere whose name matches.
router.get("/", async (req, res) => {
  try {
    const uploader = ["uploadedBy", "firstName lastName displayName email"];
    if (req.query.q) {
      const documents = await Document.find({ name: { $regex: escapeRegex(String(req.query.q)), $options: "i" } })
        .populate(...uploader)
        .sort({ name: 1 })
        .limit(200);
      return res.json({ folder: null, folders: [], documents });
    }
    const folder = cleanFolder(req.query.folder);
    if (folder === null) return res.status(400).json({ error: "Invalid folder" });

    const [documents, fileFolders, emptyFolders] = await Promise.all([
      Document.find({ folder }).populate(...uploader).sort({ name: 1 }),
      Document.distinct("folder", { folder: insideFolder(folder) }),
      DocumentFolder.distinct("path", { path: insideFolder(folder) }),
    ]);
    // Immediate children of this folder.
    const prefix = folder ? `${folder}/` : "";
    const children = new Set(
      [...fileFolders, ...emptyFolders]
        .filter((path) => path && path !== folder && path.startsWith(prefix))
        .map((path) => prefix + path.slice(prefix.length).split("/")[0])
    );
    res.json({ folder, folders: [...children].sort(), documents });
  } catch (err) {
    console.error("List documents error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /folders -- { path } create a folder.
router.post("/folders", [body("path").isString()], validate, async (req, res) => {
  const path = cleanFolder(req.body.path);
  if (!path) return res.status(400).json({ error: "Enter a folder name" });
  await DocumentFolder.updateOne({ path }, { $setOnInsert: { path, createdBy: req.user.id } }, { upsert: true });
  res.status(201).json({ path });
});

// PATCH /folders -- { from, to } rename or move a folder (and everything in it).
router.patch("/folders", [body("from").isString(), body("to").isString()], validate, async (req, res) => {
  try {
    const from = cleanFolder(req.body.from);
    const to = cleanFolder(req.body.to);
    if (!from || !to) return res.status(400).json({ error: "Invalid folder" });
    if (to === from || to.startsWith(`${from}/`)) return res.status(400).json({ error: "A folder can't move inside itself" });
    const rename = (path) => to + path.slice(from.length);

    const docs = await Document.find({ folder: insideFolder(from) }).select("folder");
    await Promise.all(docs.map((d) => Document.updateOne({ _id: d._id }, { folder: rename(d.folder) })));
    const folders = await DocumentFolder.find({ path: insideFolder(from) });
    for (const f of folders) {
      // A folder of the same name may already exist at the destination.
      await DocumentFolder.updateOne({ _id: f._id }, { path: rename(f.path) }).catch(() => DocumentFolder.deleteOne({ _id: f._id }));
    }
    await DocumentFolder.updateOne({ path: to }, { $setOnInsert: { path: to, createdBy: req.user.id } }, { upsert: true });
    audit(req, `moved document folder "${from}" to "${to}" (${docs.length} files)`);
    res.json({ path: to, moved: docs.length });
  } catch (err) {
    console.error("Move folder error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /folders?path=X&confirm=true -- the folder and every file in it.
router.delete("/folders", [query("path").isString(), query("confirm").equals("true").withMessage("Confirm the delete")], validate, async (req, res) => {
  try {
    const path = cleanFolder(req.query.path);
    if (!path) return res.status(400).json({ error: "Invalid folder" });
    const docs = await Document.find({ folder: insideFolder(path) });
    for (const doc of docs) {
      await storage.deleteFile(doc.key).catch((err) => console.error(`[Documents] R2 delete failed for ${doc.key}:`, err.message));
      await Document.deleteOne({ _id: doc._id });
    }
    await DocumentFolder.deleteMany({ path: insideFolder(path) });
    audit(req, `deleted document folder "${path}" (${docs.length} files)`);
    res.json({ deleted: docs.length });
  } catch (err) {
    console.error("Delete folder error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /folders/zip?path=X -- the folder (and its subfolders) as one zip.
router.get("/folders/zip", [query("path").optional().isString()], validate, async (req, res) => {
  const path = cleanFolder(req.query.path);
  if (path === null) return res.status(400).json({ error: "Invalid folder" });
  try {
    const docs = await Document.find({ folder: insideFolder(path) }).sort({ folder: 1, name: 1 });
    res.attachment(`${(path || "Documents").split("/").pop()}.zip`);
    const zip = archiver("zip", { zlib: { level: 6 } });
    zip.on("error", (err) => {
      console.error("Folder zip error:", err.message);
      res.destroy(err);
    });
    zip.pipe(res);
    const seen = new Set();
    for (const doc of docs) {
      const relativeFolder = path ? doc.folder.slice(path.length).replace(/^\//, "") : doc.folder;
      let entry = relativeFolder ? `${relativeFolder}/${doc.name}` : doc.name;
      while (seen.has(entry)) entry = entry.replace(/(\.[^./]*)?$/, " (copy)$1");
      seen.add(entry);
      zip.append(await storage.fileStream(doc.key), { name: entry });
    }
    await zip.finalize();
    audit(req, `downloaded document folder "${path || "/"}" as a zip (${docs.length} files)`);
  } catch (err) {
    console.error("Folder zip error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't build the zip" });
    else res.destroy(err);
  }
});

// POST /upload -- multipart files (+ folder). Up to 50 MB each.
router.post(
  "/upload",
  (req, res, next) =>
    upload.array("files")(req, res, (err) => {
      if (err?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "Each file can be up to 50 MB" });
      if (err) return res.status(400).json({ error: err.message });
      next();
    }),
  async (req, res) => {
    try {
      const folder = cleanFolder(req.body.folder);
      if (folder === null) return res.status(400).json({ error: "Invalid folder" });
      if (!req.files?.length) return res.status(400).json({ error: "Choose at least one file" });
      const created = [];
      for (const file of req.files) {
        const name = Buffer.from(file.originalname, "latin1").toString("utf8"); // multer reads names as latin1
        const key = storage.newKey(name);
        await storage.putFile(key, file.buffer, file.mimetype);
        created.push(await Document.create({ name, folder, key, size: file.size, mimeType: file.mimetype, uploadedBy: req.user.id }));
      }
      audit(req, `uploaded ${created.length} document(s) to "${folder || "/"}"`);
      res.status(201).json({ documents: created });
    } catch (err) {
      console.error("Upload documents error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

const idParam = param("id").isMongoId().withMessage("Invalid document");

// GET /:id/download -- a signed link, valid for 5 minutes.
router.get("/:id/download", [idParam], validate, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    res.json({ url: await storage.downloadUrl(doc.key, doc.name) });
  } catch (err) {
    console.error("Document download error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /:id -- { name?, folder? } rename or move a file.
router.patch(
  "/:id",
  [idParam, body("name").optional().isString().trim().isLength({ min: 1, max: 200 }), body("folder").optional().isString()],
  validate,
  async (req, res) => {
    try {
      const doc = await Document.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const before = `${doc.folder}/${doc.name}`;
      if (req.body.name !== undefined) doc.name = req.body.name;
      if (req.body.folder !== undefined) {
        const folder = cleanFolder(req.body.folder);
        if (folder === null) return res.status(400).json({ error: "Invalid folder" });
        doc.folder = folder;
      }
      await doc.save();
      audit(req, `renamed/moved document "${before}" to "${doc.folder}/${doc.name}"`);
      res.json({ document: doc });
    } catch (err) {
      console.error("Update document error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// DELETE /:id?confirm=true
router.delete("/:id", [idParam, query("confirm").equals("true").withMessage("Confirm the delete")], validate, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await storage.deleteFile(doc.key).catch((err) => console.error(`[Documents] R2 delete failed for ${doc.key}:`, err.message));
    await Document.deleteOne({ _id: doc._id });
    audit(req, `deleted document "${doc.folder}/${doc.name}"`);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete document error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
module.exports.cleanFolder = cleanFolder;
