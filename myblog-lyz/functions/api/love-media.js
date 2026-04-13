import { internalError, json, methodNotAllowed } from "../_lib/store.js";

function getR2(env) {
  return env?.LOVE_MEDIA && typeof env.LOVE_MEDIA.put === "function" ? env.LOVE_MEDIA : null;
}

function safeName(name = "file") {
  return String(name).replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").slice(0, 80);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const bucket = getR2(env);
  if (!bucket) return json({ error: "LOVE_MEDIA R2 binding is missing" }, 500);

  try {
    const keyParam = (params?.key || "").trim();

    if (request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file.arrayBuffer !== "function") {
        return json({ error: "file is required" }, 400);
      }
      const fileName = safeName(file.name || "upload.bin");
      const id = crypto.randomUUID();
      const key = `love-media/${id}-${fileName}`;
      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: {
          contentType: file.type || "application/octet-stream",
        },
      });
      return json({
        key,
        name: file.name || fileName,
        type: file.type || "application/octet-stream",
        size: file.size || 0,
        url: `/api/love-media/${encodeURIComponent(key)}`,
      });
    }

    if (request.method === "GET") {
      if (!keyParam) return json({ error: "key is required" }, 400);
      const object = await bucket.get(decodeURIComponent(keyParam));
      if (!object) return json({ error: "not found" }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    if (request.method === "DELETE") {
      if (!keyParam) return json({ error: "key is required" }, 400);
      await bucket.delete(decodeURIComponent(keyParam));
      return json({ success: true });
    }

    return methodNotAllowed();
  } catch (error) {
    return internalError(error);
  }
}
