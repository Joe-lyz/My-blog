import {
  ensureArray,
  internalError,
  json,
  methodNotAllowed,
  parseJsonBody,
  readKVJson,
  writeKVJson,
  deleteKVKey,
} from "../_lib/store.js";

const LEGACY_KEY = "posts";
const INDEX_KEY = "posts:index";
const ITEM_KEY_PREFIX = "posts:item:";

function toPostId(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function postItemKey(id) {
  return ITEM_KEY_PREFIX + toPostId(id);
}

async function loadPostIndex(env) {
  const index = ensureArray(await readKVJson(env, INDEX_KEY, []));
  if (index.length > 0) return index.map(toPostId).filter(Boolean);

  // Backward compatibility: migrate old single-key post array to index + items.
  const legacyPosts = ensureArray(await readKVJson(env, LEGACY_KEY, []));
  if (legacyPosts.length === 0) return [];

  const migratedIndex = [];
  for (const post of legacyPosts) {
    const id = toPostId(post?.id);
    if (!id) continue;
    await writeKVJson(env, postItemKey(id), post);
    migratedIndex.push(id);
  }

  await writeKVJson(env, INDEX_KEY, migratedIndex);
  return migratedIndex;
}

async function loadPosts(env) {
  const index = await loadPostIndex(env);
  const posts = [];
  for (const id of index) {
    const post = await readKVJson(env, postItemKey(id), null);
    if (post && typeof post === "object") posts.push(post);
  }
  return posts;
}

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (request.method === "GET") {
      const posts = await loadPosts(env);
      return json(posts);
    }

    if (request.method === "POST") {
      const post = await parseJsonBody(request);
      if (!post) return json({ error: "Invalid JSON" }, 400);

      const id = toPostId(post.id);
      if (!id) return json({ error: "Post id is required" }, 400);

      const index = await loadPostIndex(env);
      if (!index.includes(id)) index.push(id);

      await writeKVJson(env, postItemKey(id), post);
      await writeKVJson(env, INDEX_KEY, index);
      return json({ success: true });
    }

    if (request.method === "PUT") {
      const updatedPost = await parseJsonBody(request);
      if (!updatedPost) return json({ error: "Invalid JSON" }, 400);

      const id = toPostId(updatedPost.id);
      if (!id) return json({ error: "Post id is required" }, 400);

      const index = await loadPostIndex(env);
      if (!index.includes(id)) return json({ error: "Not found" }, 404);

      await writeKVJson(env, postItemKey(id), updatedPost);
      return json({ success: true });
    }

    if (request.method === "DELETE") {
      const body = await parseJsonBody(request);
      if (!body || body.id === undefined) return json({ error: "Invalid JSON" }, 400);

      const id = toPostId(body.id);
      const index = await loadPostIndex(env);
      const nextIndex = index.filter((postId) => postId !== id);

      await deleteKVKey(env, postItemKey(id));
      await writeKVJson(env, INDEX_KEY, nextIndex);
      return json({ success: true });
    }

    return methodNotAllowed();
  } catch (error) {
    return internalError(error);
  }
}
