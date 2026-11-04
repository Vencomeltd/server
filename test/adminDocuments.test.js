// Real HTTP routes with synthetic documents and stubbed storage. No live data.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

const stub = (file, exports) => {
  const id = require.resolve(path.join(__dirname, file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const id = "64b000000000000000000001";
let documents;
let deletedKeys;
let storageFailure;
let foldersDeleted;

stub("../middleware/auth", {
  adminAuth: (req, _res, next) => { req.user = { id: "synthetic-admin" }; next(); },
  requireAdminRole: () => (_req, _res, next) => next(),
});
stub("../models/Document", {
  findById: async (docId) => {
    const stored = documents.get(docId);
    if (!stored) return null;
    const doc = { ...stored };
    doc.save = async () => { documents.set(docId, { ...doc }); };
    return doc;
  },
  find: async () => [...documents.values()],
  deleteOne: async ({ _id }) => { documents.delete(_id); },
});
stub("../models/DocumentFolder", {
  deleteMany: async () => { foldersDeleted = true; },
});
stub("../utils/documentStorage", {
  deleteFile: async (key) => {
    if (storageFailure) throw new Error("Synthetic storage unavailable");
    deletedKeys.push(key);
  },
});

const app = express();
app.use(express.json());
app.use("/documents", require("../routes/adminDocuments"));
const server = app.listen(0, "127.0.0.1");
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());
test.beforeEach(() => {
  documents = new Map([[id, { _id: id, name: "synthetic.txt", folder: "QA", key: "synthetic-only/key" }]]);
  deletedKeys = [];
  storageFailure = false;
  foldersDeleted = false;
});
async function request(method, route, body) {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/documents${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

test("rename preserves the storage key and folder", async () => {
  const res = await request("PATCH", `/${id}`, { name: "renamed.txt" });
  assert.equal(res.status, 200);
  assert.equal(documents.get(id).name, "renamed.txt");
  assert.equal(documents.get(id).folder, "QA");
  assert.equal(documents.get(id).key, "synthetic-only/key");
  assert.deepEqual(deletedKeys, []);
});

test("move normalises the folder and rejects traversal", async () => {
  assert.equal((await request("PATCH", `/${id}`, { folder: " / QA // Nested / " })).status, 200);
  assert.equal(documents.get(id).folder, "QA/Nested");
  assert.equal((await request("PATCH", `/${id}`, { folder: "QA/../Other" })).status, 400);
  assert.equal(documents.get(id).folder, "QA/Nested");
});

test("file deletion requires explicit confirmation", async () => {
  assert.equal((await request("DELETE", `/${id}`)).status, 400);
  assert.ok(documents.has(id));
  assert.deepEqual(deletedKeys, []);
});

test("confirmed file deletion removes the object and its metadata", async () => {
  assert.equal((await request("DELETE", `/${id}?confirm=true`)).status, 200);
  assert.deepEqual(deletedKeys, ["synthetic-only/key"]);
  assert.equal(documents.has(id), false);
});

test("failed object deletion retains file metadata and reports failure", async () => {
  storageFailure = true;
  assert.equal((await request("DELETE", `/${id}?confirm=true`)).status, 500);
  assert.ok(documents.has(id));
});

test("failed folder object deletion retains metadata for retry", async () => {
  storageFailure = true;
  assert.equal((await request("DELETE", "/folders?path=QA&confirm=true")).status, 500);
  assert.ok(documents.has(id));
  assert.equal(foldersDeleted, false);
});
