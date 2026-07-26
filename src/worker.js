// Worker entry point. Routes /api/rewrite to the rewrite handler and serves
// everything else (index.html, app.js) from the static assets in ./public.
import { onRequestPost } from "../functions/api/rewrite.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rewrite") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Send a POST request." }), {
          status: 405,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return onRequestPost({ request, env });
    }

    return env.ASSETS.fetch(request);
  },
};
