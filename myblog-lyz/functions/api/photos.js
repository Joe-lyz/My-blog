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

const LEGACY_KEY = "photos";
const INDEX_KEY = "photos:index";
const ITEM_KEY_PREFIX = "photos:item:";

function toPhotoId(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function photoItemKey(id) {
  return ITEM_KEY_PREFIX + toPhotoId(id);
}

async function loadPhotoIndex(env) {
  const index = ensureArray(await readKVJson(env, INDEX_KEY, []));
  if (index.length > 0) return index.map(toPhotoId).filter(Boolean);

  const legacyPhotos = ensureArray(await readKVJson(env, LEGACY_KEY, []));
  if (legacyPhotos.length === 0) return [];

  const migratedIndex = [];
  for (const photo of legacyPhotos) {
    const id = toPhotoId(photo?.id);
    if (!id) continue;
    await writeKVJson(env, photoItemKey(id), photo);
    migratedIndex.push(id);
  }

  await writeKVJson(env, INDEX_KEY, migratedIndex);
  return migratedIndex;
}

async function loadPhotos(env) {
  const index = await loadPhotoIndex(env);
  const photos = [];
  for (const id of index) {
    const photo = await readKVJson(env, photoItemKey(id), null);
    if (photo && typeof photo === "object") photos.push(photo);
  }
  return photos;
}

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (request.method === "GET") {
      const photos = await loadPhotos(env);
      return json(photos);
    }

    if (request.method === "POST") {
      const photo = await parseJsonBody(request);
      if (!photo) return json({ error: "Invalid JSON" }, 400);

      const id = toPhotoId(photo.id);
      if (!id) return json({ error: "Photo id is required" }, 400);

      const index = await loadPhotoIndex(env);
      if (!index.includes(id)) index.push(id);

      await writeKVJson(env, photoItemKey(id), photo);
      await writeKVJson(env, INDEX_KEY, index);
      return json({ ok: true });
    }

    if (request.method === "PUT") {
      const updated = await parseJsonBody(request);
      if (!updated) return json({ error: "Invalid JSON" }, 400);

      const id = toPhotoId(updated.id);
      if (!id) return json({ error: "Photo id is required" }, 400);

      const index = await loadPhotoIndex(env);
      if (!index.includes(id)) return json({ error: "Not found" }, 404);

      await writeKVJson(env, photoItemKey(id), updated);

      return json({ ok: true });
    }

    if (request.method === "DELETE") {
      const body = await parseJsonBody(request);
      if (!body || body.id === undefined) return json({ error: "Invalid JSON" }, 400);

      const id = toPhotoId(body.id);
      const index = await loadPhotoIndex(env);
      const nextIndex = index.filter((photoId) => photoId !== id);

      await deleteKVKey(env, photoItemKey(id));
      await writeKVJson(env, INDEX_KEY, nextIndex);
      return json({ ok: true });
    }

    return methodNotAllowed();
  } catch (error) {
    return internalError(error);
  }
}
