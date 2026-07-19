/**
 * Toolbar popup: type a company name (or KvK number) and see live results.
 * Matching runs in the background service worker (single source of truth).
 */
const qEl = document.getElementById("q");
const clearEl = document.getElementById("clear");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const metaEl = document.getElementById("meta");

const RECENT_KEY = "recentSearches";
const MAX_RECENT = 8;
let debounce;

/* ----------------------------------------------------------------- helpers */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

function kvkHtml(kvk) {
  if (!kvk) return "KvK number not listed";
  return `KvK ${esc(kvk)} · <a href="https://www.kvk.nl/zoeken/?woord=${encodeURIComponent(
    kvk
  )}" target="_blank" rel="noreferrer noopener">verify ↗</a>`;
}

function rowHtml(m, showScore) {
  const badge =
    showScore && typeof m.score === "number"
      ? `<span class="badge">${Math.round(m.score * 100)}%</span>`
      : "";
  return `<div class="row">${badge}
      <div class="grow">
        <div class="name">${esc(m.name)}</div>
        <div class="kvk">${kvkHtml(m.kvk)}</div>
      </div>
      <button class="copy" title="Copy KvK number" data-kvk="${esc(m.kvk)}">⧉</button>
    </div>`;
}

/* ------------------------------------------------------------------ render */

function render(result) {
  const { status, matches, candidates, query } = result;
  statusEl.className = "status " + status;
  statusEl.textContent =
    status === "recognised"
      ? `✓ Recognised sponsor${matches.length > 1 ? ` (${matches.length} entities)` : ""}`
      : status === "possible"
      ? "≈ No exact match — similar names below"
      : "✗ Not found in the register";

  let html = "";
  if (matches && matches.length) {
    html += matches.map((m) => rowHtml(m, false)).join("");
    if (candidates && candidates.length) {
      html += `<div class="sec">Other similar names</div>`;
      html += candidates.map((m) => rowHtml(m, true)).join("");
    }
  } else if (candidates && candidates.length) {
    html += candidates.map((m) => rowHtml(m, true)).join("");
  } else {
    html = `<div class="empty">No recognised sponsor matches <b>${esc(
      query
    )}</b>.<br />The employer's official legal name may differ from its brand,
      and the register updates monthly — worth a manual check.</div>`;
  }
  resultsEl.innerHTML = html;

  resultsEl.querySelectorAll(".copy").forEach((btn) =>
    btn.addEventListener("click", () => {
      const kvk = btn.dataset.kvk;
      if (kvk) {
        navigator.clipboard.writeText(kvk).catch(() => {});
        btn.textContent = "✓";
        setTimeout(() => (btn.textContent = "⧉"), 1000);
      }
    })
  );
}

async function search(query) {
  const result = await send({ type: "lookup", query, limit: 12 });
  if (result) render(result);
}

/* ---------------------------------------------------------- recent history */

async function getRecent() {
  const data = await chrome.storage.local.get(RECENT_KEY);
  return data[RECENT_KEY] || [];
}

async function pushRecent(query) {
  const q = query.trim();
  if (!q) return;
  let list = await getRecent();
  list = [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(
    0,
    MAX_RECENT
  );
  await chrome.storage.local.set({ [RECENT_KEY]: list });
}

async function showIdle() {
  statusEl.className = "status";
  statusEl.textContent = "";
  const recent = await getRecent();
  if (recent.length) {
    resultsEl.innerHTML =
      `<div class="sec">Recent searches</div><div style="padding:2px 10px 10px">` +
      recent.map((r) => `<button class="recent-chip">${esc(r)}</button>`).join("") +
      `</div>`;
    resultsEl.querySelectorAll(".recent-chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        qEl.value = chip.textContent;
        onInput();
        qEl.focus();
      })
    );
  } else {
    resultsEl.innerHTML = `<div class="empty">Type a company name to check if it's an
      IND-recognised visa sponsor.<br /><br />Tip: highlight any company name on a
      web page and click <b>Check sponsor</b>, or press <b>Alt+Shift+S</b>.</div>`;
  }
}

/* ------------------------------------------------------------------- events */

function onInput() {
  const q = qEl.value.trim();
  clearEl.style.display = q ? "block" : "none";
  clearTimeout(debounce);
  if (!q) {
    showIdle();
    return;
  }
  debounce = setTimeout(() => search(q), 120);
}

qEl.addEventListener("input", onInput);
qEl.addEventListener("change", () => pushRecent(qEl.value));
qEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pushRecent(qEl.value);
});
clearEl.addEventListener("click", () => {
  qEl.value = "";
  onInput();
  qEl.focus();
});

/* --------------------------------------------------------------------- init */

(async function init() {
  const meta = await send({ type: "meta" });
  if (meta && meta.count) {
    metaEl.textContent = `${meta.count.toLocaleString("en")} sponsors${
      meta.registerUpdatedOn ? " · updated " + meta.registerUpdatedOn : ""
    }`;
  } else {
    metaEl.textContent = "Register unavailable";
  }
  showIdle();
})();
