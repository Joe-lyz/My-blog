import { deleteKVKey, detectStoreMode, getStore, internalError, json, methodNotAllowed, readKVJson, writeKVJson } from "../_lib/store.js";

const META_PREFIX = "travel:media:item:";
const TRIP_INDEX_PREFIX = "travel:media:index:";
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const R2_MAX_SIZE = 8 * 1024 * 1024;
const FALLBACK_MAX_SIZE = 1024 * 1024;

function safePart(value, fallback) {
  const part = String(value || "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return part || fallback;
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function rememberMedia(env, metadata) {
  await writeKVJson(env, META_PREFIX + metadata.key, metadata);
  const indexKey = TRIP_INDEX_PREFIX + metadata.tripId;
  const index = await readKVJson(env, indexKey, []);
  if (!index.includes(metadata.key)) index.push(metadata.key);
  await writeKVJson(env, indexKey, index);
}

export async function deleteTravelMedia(env, key) {
  const decodedKey = decodeURIComponent(String(key || ""));
  const metadata = await readKVJson(env, META_PREFIX + decodedKey, null);
  if (env?.TRAVEL_MEDIA) await env.TRAVEL_MEDIA.delete(decodedKey);
  await deleteKVKey(env, "travel:media:blob:" + decodedKey);
  await deleteKVKey(env, META_PREFIX + decodedKey);
  if (metadata?.tripId) {
    const indexKey = TRIP_INDEX_PREFIX + metadata.tripId;
    const index = await readKVJson(env, indexKey, []);
    await writeKVJson(env, indexKey, index.filter((item) => item !== decodedKey));
  }
  return Boolean(metadata);
}

export async function deleteTripMedia(env, tripId) {
  const indexKey = TRIP_INDEX_PREFIX + tripId;
  const keys = await readKVJson(env, indexKey, []);
  for (const key of keys) await deleteTravelMedia(env, key);
  await deleteKVKey(env, indexKey);
}

export async function onRequest({ request, env, params }) {
  try {
    const key = String(params?.key || "").replace(/^\/+/, "");
    if (request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      const tripId = safePart(form.get("tripId"), "trip");
      const stopId = safePart(form.get("stopId"), "stop");
      if (!file || typeof file.arrayBuffer !== "function") return json({ error: "file is required", code: "FILE_REQUIRED" }, 400);
      if (!ALLOWED_TYPES.has(file.type)) return json({ error: "Unsupported media type", code: "UNSUPPORTED_MEDIA_TYPE" }, 415);
      const limit = env?.TRAVEL_MEDIA ? R2_MAX_SIZE : FALLBACK_MAX_SIZE;
      if (!file.size || file.size > limit) return json({ error: `File too large (max ${limit / 1024 / 1024}MB)`, code: "FILE_TOO_LARGE" }, 413);

      const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
      const storageKey = `travel/${tripId}/${stopId}/${crypto.randomUUID()}.${extension}`;
      const raw = await file.arrayBuffer();
      const metadata = {
        key: storageKey, tripId, stopId, name: safePart(file.name, `photo.${extension}`),
        type: file.type, size: file.size, createdAt: new Date().toISOString(), storage: env?.TRAVEL_MEDIA ? "r2" : detectStoreMode(env),
      };
      if (env?.TRAVEL_MEDIA) {
        await env.TRAVEL_MEDIA.put(storageKey, raw, { httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { tripId, stopId } });
      } else {
        await (await getStore(env)).put("travel:media:blob:" + storageKey, JSON.stringify({ base64: bytesToBase64(raw), type: file.type }));
      }
      await rememberMedia(env, metadata);
      return json({ ...metadata, url: `/api/travel-media/${storageKey}` }, 201);
    }

    if (request.method === "GET") {
      if (!key) return json({ error: "key is required", code: "KEY_REQUIRED" }, 400);
      const decodedKey = decodeURIComponent(key);
      const metadata = await readKVJson(env, META_PREFIX + decodedKey, null);
      if (!metadata) return json({ error: "Media not found", code: "NOT_FOUND" }, 404);
      let body;
      if (env?.TRAVEL_MEDIA) {
        const object = await env.TRAVEL_MEDIA.get(decodedKey);
        if (!object) return json({ error: "Media not found", code: "NOT_FOUND" }, 404);
        body = object.body;
      } else {
        const payload = await readKVJson(env, "travel:media:blob:" + decodedKey, null);
        if (!payload?.base64) return json({ error: "Media not found", code: "NOT_FOUND" }, 404);
        body = base64ToBytes(payload.base64);
      }
      return new Response(body, { headers: { "Content-Type": metadata.type, "Cache-Control": "public, max-age=31536000, immutable", "Content-Disposition": `inline; filename="${metadata.name}"` } });
    }

    if (request.method === "DELETE") {
      if (!key) return json({ error: "key is required", code: "KEY_REQUIRED" }, 400);
      const found = await deleteTravelMedia(env, key);
      return found ? json({ success: true }) : json({ error: "Media not found", code: "NOT_FOUND" }, 404);
    }
    return methodNotAllowed();
  } catch (error) {
    return internalError(error);
  }
}
