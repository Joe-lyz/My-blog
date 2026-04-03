export const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
};

const memoryState = globalThis.__BLOG_MEMORY_KV__ || (globalThis.__BLOG_MEMORY_KV__ = new Map());
const d1InitState = globalThis.__BLOG_D1_INIT__ || (globalThis.__BLOG_D1_INIT__ = new WeakMap());

const memoryKV = {
  async get(key, options = {}) {
    if (!memoryState.has(key)) return null;
    const raw = memoryState.get(key);
    if (options.type === "json") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  },
  async put(key, value) {
    memoryState.set(key, value);
  },
  async delete(key) {
    memoryState.delete(key);
  },
};

function createD1Store(db) {
  return {
    async get(key, options = {}) {
      const row = await db.prepare("SELECT value FROM blog_kv WHERE key = ?").bind(key).first();
      if (!row || row.value == null) return null;
      if (options.type === "json") {
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      }
      return row.value;
    },
    async put(key, value) {
      await db
        .prepare("INSERT INTO blog_kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key, value)
        .run();
    },
    async delete(key) {
      await db.prepare("DELETE FROM blog_kv WHERE key = ?").bind(key).run();
    },
  };
}

async function ensureD1Ready(db) {
  let initPromise = d1InitState.get(db);
  if (!initPromise) {
    initPromise = db.exec("CREATE TABLE IF NOT EXISTS blog_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    d1InitState.set(db, initPromise);
  }
  await initPromise;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

export async function getStore(env) {
  if (env?.BLOG_DB && typeof env.BLOG_DB.prepare === "function") {
    await ensureD1Ready(env.BLOG_DB);
    return createD1Store(env.BLOG_DB);
  }

  if (env?.BLOG_DATA && typeof env.BLOG_DATA.get === "function") {
    return env.BLOG_DATA;
  }

  return memoryKV;
}

export function detectStoreMode(env) {
  if (env?.BLOG_DB && typeof env.BLOG_DB.prepare === "function") {
    return "d1";
  }

  if (env?.BLOG_DATA && typeof env.BLOG_DATA.get === "function") {
    return "kv";
  }

  return "memory";
}

export async function readKVJson(env, key, fallbackValue) {
  const value = await (await getStore(env)).get(key, { type: "json" });
  return value ?? fallbackValue;
}

export async function writeKVJson(env, key, value) {
  await (await getStore(env)).put(key, JSON.stringify(value));
}

export async function deleteKVKey(env, key) {
  const store = await getStore(env);
  if (typeof store.delete === "function") {
    await store.delete(key);
    return;
  }
  await store.put(key, "null");
}

export async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function methodNotAllowed() {
  return json({ error: "Method not allowed" }, 405);
}

export function internalError(error) {
  return json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
