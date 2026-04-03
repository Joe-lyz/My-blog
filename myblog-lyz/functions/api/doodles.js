import {
  deleteKVKey,
  ensureArray,
  internalError,
  json,
  methodNotAllowed,
  parseJsonBody,
  readKVJson,
  writeKVJson,
} from "../_lib/store.js";

const LEGACY_KEY = "doodles";
const INDEX_KEY = "doodles:index";
const ITEM_KEY_PREFIX = "doodles:item:";

function toDoodleId(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function doodleItemKey(id) {
  return ITEM_KEY_PREFIX + toDoodleId(id);
}

async function loadDoodleIndex(env) {
  const index = ensureArray(await readKVJson(env, INDEX_KEY, []));
  if (index.length > 0) return index.map(toDoodleId).filter(Boolean);

  const legacyDoodles = ensureArray(await readKVJson(env, LEGACY_KEY, []));
  if (legacyDoodles.length === 0) return [];

  const migratedIndex = [];
  for (const doodle of legacyDoodles) {
    const id = toDoodleId(doodle?.id);
    if (!id) continue;
    await writeKVJson(env, doodleItemKey(id), doodle);
    migratedIndex.push(id);
  }

  await writeKVJson(env, INDEX_KEY, migratedIndex);
  return migratedIndex;
}

async function loadDoodles(env) {
  const index = await loadDoodleIndex(env);
  const doodles = [];
  for (const id of index) {
    const doodle = await readKVJson(env, doodleItemKey(id), null);
    if (doodle && typeof doodle === "object") doodles.push(doodle);
  }
  return doodles;
}

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (request.method === "GET") {
      const doodles = await loadDoodles(env);
      return json(doodles);
    }

    if (request.method === "POST") {
      const doodle = await parseJsonBody(request);
      if (!doodle) return json({ error: "Invalid JSON" }, 400);

      const id = toDoodleId(doodle.id);
      if (!id) return json({ error: "Doodle id is required" }, 400);

      const index = await loadDoodleIndex(env);
      if (!index.includes(id)) index.push(id);

      await writeKVJson(env, doodleItemKey(id), doodle);
      await writeKVJson(env, INDEX_KEY, index);
      return json({ ok: true });
    }

    if (request.method === "PUT") {
      const updated = await parseJsonBody(request);
      if (!updated) return json({ error: "Invalid JSON" }, 400);

      const id = toDoodleId(updated.id);
      if (!id) return json({ error: "Doodle id is required" }, 400);

      const index = await loadDoodleIndex(env);
      if (!index.includes(id)) return json({ error: "Not found" }, 404);

      await writeKVJson(env, doodleItemKey(id), updated);
      return json({ ok: true });
    }

    if (request.method === "DELETE") {
      const body = await parseJsonBody(request);
      if (!body || body.id === undefined) return json({ error: "Invalid JSON" }, 400);

      const id = toDoodleId(body.id);
      const index = await loadDoodleIndex(env);
      const nextIndex = index.filter((doodleId) => doodleId !== id);

      await deleteKVKey(env, doodleItemKey(id));
      await writeKVJson(env, INDEX_KEY, nextIndex);
      return json({ ok: true });
    }

    return methodNotAllowed();
  } catch (error) {
    return internalError(error);
  }
}
