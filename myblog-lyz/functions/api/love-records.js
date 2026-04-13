import { ensureObject, internalError, json, methodNotAllowed, parseJsonBody, readKVJson, writeKVJson } from "../_lib/store.js";

const KEY = "love-records";

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (request.method === "GET") {
      const payload = ensureObject(await readKVJson(env, KEY, {}));
      return json(payload);
    }

    if (request.method === "PUT") {
      const payload = await parseJsonBody(request);
      if (!payload) return json({ error: "Invalid JSON" }, 400);
      await writeKVJson(env, KEY, payload);
      return json({ success: true });
    }

    if (request.method === "DELETE") {
      await writeKVJson(env, KEY, {});
      return json({ success: true });
    }

    return methodNotAllowed();
  } catch (error) {
    return internalError(error);
  }
}
