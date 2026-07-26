import { loadSpec } from "./_editorial.js";

// Zero dependencies on purpose: Cloudflare Pages then needs no build step,
// no npm install, and no bundler. Plain fetch against the Messages API.
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;
const ANTHROPIC_VERSION = "2023-06-01";
// Opts into server-side fallbacks: if Claude declines the request on policy
// grounds, Anthropic re-runs it on a recommended fallback model in the same call.
const ANTHROPIC_BETA = "server-side-fallback-2026-07-01";

// Structured outputs: guarantees the shape so the page never parses prose.
// Every object needs additionalProperties:false and an explicit required list.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: {
            type: "integer",
            description:
              "The 1-based number of the input story this rewrite came from.",
          },
          category: { type: "string" },
          company: { type: "string" },
          headline: { type: "string" },
          paragraph1: { type: "string" },
          paragraph2: { type: "string" },
        },
        required: [
          "index",
          "category",
          "company",
          "headline",
          "paragraph1",
          "paragraph2",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["stories"],
  additionalProperties: false,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// Length-invariant compare so the passphrase can't be probed byte by byte.
function passphraseMatches(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function buildPrompt(stories) {
  return [
    `Rewrite the ${stories.length} ${stories.length === 1 ? "story" : "stories"} below as one coherent AI Furnace edition.`,
    `Order them per the narrative-flow rule and return every story exactly once,`,
    `each tagged with the "index" number it was given here.`,
    "",
    ...stories.map((s) =>
      [
        `--- STORY ${s.number} ---`,
        `Original headline: ${s.headline}`,
        s.url ? `Source URL: ${s.url}` : null,
        "Source content:",
        s.content,
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

export async function onRequestPost({ request, env }) {
  if (!env.APP_PASSPHRASE || !env.ANTHROPIC_API_KEY) {
    return json(
      {
        error:
          "Server is not configured. Set ANTHROPIC_API_KEY and APP_PASSPHRASE in the Cloudflare Pages environment variables, then redeploy.",
      },
      500,
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Could not read the request." }, 400);
  }

  if (!passphraseMatches(payload.passphrase, env.APP_PASSPHRASE)) {
    return json({ error: "Wrong passphrase." }, 401);
  }

  const submitted = Array.isArray(payload.stories) ? payload.stories : [];
  const stories = submitted
    .map((s, i) => ({
      number: i + 1,
      headline: String(s?.headline ?? "").trim(),
      content: String(s?.content ?? "").trim(),
      url: String(s?.url ?? "").trim(),
    }))
    .filter((s) => s.headline || s.content);

  if (stories.length === 0) {
    return json(
      { error: "Add at least one story — a headline and its content." },
      400,
    );
  }

  const incomplete = stories.find((s) => !s.headline || !s.content);
  if (incomplete) {
    return json(
      {
        error: `Story ${incomplete.number} is missing its ${
          incomplete.headline ? "content" : "headline"
        }. Fill both in, or clear the box entirely to skip it.`,
      },
      400,
    );
  }

  const spec = await loadSpec(env);

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        fallbacks: "default",
        system: [
          {
            type: "text",
            text: spec,
            // Identical every run, so repeat runs read it at ~10% of input cost.
            cache_control: { type: "ephemeral" },
          },
        ],
        output_config: {
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        messages: [{ role: "user", content: buildPrompt(stories) }],
      }),
    });
  } catch (err) {
    return json(
      { error: `Could not reach Anthropic: ${err?.message || "network error"}` },
      502,
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || "";
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) {
      return json({ error: "The Anthropic API key was rejected." }, 502);
    }
    if (res.status === 429) {
      return json(
        { error: "Rate limited by Anthropic. Wait a moment and retry." },
        502,
      );
    }
    if (/credit|balance/i.test(detail)) {
      return json(
        { error: "Anthropic credit balance is too low. Top up in the console." },
        502,
      );
    }
    return json(
      { error: `Anthropic returned ${res.status}${detail ? `: ${detail}` : ""}` },
      502,
    );
  }

  const message = await res.json();

  // Must be checked before reading content — a refusal can carry empty content.
  if (message.stop_reason === "refusal") {
    return json(
      {
        error:
          "Claude declined to rewrite this batch. Rephrase or remove the story that triggered it, then retry.",
      },
      502,
    );
  }

  if (message.stop_reason === "max_tokens") {
    return json(
      {
        error:
          "The response was cut off before finishing. Try fewer stories, or shorten the pasted content.",
      },
      502,
    );
  }

  const textBlock = (message.content || []).find((b) => b.type === "text");
  if (!textBlock?.text) {
    return json({ error: "Claude returned an empty response." }, 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return json({ error: "Claude returned malformed output." }, 502);
  }

  // Reattach each source URL to its story via the index the model echoed back.
  const byNumber = new Map(stories.map((s) => [s.number, s]));
  const results = (parsed.stories || []).map((s) => ({
    ...s,
    url: byNumber.get(s.index)?.url || "",
    originalHeadline: byNumber.get(s.index)?.headline || "",
  }));

  if (results.length === 0) {
    return json({ error: "Claude returned no stories." }, 502);
  }

  return json({
    stories: results,
    usage: {
      input: message.usage?.input_tokens ?? 0,
      output: message.usage?.output_tokens ?? 0,
      cacheRead: message.usage?.cache_read_input_tokens ?? 0,
    },
  });
}
