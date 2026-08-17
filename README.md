# AI Furnace — Story Rewriter

A one-page tool: paste up to seven newsletter stories, click **Rewrite**, and get
back each story as a rewritten headline plus two paragraphs in AI Furnace
editorial style, ready to copy into beehiiv.

Four files, no build step, no dependencies.

```
public/index.html          the page
public/app.js              form + rendering + copy buttons
functions/api/rewrite.js   the server bit — holds the API key, calls Claude
functions/api/_editorial.js  the editorial rules (edit this to change the style)
```

The leading underscore on `_editorial.js` is what stops Cloudflare from turning
it into a public URL — it's a shared module, not an endpoint.

---

## One-time setup

You need two accounts (both free) and about 20 minutes.

### 1. Get an Anthropic API key

1. Go to **console.anthropic.com** and sign in.
2. Add a payment method, then **set a monthly spend limit of $5**. This is the
   real safety net — it caps the damage no matter what else happens.
3. Create an API key and copy it. You won't be able to see it again.

Cost is roughly **15–20 cents per run** (one edition of seven stories) — the
editorial spec is resent on every call, and Opus 5 thinks by default, so most of
the cost is tokens you don't see. At one edition a week that's about **$1/month**;
at five runs a week, nearer **$3–4/month**. The $5 cap leaves ample headroom
either way. Check the console's usage page after a few real runs — these are
estimates, and thinking volume varies by input.

> This is billed separately from your Claude subscription. The subscription pays
> for you using the Claude apps; this pays for Cloudflare's server calling Claude
> on your behalf. There's no way around that — the website isn't Claude.

### 2. Put this folder on GitHub

1. Create a free account at **github.com** if you don't have one.
2. **New repository** → name it `newsletter-rewriter` → **Private** → Create.
3. On the empty repo page, click **uploading an existing file**.
4. Drag in the `public` and `functions` folders and the `.gitignore`, then
   **Commit changes**.

### 3. Connect it to Cloudflare Pages

1. Create a free account at **dash.cloudflare.com**.
2. **Compute (Workers & Pages)** → **Create** → **Pages** tab → **Connect to Git**.
3. Authorize GitHub, pick the `newsletter-rewriter` repo, **Begin setup**.
4. Build settings — this is the important screen:
   - Framework preset: **None**
   - Build command: **leave completely blank**
   - Build output directory: `public`
5. **Save and Deploy.** About a minute later you get a URL like
   `newsletter-rewriter.pages.dev`. The page will load but Rewrite won't work
   yet — no key.

### 4. Add the two secrets

In the project: **Settings** → **Variables and Secrets** → add both as
type **Secret** (encrypted), for the **Production** environment:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the key from step 1 |
| `APP_PASSPHRASE` | any phrase you'll remember, e.g. `furnace-monday-2026` |

Then **Deployments** → the latest one → **Retry deployment**. Environment
variables only reach the code on a fresh deploy, so this step is not optional.

### 5. Use it

Open the URL, type the passphrase once (the browser remembers it), paste your
stories, click **Rewrite all stories**. Bookmark it.

---

## Changing the editorial rules

Edit the big text block in `functions/api/_editorial.js`, commit, and Cloudflare
redeploys within a minute. The rules there are merged from
`AI_Furnace_Editorial_Handbook_v2.md` (primary) and
`AI_Furnace_Editorial_Playbook.md` (secondary).

**Optional — edit rules without touching code.** Put the rules in a public
GitHub gist, copy its **Raw** URL, and add a plain (non-secret) environment
variable `SPEC_URL` pointing at it. The function then reads that instead, cached
for a minute. If the gist ever breaks or goes away, it silently falls back to the
built-in copy, so this can't take the tool offline.

## Notes and limits

- **The passphrase is a spend guard, not real security.** Anyone with both the
  URL and the passphrase can spend your API credit. That's what the $5 monthly
  cap in step 1 is for. The page is also marked `noindex` so it won't be crawled.
- **The API key never reaches the browser.** It lives only in Cloudflare's
  encrypted environment and is used server-side.
- **Your drafts are saved locally.** Text you type persists in that browser if
  you close the tab, and clears when you press **Clear all**.
- **Claude only uses what you paste.** It's instructed not to invent numbers or
  dates, so if a figure is missing from your paste it will be absent from the
  rewrite rather than guessed.
- **Free tier:** 100,000 requests/day. Time spent waiting on Claude doesn't count
  against Cloudflare's CPU limit, which is why this workload fits comfortably.

## Local preview

Not possible on this machine. Cloudflare's local runtime (`workerd`, used by
`wrangler dev`) has no Windows-ARM64 build, and this is a Windows-on-ARM laptop,
so the Wrangler CLI can't be installed here at all. Nothing is lost — Cloudflare
builds and runs everything in its own cloud; test against the real URL after
deploying. On an x64 machine, `npx wrangler pages dev public` would work.
