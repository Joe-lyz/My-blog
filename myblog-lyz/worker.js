import { detectStoreMode, json } from "./functions/_lib/store.js";
import { onRequest as postsHandler } from "./functions/api/posts.js";
import { onRequest as profileHandler } from "./functions/api/profile.js";
import { onRequest as calendarHandler } from "./functions/api/calendar.js";
import { onRequest as todosHandler } from "./functions/api/todos.js";
import { onRequest as photosHandler } from "./functions/api/photos.js";
import { onRequest as doodlesHandler } from "./functions/api/doodles.js";
import { onRequest as bookSearchHandler } from "./functions/api/book-search.js";
import { onRequest as booksHandler } from "./functions/api/books.js";
import { onRequest as trashHandler } from "./functions/api/trash.js";
import { onRequest as loveRecordsHandler } from "./functions/api/love-records.js";
import { onRequest as loveMediaHandler } from "./functions/api/love-media.js";
import { onRequest as travelHandler } from "./functions/api/travel.js";
import { onRequest as travelMediaHandler } from "./functions/api/travel-media.js";

const BUILD_VERSION = "2026-03-02-b386d2a-hotfix";

const routes = {
  "/api/posts": postsHandler,
  "/api/profile": profileHandler,
  "/api/calendar": calendarHandler,
  "/api/todos": todosHandler,
  "/api/photos": photosHandler,
  "/api/doodles": doodlesHandler,
  "/api/book-search": bookSearchHandler,
  "/api/books": booksHandler,
  "/api/trash": trashHandler,
  "/api/love-records": loveRecordsHandler,
  "/api/travel": travelHandler,
  "/api/version": async () => json({ version: BUILD_VERSION }),
  "/api/health": async ({ env }) => {
    const storeMode = detectStoreMode(env);
    const hasD1Binding = storeMode === "d1";
    const hasKvBinding = storeMode === "kv";
    return json({
      ok: true,
      version: BUILD_VERSION,
      storeMode,
      bindings: {
        BLOG_DB: hasD1Binding,
        BLOG_DATA: hasKvBinding,
      },
    });
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const handler = routes[url.pathname];

    if (url.pathname.startsWith("/api/love-media")) {
      return loveMediaHandler({ request, env, ctx, params: { key: url.pathname.replace(/^\/api\/love-media\/?/, "") } });
    }

    if (url.pathname.startsWith("/api/travel-media")) {
      return travelMediaHandler({ request, env, ctx, params: { key: url.pathname.replace(/^\/api\/travel-media\/?/, "") } });
    }

    if (handler) {
      return handler({ request, env, ctx });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const headers = new Headers(assetResponse.headers);
      headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
      headers.set("x-my-blog-version", BUILD_VERSION);
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }

    return assetResponse;
  },
};
