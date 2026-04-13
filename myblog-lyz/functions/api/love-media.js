import { getStore, internalError, json, methodNotAllowed } from "../_lib/store.js";

const KEY_PREFIX = "love-media:item:";
const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB, free-plan friendly

function safeName(name = "file") {
  return String(name).replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").slice(0, 80);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const store = await getStore(env);

  try {
    const keyParam = (params?.key || "").trim();

    if (request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file.arrayBuffer !== "function") {
        return json({ error: "file is required" }, 400);
      }
      if ((file.size || 0) > MAX_FILE_SIZE) {
        return json({ error: "file too large (max 4MB on free plan mode)" }, 413);
      }

      const id = crypto.randomUUID();
      const fileName = safeName(file.name || "upload.bin");
      const storageKey = KEY_PREFIX + id;
      const contentType = file.type || "application/octet-stream";
      const raw = await file.arrayBuffer();

      await store.put(storageKey, JSON.stringify({
        id,
        name: file.name || fileName,
        type: contentType,
        size: file.size || 0,
        base64: arrayBufferToBase64(raw),
        createdAt: new Date().toISOString(),
      }));

      return json({
        key: id,
        name: file.name || fileName,
        type: contentType,
        size: file.size || 0,
        url: `/api/love-media/${encodeURIComponent(id)}`,
      });
    }

    if (request.method === "GET") {
      if (!keyParam) return json({ error: "key is required" }, 400);
      const payload = await store.get(KEY_PREFIX + decodeURIComponent(keyParam), { type: "json" });
      if (!payload || !payload.base64) return json({ error: "not found" }, 404);
      const bytes = base64ToUint8Array(payload.base64);
      return new Response(bytes, {
        headers: {
          "Content-Type": payload.type || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (request.method === "DELETE") {
      if (!keyParam) return json({ error: "key is required" }, 400);
      if (typeof store.delete === "function") {
        await store.delete(KEY_PREFIX + decodeURIComponent(keyParam));
      } else {
        await store.put(KEY_PREFIX + decodeURIComponent(keyParam), "null");
      }
      return json({ success: true });
    }

    return methodNotAllowed();
  } catch (error) {
    return internalError(error);
  }
}
