const STORY_COUNT = 5;
const DRAFT_KEY = "aifurnace.draft.v1";
const PASS_KEY = "aifurnace.passphrase.v1";

const $ = (id) => document.getElementById(id);
const form = $("form");
const statusEl = $("status");
const banner = $("banner");
const resultsEl = $("results");
const resultsHead = $("results-head");
const passInput = $("passphrase");

let lastResults = [];

// ---------- build the input form ----------

for (let i = 1; i <= STORY_COUNT; i++) {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <div class="story-head">
      <span class="story-num">Story ${i}</span>
      <span class="optional">Leave blank to skip</span>
    </div>
    <div class="field">
      <label for="h${i}">Headline</label>
      <input type="text" id="h${i}" data-role="headline" data-n="${i}"
             placeholder="The headline as it appeared in the newsletter" />
    </div>
    <div class="field">
      <label for="c${i}">Content</label>
      <textarea id="c${i}" data-role="content" data-n="${i}"
                placeholder="Paste the story text — summary, key points, details, why it matters"></textarea>
    </div>
    <div class="field">
      <label for="u${i}">Source URL <span class="optional">optional</span></label>
      <input type="url" id="u${i}" data-role="url" data-n="${i}"
             placeholder="https://..." />
    </div>`;
  form.appendChild(panel);
}

// ---------- persistence ----------

const fields = () => Array.from(form.querySelectorAll("[data-role]"));

function readStories() {
  const out = Array.from({ length: STORY_COUNT }, () => ({
    headline: "",
    content: "",
    url: "",
  }));
  for (const el of fields()) {
    out[Number(el.dataset.n) - 1][el.dataset.role] = el.value;
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
      const n = idx + 1;
      if (!s) return;
      for (const role of ["headline", "content", "url"]) {
        const el = form.querySelector(`[data-role="${role}"][data-n="${n}"]`);
        if (el && s[role]) el.value = s[role];
      }
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

// ---------- rendering ----------

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function plainText(story) {
  return [
    story.category,
    story.headline,
    "",
    story.paragraph1,
    "",
    story.paragraph2,
    story.url ? `\nSource: ${story.url}` : "",
  ]
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

function render(stories) {
  resultsEl.innerHTML = "";
  stories.forEach((s, i) => {
    const card = document.createElement("article");
    card.className = "result";
    card.innerHTML = `
      <div class="cat">${escapeHtml(s.category || "")}${
        s.company ? " · " + escapeHtml(s.company) : ""
      }</div>
      <h3>${i + 1}) ${escapeHtml(s.headline || "")}</h3>
      <p>${escapeHtml(s.paragraph1 || "")}</p>
      <p>${escapeHtml(s.paragraph2 || "")}</p>
      ${
        s.url
          ? `<p class="src"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.url)}</a></p>`
          : ""
      }
      <footer>
        <button type="button" class="ghost">Copy this story</button>
        ${
          s.originalHeadline
            ? `<span class="was">was: ${escapeHtml(s.originalHeadline)}</span>`
            : ""
        }
      </footer>`;
    card.querySelector("footer button").addEventListener("click", (e) => {
      copy(plainText(s), e.currentTarget);
    });
    resultsEl.appendChild(card);
  });
  resultsHead.hidden = stories.length === 0;
}

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
  if (!stories.some((s) => s.headline.trim() || s.content.trim())) {
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
    render(lastResults);
    statusEl.textContent = `Done — ${lastResults.length} ${
      lastResults.length === 1 ? "story" : "stories"
    } rewritten.`;
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
  if (!confirm("Clear all five stories and the results?")) return;
  for (const el of fields()) el.value = "";
  saveDraft();
  lastResults = [];
  resultsEl.innerHTML = "";
  resultsHead.hidden = true;
  statusEl.textContent = "";
  clearError();
});
