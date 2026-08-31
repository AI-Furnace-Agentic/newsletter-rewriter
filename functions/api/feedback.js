// Feedback capture: the browser posts a verdict per (run, story) and this
// stores it in KV for the weekly learning job. Upsert semantics — a re-vote
// or an edited final replaces the earlier record, and Tuesday's job only
// ever sees the last state before it runs.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function passphraseMatches(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.FEEDBACK) {
    return json({ error: "Feedback storage is not configured." }, 500);
  }
  if (!env.APP_PASSPHRASE) {
    return json({ error: "Server is not configured." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send JSON." }, 400);
  }
  if (!passphraseMatches(body.passphrase, env.APP_PASSPHRASE)) {
    return json({ error: "Wrong passphrase." }, 403);
  }

  const { action, runId, storyIndex } = body;
  if (!runId || !Number.isInteger(storyIndex)) {
    return json({ error: "runId and storyIndex are required." }, 400);
  }
  // Keys are namespaced "fb:" (pending) — the learning job moves processed
  // records to "done:" so nothing is ever learned twice.
  const key = `fb:${runId}:${storyIndex}`;

  if (action === "delete") {
    await env.FEEDBACK.delete(key);
    return json({ ok: true, deleted: key });
  }

  if (action === "save") {
    const record = {
      runId,
      storyIndex,
      verdict: body.verdict === "like" ? "like" : "dislike",
      source: String(body.source || "").slice(0, 50_000),
      rewritten: String(body.rewritten || "").slice(0, 20_000),
      final: body.final == null ? null : String(body.final).slice(0, 20_000),
      savedAt: new Date().toISOString(),
    };
    await env.FEEDBACK.put(key, JSON.stringify(record));
    return json({ ok: true, saved: key });
  }

  return json({ error: "action must be 'save' or 'delete'." }, 400);
}
