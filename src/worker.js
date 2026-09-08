// Worker entry point. Routes /api/rewrite to the rewrite handler and serves
// everything else (index.html, app.js) from the static assets in ./public.
import { onRequestPost } from "../functions/api/rewrite.js";
import { onRequestPost as onFeedbackPost } from "../functions/api/feedback.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/feedback") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Send a POST request." }), {
          status: 405,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return onFeedbackPost({ request, env });
    }
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

  // Cloudflare fires this at the times in wrangler.jsonc "triggers". We tell
  // GitHub to start the matching workflow immediately - its API obeys at
  // once; only GitHub's own scheduler queues for hours.
  async scheduled(event, env, ctx) {
    const jobs = {
      "0 14 * * 1": ["digest-pipeline", "digest.yml"],
      "0 1 * * 3": ["newsletter-rewriter", "learn.yml"],
    };
    const job = jobs[event.cron];
    if (!job || !env.GITHUB_DISPATCH_TOKEN) return;
    const [repo, workflow] = job;
    ctx.waitUntil(
      fetch(
        `https://api.github.com/repos/AI-Furnace-Agentic/${repo}/actions/workflows/${workflow}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "aifurnace-cron",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main" }),
        },
      ),
    );
  },
};
