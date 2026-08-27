const STORY_COUNT = 7;
const DRAFT_KEY = "aifurnace.draft.v2";
const PASS_KEY = "aifurnace.passphrase.v1";
const FEEDBACK_KEY = "aifurnace.feedback.v1";

const $ = (id) => document.getElementById(id);
const form = $("form");
const statusEl = $("status");
const banner = $("banner");
const resultsEl = $("results");
const resultsHead = $("results-head");
const passInput = $("passphrase");

let lastResults = [];
// The stories exactly as submitted. Captured at run time because run() clears
// the input boxes on success, and the learning step needs the original text to
// tell a style edit apart from a factual correction.
let lastSubmitted = [];
// idx (1-based input slot) -> { verdict, final, savedAt }
const feedback = new Map();
// Identifies one batch of rewrites, so a story that gets voted on, undone, and
// voted on again leaves exactly one record instead of a contradictory pair.
let runId = null;

// ---------- build the input form: one box per story ----------

for (let i = 1; i <= STORY_COUNT; i++) {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <div class="story-head">
      <span class="story-num">Story ${i}</span>
      <span class="optional">Leave blank to skip</span>
    </div>
    <div class="field">
      <textarea id="s${i}" data-role="text" data-n="${i}"
                placeholder="Paste the whole story here — headline and summarized content together"></textarea>
    </div>`;
  form.appendChild(panel);
}

// ---------- persistence ----------

const fields = () => Array.from(form.querySelectorAll("[data-role='text']"));

function readStories() {
  const out = Array.from({ length: STORY_COUNT }, () => ({ text: "" }));
  for (const el of fields()) {
    out[Number(el.dataset.n) - 1].text = el.value;
  }
  return out;
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(readStories()));
  } catch {
    /* private mode — drafts just won't persist */
  }
}

function restore() {
  try {
    const pass = localStorage.getItem(PASS_KEY);
    if (pass) passInput.value = pass;

    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (!Array.isArray(draft)) return;
    draft.forEach((s, idx) => {
      const el = form.querySelector(`[data-role="text"][data-n="${idx + 1}"]`);
      if (el && s?.text) el.value = s.text;
    });
  } catch {
    /* ignore corrupt storage */
  }
}

form.addEventListener("input", saveDraft);
passInput.addEventListener("input", () => {
  try {
    localStorage.setItem(PASS_KEY, passInput.value);
  } catch {
    /* ignore */
  }
});

restore();

// ---------- saved preferences ----------
// Phase 1 keeps these in the browser only. Nothing is sent anywhere and the
// editorial spec is untouched; feeding them back into it is the next step.

function loadPreferences() {
  try {
    const raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// One record per (run, story): re-voting replaces the earlier verdict rather
// than stacking a second, conflicting one on top of it.
function savePreference(entry) {
  const all = loadPreferences().filter(
    (e) => !(e.runId === entry.runId && e.storyIndex === entry.storyIndex),
  );
  all.push(entry);
  try {
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(all));
  } catch {
    showError(
      "Couldn't save — this browser is out of storage or in private mode.",
    );
    return false;
  }
  refreshLog();
  return true;
}

function refreshLog() {
  const all = loadPreferences();
  const log = $("fb-log");
  log.hidden = all.length === 0;
  if (all.length === 0) return;

  const edits = all.filter((e) => e.verdict === "dislike").length;
  const likes = all.length - edits;
  $("fb-log-count").textContent =
    `${all.length} saved ${all.length === 1 ? "preference" : "preferences"} ` +
    `(${likes} liked, ${edits} with an edited version).`;
}

function dropPreference(storyIndex) {
  const all = loadPreferences();
  const kept = all.filter(
    (e) => !(e.runId === runId && e.storyIndex === storyIndex),
  );
  if (kept.length === all.length) return;
  try {
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(kept));
  } catch {
    /* ignore */
  }
  refreshLog();
}

$("fb-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(loadPreferences(), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aifurnace-preferences-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("fb-reset").addEventListener("click", () => {
  const n = loadPreferences().length;
  if (!n) return;
  if (!confirm(`Delete all ${n} saved preferences? This cannot be undone.`)) {
    return;
  }
  try {
    localStorage.removeItem(FEEDBACK_KEY);
  } catch {
    /* ignore */
  }
  feedback.clear();
  render(lastResults);
  refreshLog();
});

refreshLog();

// ---------- rendering ----------

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// One unified block: headline, blank line, the two paragraphs.
function plainText(story) {
  return [story.headline, "", story.paragraph1, "", story.paragraph2]
    .join("\n")
    .trim();
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* nothing more we can do */
    }
    ta.remove();
  }
  const original = btn.textContent;
  btn.textContent = "Copied";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("copied");
  }, 1600);
}

// ---------- per-story feedback ----------

// Four states: unrated -> liked | editing -> saved. Each repaints the block in
// place, so a story only ever shows one question at a time.
function renderFeedback(box, story) {
  const idx = story.index;
  const state = feedback.get(idx);
  box.innerHTML = "";

  if (state?.verdict === "like") {
    box.innerHTML = `
      <div class="fb-note good">
        <span>Liked — kept as written.</span>
        <button type="button" class="ghost" data-act="reset">Change my mind</button>
      </div>`;
  } else if (state?.verdict === "dislike" && state.savedAt) {
    box.innerHTML = `
      <div class="fb-note good">
        <span>Your final version is saved.</span>
        <button type="button" class="ghost" data-act="edit">Edit it</button>
      </div>`;
  } else if (state?.verdict === "dislike") {
    box.innerHTML = `
      <div class="fb-edit">
        <label>Your final version</label>
        <p class="fb-hint">Pre-filled with the rewrite above — edit it into
          exactly what you published, whether that is a few words or a complete
          rewrite.</p>
        <textarea data-role="final"></textarea>
        <div class="fb-actions">
          <button type="button" data-act="save">Save this preference</button>
          <button type="button" class="ghost" data-act="reset">Cancel</button>
        </div>
      </div>`;
    // Set through .value, not markup, so the text needs no escaping.
    box.querySelector("[data-role='final']").value =
      state.final || plainText(story);
  } else {
    box.innerHTML = `
      <div class="fb-ask">
        <span class="fb-q">How is this rewrite?</span>
        <button type="button" class="ghost" data-act="like">I like it</button>
        <button type="button" class="ghost" data-act="dislike">I don't like it</button>
      </div>`;
  }

  box.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => onFeedback(btn.dataset.act, box, story));
  });
}

function onFeedback(act, box, story) {
  const idx = story.index;

  if (act === "like") {
    feedback.set(idx, { verdict: "like" });
    savePreference({
      runId,
      savedAt: new Date().toISOString(),
      verdict: "like",
      storyIndex: idx,
      source: lastSubmitted[idx - 1]?.text ?? "",
      rewritten: plainText(story),
      final: null,
    });
  } else if (act === "dislike" || act === "edit") {
    const prev = feedback.get(idx);
    feedback.set(idx, { verdict: "dislike", final: prev?.final ?? "" });
  } else if (act === "reset") {
    feedback.delete(idx);
    clearError();
    dropPreference(idx);
  } else if (act === "save") {
    const final = box.querySelector("[data-role='final']").value.trim();
    if (!final) {
      showError("Paste your final version before saving.");
      return;
    }
    if (final === plainText(story)) {
      showError(
        "That is identical to the rewrite — edit it, or choose 'I like it'.",
      );
      return;
    }
    clearError();
    if (
      !savePreference({
        runId,
        savedAt: new Date().toISOString(),
        verdict: "dislike",
        storyIndex: idx,
        source: lastSubmitted[idx - 1]?.text ?? "",
        rewritten: plainText(story),
        final,
      })
    ) {
      return;
    }
    feedback.set(idx, { verdict: "dislike", final, savedAt: Date.now() });
  }

  renderFeedback(box, story);
}

function render(stories) {
  resultsEl.innerHTML = "";
  stories.forEach((s) => {
    const card = document.createElement("article");
    card.className = "result";
    card.innerHTML = `
      <h3>${escapeHtml(s.headline || "")}</h3>
      <p>${escapeHtml(s.paragraph1 || "")}</p>
      <p>${escapeHtml(s.paragraph2 || "")}</p>
      <footer>
        <button type="button" class="ghost">Copy this story</button>
      </footer>
      <div class="feedback"></div>`;
    card.querySelector("footer button").addEventListener("click", (e) => {
      copy(plainText(s), e.currentTarget);
    });
    renderFeedback(card.querySelector(".feedback"), s);
    resultsEl.appendChild(card);
  });
  resultsHead.hidden = stories.length === 0;
}

// Exposed for manual testing in the console.
window.render = render;

// ---------- run ----------

function showError(msg) {
  banner.textContent = msg;
  banner.className = "banner error";
}

function clearError() {
  banner.textContent = "";
  banner.className = "banner";
}

async function run() {
  clearError();

  const passphrase = passInput.value.trim();
  if (!passphrase) {
    showError("Enter the passphrase first.");
    passInput.focus();
    return;
  }

  const stories = readStories();
  if (!stories.some((s) => s.text.trim())) {
    showError("Paste at least one story before rewriting.");
    return;
  }

  const runBtn = $("run");
  runBtn.disabled = true;
  statusEl.className = "status";
  statusEl.innerHTML =
    '<span class="spinner"></span> Rewriting — this usually takes 30–90 seconds.';

  try {
    const res = await fetch("/api/rewrite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase, stories }),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Server returned ${res.status} with no readable body.`);
    }

    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);

    lastResults = data.stories || [];
    lastSubmitted = stories;
    runId = new Date().toISOString();
    feedback.clear();
    render(lastResults);

    // Successful rewrite: clear the input boxes and the saved draft so the
    // next visit starts blank. The results below stay until the page closes,
    // and the passphrase is kept.
    for (const el of fields()) el.value = "";
    saveDraft();

    statusEl.textContent = `Done — ${lastResults.length} ${
      lastResults.length === 1 ? "story" : "stories"
    } rewritten. Input boxes cleared for next time.`;
    resultsHead.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = "";
    showError(err.message || "Something went wrong.");
  } finally {
    runBtn.disabled = false;
  }
}

$("run").addEventListener("click", run);

$("copy-all").addEventListener("click", (e) => {
  copy(lastResults.map(plainText).join("\n\n———\n\n"), e.currentTarget);
});

$("clear").addEventListener("click", () => {
  if (!confirm(`Clear all ${STORY_COUNT} stories and the results?`)) return;
  for (const el of fields()) el.value = "";
  saveDraft();
  lastResults = [];
  lastSubmitted = [];
  feedback.clear();
  resultsEl.innerHTML = "";
  resultsHead.hidden = true;
  statusEl.textContent = "";
  clearError();
});
