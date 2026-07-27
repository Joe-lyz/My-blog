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

function travelFixture() {
  const stops = [
    { id:"harbin", name:"哈尔滨", longitude:126.63, latitude:45.75, arrivedAt:"2026-07-01T08:00:00+08:00", departedAt:"2026-07-01T09:00:00+08:00", stopType:"start", participants:["person-a"], order:0 },
    { id:"shanghai", name:"上海", longitude:121.47, latitude:31.23, arrivedAt:"2026-07-01T08:00:00+08:00", departedAt:"2026-07-01T09:00:00+08:00", stopType:"start", participants:["person-b"], order:1 },
    { id:"beijing", name:"北京", longitude:116.4, latitude:39.9, arrivedAt:"2026-07-02T10:00:00+08:00", departedAt:"2026-07-03T08:00:00+08:00", stopType:"meetup", participants:["person-a","person-b"], order:2 },
    { id:"xian", name:"西安", longitude:108.94, latitude:34.34, arrivedAt:"2026-07-03T14:00:00+08:00", departedAt:"2026-07-31T23:00:00+08:00", stopType:"transport-change", participants:["person-a","person-b"], order:3 },
    { id:"chengdu", name:"成都", longitude:104.07, latitude:30.67, arrivedAt:"2026-08-01T18:00:00+08:00", departedAt:"2026-08-02T09:00:00+08:00", stopType:"destination", participants:["person-a","person-b"], order:4 },
  ];
  const segment = (id, from, to, travelerState, transportMode, startedAt, endedAt, order) => ({ id, fromStopId:from.id, toStopId:to.id, travelerState, transportMode, coordinates:[[from.longitude,from.latitude],[to.longitude,to.latitude]], startedAt, endedAt, order });
  return { title:"夏日见面旅行", description:"分别出发，在北京相见。", startDate:"2026-07-01", endDate:"2026-08-02", travelers:[{id:"person-a",name:"人物A"},{id:"person-b",name:"人物B"}], stops, segments:[
    segment("a-flight",stops[0],stops[2],"person-a","plane",stops[0].departedAt,stops[2].arrivedAt,0), segment("b-train",stops[1],stops[2],"person-b","train",stops[1].departedAt,stops[2].arrivedAt,1),
    segment("together-train",stops[2],stops[3],"together","train",stops[2].departedAt,stops[3].arrivedAt,2), segment("together-car",stops[3],stops[4],"together","car",stops[3].departedAt,stops[4].arrivedAt,3),
  ] };
}

test("travel API creates, lists, updates and deletes a two-person meetup trip", async () => {
  const env=makeEnv(); const created=await call(env,"/api/travel","POST",travelFixture());
  assert.equal(created.status,201); assert.ok(created.body.id);
  assert.deepEqual(created.body.segments.slice(0,2).map((s)=>s.travelerState),["person-a","person-b"]);
  assert.deepEqual(created.body.segments.slice(2).map((s)=>s.travelerState),["together","together"]);
  assert.deepEqual(created.body.segments.slice(2).map((s)=>s.transportMode),["train","car"]);
  assert.equal((await call(env,"/api/travel")).body.length,1);
  created.body.title="更新后的旅行"; assert.equal((await call(env,"/api/travel","PUT",created.body)).body.title,"更新后的旅行");
  assert.equal((await call(env,"/api/travel","DELETE",{id:created.body.id})).body.success,true); assert.equal((await call(env,"/api/travel")).body.length,0);
});

test("travel month filter includes segments intersecting the selected month", async () => {
  const env=makeEnv(); const created=await call(env,"/api/travel","POST",travelFixture());
  const july=await call(env,`/api/travel?id=${created.body.id}&month=2026-07`); assert.equal(july.body.stops.some((s)=>s.id==="chengdu"),false); assert.equal(july.body.segments.some((s)=>s.id==="together-car"),true);
  const august=await call(env,`/api/travel?id=${created.body.id}&month=2026-08`); assert.equal(august.body.segments.some((s)=>s.id==="together-car"),true);
});

test("travel API rejects invalid dates and coordinates", async () => {
  const env=makeEnv(),badDate=travelFixture(); badDate.startDate="not-a-date"; assert.equal((await call(env,"/api/travel","POST",badDate)).status,400);
  const badPoint=travelFixture(); badPoint.stops[0].longitude=999; assert.equal((await call(env,"/api/travel","POST",badPoint)).status,400);
});

test("travel media rejects unsupported types and fallback upload can be deleted", async () => {
  const env=makeEnv(); let form=new FormData(); form.append("tripId","trip-test"); form.append("stopId","stop-test"); form.append("file",new File(["bad"],"bad.txt",{type:"text/plain"}));
  let response=await worker.fetch(new Request("https://example.com/api/travel-media",{method:"POST",body:form}),env,{}); assert.equal(response.status,415);
  form=new FormData(); form.append("tripId","trip-test"); form.append("stopId","stop-test"); form.append("file",new File([new Uint8Array([1,2,3])],"photo.webp",{type:"image/webp"}));
  response=await worker.fetch(new Request("https://example.com/api/travel-media",{method:"POST",body:form}),env,{}); assert.equal(response.status,201); const media=await response.json(); assert.equal(media.fallback,true);
  const get=await worker.fetch(new Request(`https://example.com${media.url}`),env,{}); assert.equal(get.status,200); assert.equal((await get.arrayBuffer()).byteLength,3);
  const del=await worker.fetch(new Request(`https://example.com${media.url}`,{method:"DELETE"}),env,{}); assert.equal(del.status,200);
  assert.equal((await worker.fetch(new Request(`https://example.com${media.url}`),env,{})).status,404);
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

test("travel navigation and map expose the requested China-only editing controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/assets/travel-map.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/assets/travel-map.css", import.meta.url), "utf8");

  assert.ok(html.indexOf('data-view="travel"') < html.indexOf('data-view="list"'));
  assert.match(html, /id="travel-draw-route"/);
  assert.match(css, /nav button\[data-view="travel"\][^{]*\{[^}]*box-shadow:/s);
  assert.doesNotMatch(script, /tileLayer\(/);
  assert.match(script, /Array\.from\(\{length:6\}.*2026\+index/);
  assert.match(script, /mousedown.*beginRouteStroke/);
  assert.match(script, /mousemove.*continueRouteStroke/);
  assert.match(script, /mouseup.*finishRouteStroke/);
});
