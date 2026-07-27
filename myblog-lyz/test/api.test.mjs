import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import worker from "../worker.js";

class InMemoryKV {
  constructor() {
    this.map = new Map();
  }

  async get(key, options = {}) {
    if (!this.map.has(key)) return null;
    const raw = this.map.get(key);
    if (options.type === "json") return JSON.parse(raw);
    return raw;
  }

  async put(key, value) {
    this.map.set(key, value);
  }

  async delete(key) {
    this.map.delete(key);
  }
}

class MockD1 {
  constructor() {
    this.map = new Map();
    this.initialized = false;
  }

  async exec(sql) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS blog_kv")) {
      this.initialized = true;
    }
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async first() {
            if (sql.startsWith("SELECT value FROM blog_kv WHERE key = ?")) {
              const key = args[0];
              if (!db.map.has(key)) return null;
              return { value: db.map.get(key) };
            }
            return null;
          },
          async run() {
            if (sql.startsWith("INSERT INTO blog_kv")) {
              const [key, value] = args;
              db.map.set(key, value);
            }
            if (sql.startsWith("DELETE FROM blog_kv WHERE key = ?")) {
              const [key] = args;
              db.map.delete(key);
            }
            return { success: true };
          },
        };
      },
    };
  }
}

function makeEnv(overrides = {}) {
  return {
    BLOG_DATA: new InMemoryKV(),
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
    },
    ...overrides,
  };
}

async function call(env, path, method = "GET", body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const request = new Request(`https://example.com${path}`, init);
  const res = await worker.fetch(request, env, {});
  return { status: res.status, body: await res.json() };
}

test("posts API can save and read diary entries", async () => {
  const env = makeEnv();
  const entry = { id: 1, title: "diary", content: "hello" };

  const createRes = await call(env, "/api/posts", "POST", entry);
  assert.equal(createRes.status, 200);

  const getRes = await call(env, "/api/posts");
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.length, 1);
  assert.equal(getRes.body[0].content, "hello");
});

test("posts API recovers if existing data type is corrupted", async () => {
  const env = makeEnv();
  await env.BLOG_DATA.put("posts", JSON.stringify({ broken: true }));

  const createRes = await call(env, "/api/posts", "POST", { id: 2, title: "new" });
  assert.equal(createRes.status, 200);

  const getRes = await call(env, "/api/posts");
  assert.equal(getRes.status, 200);
  assert.equal(Array.isArray(getRes.body), true);
  assert.equal(getRes.body.length, 1);
  assert.equal(getRes.body[0].id, 2);
});



test("posts API migrates legacy posts storage to split-key format", async () => {
  const env = makeEnv();
  const legacyPosts = [
    { id: 11, title: "old-1", body: "a" },
    { id: 12, title: "old-2", body: "b" },
  ];
  await env.BLOG_DATA.put("posts", JSON.stringify(legacyPosts));

  const getRes = await call(env, "/api/posts");
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.length, 2);
  assert.equal(getRes.body[0].id, 11);

  const rawIndex = await env.BLOG_DATA.get("posts:index", { type: "json" });
  assert.deepEqual(rawIndex, ["11", "12"]);
  const rawPost11 = await env.BLOG_DATA.get("posts:item:11", { type: "json" });
  assert.equal(rawPost11.title, "old-1");
});

test("posts API delete removes post item key", async () => {
  const env = makeEnv();
  await call(env, "/api/posts", "POST", { id: 77, title: "to-delete", body: "x" });

  const beforeDelete = await env.BLOG_DATA.get("posts:item:77", { type: "json" });
  assert.equal(beforeDelete.title, "to-delete");

  const delRes = await call(env, "/api/posts", "DELETE", { id: 77 });
  assert.equal(delRes.status, 200);

  const afterDelete = await env.BLOG_DATA.get("posts:item:77");
  assert.equal(afterDelete, null);

  const getRes = await call(env, "/api/posts");
  assert.equal(getRes.body.length, 0);
});

test("photos API can save and read photos", async () => {
  const env = makeEnv();
  const photo = { id: 7, url: "https://img.example/p.jpg", caption: "test" };

  const createRes = await call(env, "/api/photos", "POST", photo);
  assert.equal(createRes.status, 200);
  assert.equal(createRes.body.ok, true);

  const getRes = await call(env, "/api/photos");
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.length, 1);
  assert.equal(getRes.body[0].id, 7);
});

test("doodles API can save and read doodles", async () => {
  const env = makeEnv();
  const doodle = { id: 77, title: "涂鸦测试", dataUrl: "data:image/png;base64,abc" };

  const createRes = await call(env, "/api/doodles", "POST", doodle);
  assert.equal(createRes.status, 200);
  assert.equal(createRes.body.ok, true);

  const getRes = await call(env, "/api/doodles");
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.length, 1);
  assert.equal(getRes.body[0].id, 77);
});

test("doodles API can delete a saved doodle", async () => {
  const env = makeEnv();
  await call(env, "/api/doodles", "POST", { id: 88, title: "待删除涂鸦", dataUrl: "data:image/png;base64,abc" });

  const deleteRes = await call(env, "/api/doodles", "DELETE", { id: 88 });
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.ok, true);

  const getRes = await call(env, "/api/doodles");
  assert.deepEqual(getRes.body, []);
  assert.equal(await env.BLOG_DATA.get("doodles:item:88"), null);
});

test("D1 binding persists diary data and can be read after reload", async () => {
  const db = new MockD1();
  const env = makeEnv({ BLOG_DB: db, BLOG_DATA: undefined });

  const createRes = await call(env, "/api/posts", "POST", { id: 99, title: "from-d1" });
  assert.equal(createRes.status, 200);
  assert.equal(db.initialized, true);

  const envAfterReload = makeEnv({ BLOG_DB: db, BLOG_DATA: undefined });
  const getRes = await call(envAfterReload, "/api/posts");
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.length, 1);
  assert.equal(getRes.body[0].id, 99);
});



test("trash API can store and restore deleted post metadata", async () => {
  const env = makeEnv();
  const item = { id: 501, title: "deleted", deletedAt: Date.now() };

  const addRes = await call(env, "/api/trash", "POST", item);
  assert.equal(addRes.status, 200);

  const getRes = await call(env, "/api/trash");
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.length, 1);
  assert.equal(getRes.body[0].id, 501);

  const delRes = await call(env, "/api/trash", "DELETE", { id: 501 });
  assert.equal(delRes.status, 200);

  const getRes2 = await call(env, "/api/trash");
  assert.equal(getRes2.body.length, 0);
});


test("version endpoint exposes build version", async () => {
  const env = makeEnv();
  const request = new Request("https://example.com/api/version");
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.version, "string");
  assert.equal(body.version.includes("hotfix"), true);
});

test("health endpoint reports active storage binding", async () => {
  const envMemory = makeEnv({ BLOG_DATA: undefined });
  const resMemory = await worker.fetch(new Request("https://example.com/api/health"), envMemory, {});
  assert.equal(resMemory.status, 200);
  const bodyMemory = await resMemory.json();
  assert.equal(bodyMemory.storeMode, "memory");
  assert.equal(bodyMemory.bindings.BLOG_DB, false);
  assert.equal(bodyMemory.bindings.BLOG_DATA, false);

  const envKv = makeEnv();
  const resKv = await worker.fetch(new Request("https://example.com/api/health"), envKv, {});
  const bodyKv = await resKv.json();
  assert.equal(bodyKv.storeMode, "kv");
  assert.equal(bodyKv.bindings.BLOG_DATA, true);

  const envD1 = makeEnv({ BLOG_DB: new MockD1(), BLOG_DATA: undefined });
  const resD1 = await worker.fetch(new Request("https://example.com/api/health"), envD1, {});
  const bodyD1 = await resD1.json();
  assert.equal(bodyD1.storeMode, "d1");
  assert.equal(bodyD1.bindings.BLOG_DB, true);
});

test("book-search endpoint maps public epub search results", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            title: "Pride and Prejudice",
            authors: [{ name: "Jane Austen" }],
            formats: {
              "application/epub+zip": "https://example.com/pride.epub",
              "image/jpeg": "https://example.com/cover.jpg",
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  try {
    const request = new Request("https://example.com/api/book-search?q=pride");
    const res = await worker.fetch(request, env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Array.isArray(body.items), true);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].source, "gutendex");
    assert.equal(body.items[0].epubUrl.includes(".epub"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("index response has anti-cache header", async () => {
  const env = makeEnv();
  const request = new Request("https://example.com/");
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 200);
  assert.equal((res.headers.get("cache-control") || "").includes("no-store"), true);
});
test("non-api requests are served by ASSETS", async () => {
  const env = makeEnv();
  const request = new Request("https://example.com/");
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "asset");
});

test("drawing board keeps background, drawing, and preview on separate layers", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/doodle-board.js", import.meta.url), "utf8");

  assert.match(html, /<canvas id="backgroundCanvas"/);
  assert.match(html, /<canvas id="drawingCanvas"/);
  assert.match(html, /<canvas id="overlayCanvas"/);
  assert.match(script, /destination-out/);
  assert.match(script, /indexedDB\.open/);
  assert.match(script, /previewDataUrl/);
});
