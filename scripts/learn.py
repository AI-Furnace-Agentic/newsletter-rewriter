"""Weekly rubric learning.

Runs every Tuesday 21:00 Asia/Bangkok (14:00 UTC) on GitHub Actions, after
the newsletter has been published:

1. Reads the week's feedback records from Cloudflare KV (keys "fb:*").
2. Asks Claude to update the learned-rules block in functions/api/_learned.js,
   given the frozen base spec, the current rules, and the week's evidence.
3. The workflow commits the file if it changed; the push auto-deploys the
   Worker, so next Monday's rewrites use the updated rubric.
4. After the push, --mark-done moves the processed records to "done:*" so
   nothing is learned twice.

Env: CF_ACCOUNT_ID, CF_KV_TOKEN, KV_NAMESPACE_ID, ANTHROPIC_API_KEY.
"""

import json
import os
import pathlib
import re
import sys

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEARNED = ROOT / "functions" / "api" / "_learned.js"
EDITORIAL = ROOT / "functions" / "api" / "_editorial.js"
PROCESSED_LIST = ROOT / "processed-keys.txt"

MAX_RECORDS = 100  # sanity cap; a week is ~10

ACCOUNT = os.environ["CF_ACCOUNT_ID"]
NS = os.environ["KV_NAMESPACE_ID"]
KV_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/storage/kv/namespaces/{NS}"
KV_HEADERS = {"Authorization": f"Bearer {os.environ['CF_KV_TOKEN']}"}


def kv_list(prefix: str) -> list[str]:
    r = requests.get(f"{KV_BASE}/keys", headers=KV_HEADERS, params={"prefix": prefix, "limit": 1000}, timeout=30)
    r.raise_for_status()
    return [k["name"] for k in r.json()["result"]]


def kv_get(key: str) -> str:
    r = requests.get(f"{KV_BASE}/values/{key}", headers=KV_HEADERS, timeout=30)
    r.raise_for_status()
    return r.text


def kv_put(key: str, value: str) -> None:
    requests.put(f"{KV_BASE}/values/{key}", headers=KV_HEADERS, data=value.encode(), timeout=30).raise_for_status()


def kv_delete(key: str) -> None:
    requests.delete(f"{KV_BASE}/values/{key}", headers=KV_HEADERS, timeout=30).raise_for_status()


def current_rules() -> str:
    m = re.search(r"export const LEARNED_RULES = `\n?(.*?)`;", LEARNED.read_text(encoding="utf-8"), re.S)
    return m.group(1).strip() if m else ""


def write_rules(rules: str) -> None:
    # Backticks and template-literal syntax would break the JS file.
    rules = rules.replace("\\", "\\\\").replace("`", "'").replace("${", "$ {").strip()
    body = LEARNED.read_text(encoding="utf-8")
    new = re.sub(
        r"export const LEARNED_RULES = `.*?`;",
        "export const LEARNED_RULES = `\n" + rules + "\n`;",
        body,
        flags=re.S,
    )
    LEARNED.write_text(new, encoding="utf-8")


def mark_done() -> None:
    if not PROCESSED_LIST.exists():
        print("No processed-keys.txt; nothing to mark.")
        return
    keys = [k for k in PROCESSED_LIST.read_text().splitlines() if k.strip()]
    for key in keys:
        value = kv_get(key)
        kv_put("done:" + key.removeprefix("fb:"), value)
        kv_delete(key)
    print(f"Marked {len(keys)} record(s) done.")


def learn() -> None:
    keys = kv_list("fb:")[:MAX_RECORDS]
    if not keys:
        print("No pending feedback; nothing to learn this week.")
        return

    records = [json.loads(kv_get(k)) for k in keys]
    likes = [r for r in records if r.get("verdict") == "like"]
    edits = [r for r in records if r.get("verdict") == "dislike" and r.get("final")]
    print(f"{len(records)} record(s): {len(likes)} liked, {len(edits)} edited.")

    if not edits:
        # Only likes this week: the rubric is doing fine; change nothing,
        # but still mark the records processed.
        PROCESSED_LIST.write_text("\n".join(keys), encoding="utf-8")
        print("Only likes - no rubric change.")
        return

    base_spec = EDITORIAL.read_text(encoding="utf-8")
    spec_m = re.search(r"export const EDITORIAL_SPEC = `\n?(.*?)`;", base_spec, re.S)
    base = spec_m.group(1)[:15000] if spec_m else ""

    evidence = []
    for r in edits:
        evidence.append(
            f"### EDITED STORY (slot {r['storyIndex']})\n"
            f"SOURCE PASTED BY EDITOR:\n{r['source'][:4000]}\n\n"
            f"OUR REWRITE:\n{r['rewritten'][:3000]}\n\n"
            f"EDITOR'S PUBLISHED VERSION:\n{r['final'][:3000]}\n"
        )
    for r in likes[:10]:
        evidence.append(
            f"### LIKED AS-IS (slot {r['storyIndex']})\n{r['rewritten'][:1500]}\n"
        )

    prompt = f"""You maintain the learned-rules block of an AI newsletter rewriting tool.

THE FROZEN BASE SPEC (human ground truth — you never restate or contradict it):
<base_spec>
{base}
</base_spec>

THE CURRENT LEARNED RULES (your previous state):
<current_rules>
{current_rules()}
</current_rules>

THIS WEEK'S EVIDENCE — the editor's published versions vs our rewrites, plus rewrites kept as-is:
{chr(10).join(evidence)}

Produce the UPDATED learned rules block. Requirements:
- Diff each edited story: what did the editor change, and what general preference does it reveal? Ignore changes that are factual corrections of the source rather than style.
- CONSOLIDATE: merge with the current rules; rewrite, generalize, or drop rules rather than appending. Hard cap: 25 rules total.
- Two sections: "CONFIRMED" (patterns seen in 2+ stories, or seen this week AND already tentative) and "TENTATIVE (seen once)" for single observations. Promote or drop tentative rules based on this week's evidence.
- Liked rewrites are counter-evidence: do not add a rule that would have changed a liked story.
- Each rule: one imperative line, concrete enough to follow ("Cut benchmark lists to the single most impressive number"), never vague ("be better").
- Never use backticks or ${{}} in the output.
- Output ONLY the rules block text: the two section headers and their rules. No preamble, no explanation, no code fences."""

    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={"model": "claude-opus-5", "max_tokens": 16000,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=600,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("stop_reason") == "refusal":
        sys.exit("Model refused; leaving rules untouched.")
    rules = "".join(b.get("text", "") for b in data["content"] if b.get("type") == "text").strip()
    if not rules or "CONFIRMED" not in rules:
        sys.exit(f"Suspicious learner output; refusing to write it:\n{rules[:500]}")

    write_rules(rules)
    PROCESSED_LIST.write_text("\n".join(keys), encoding="utf-8")
    print("Updated _learned.js:")
    print(rules[:1500])


if __name__ == "__main__":
    if "--mark-done" in sys.argv:
        mark_done()
    else:
        learn()
