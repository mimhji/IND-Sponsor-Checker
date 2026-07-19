/**
 * Content script: on-page selection lookup.
 *
 * When the user highlights text, a small pill appears near the selection.
 * Clicking it (or the context menu / Alt+Shift+S) asks the background worker
 * whether the text matches an IND-recognised sponsor and shows a result card.
 *
 * Everything lives inside a shadow root so the host page's CSS can't touch it,
 * and our CSS can't leak onto the page.
 */
(function () {
  "use strict";
  if (window.__indSponsorCheckerLoaded) return;
  window.__indSponsorCheckerLoaded = true;

  const MAX_SELECTION = 90; // ignore huge selections (probably not a company name)
  const IND_URL =
    "https://ind.nl/en/public-register-recognised-sponsors/public-register-work";

  let host, root, pill, card;
  let lastRect = null;
  let lastText = "";

  /* --------------------------------------------------------------- shadow UI */

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .pill, .card { position: fixed; z-index: 2147483647; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
      background: #0d102b; color: #fff; font-size: 12px; font-weight: 600;
      padding: 6px 10px; border-radius: 999px; box-shadow: 0 2px 8px rgba(0,0,0,.28);
      border: none; line-height: 1; user-select: none; white-space: nowrap;
    }
    .pill:hover { background: #1b2050; }
    .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #0070bf; }
    .card {
      width: 340px; max-width: calc(100vw - 24px); background: #fff; color: #1f2937;
      border-radius: 12px; box-shadow: 0 10px 34px rgba(0,0,0,.24);
      border: 1px solid rgba(0,0,0,.08); overflow: hidden; font-size: 13px;
    }
    .hd { display: flex; align-items: center; gap: 8px; padding: 12px 14px; color: #fff; }
    .hd.recognised { background: #137333; }
    .hd.possible   { background: #b06000; }
    .hd.not_found  { background: #b3261e; }
    .hd .ico { font-size: 16px; line-height: 1; }
    .hd .title { font-weight: 700; font-size: 13px; }
    .hd .sub { font-size: 11px; opacity: .9; margin-top: 1px; }
    .hd .grow { flex: 1; }
    .hd .x { cursor: pointer; opacity: .85; font-size: 16px; background: none;
             border: none; color: #fff; padding: 2px 4px; }
    .hd .x:hover { opacity: 1; }
    .body { padding: 10px 14px 12px; max-height: 320px; overflow-y: auto; }
    .q { font-size: 12px; color: #6b7280; margin: 0 0 8px; word-break: break-word; }
    .q b { color: #111827; }
    .row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0;
           border-top: 1px solid #f0f0f2; }
    .row:first-child { border-top: none; }
    .row .name { font-weight: 600; color: #111827; word-break: break-word; }
    .row .kvk { color: #6b7280; font-size: 12px; margin-top: 2px; }
    .row .kvk a { color: #0070bf; text-decoration: none; }
    .row .kvk a:hover { text-decoration: underline; }
    .badge { flex: none; font-size: 10px; font-weight: 700; color: #92400e;
             background: #fef3c7; border-radius: 6px; padding: 2px 6px; margin-top: 1px; }
    .sec { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
           color: #9ca3af; font-weight: 700; margin: 12px 0 2px; }
    .empty { color: #4b5563; line-height: 1.5; }
    .ft { border-top: 1px solid #f0f0f2; padding: 8px 14px; font-size: 11px;
          color: #9ca3af; display: flex; justify-content: space-between; gap: 8px; }
    .ft a { color: #9ca3af; text-decoration: none; }
    .ft a:hover { color: #6b7280; text-decoration: underline; }
    .copy { cursor: pointer; background: none; border: none; color: #0070bf;
            font-size: 11px; padding: 0; margin-left: 6px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1f2430; color: #e5e7eb; border-color: rgba(255,255,255,.08); }
      .row { border-top-color: rgba(255,255,255,.07); }
      .row .name { color: #f3f4f6; }
      .q b { color: #f3f4f6; }
      .ft { border-top-color: rgba(255,255,255,.07); }
      .empty { color: #cbd5e1; }
    }
  `;

  function ensureUI() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:absolute;top:0;left:0;";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.appendChild(style);

    pill = document.createElement("button");
    pill.className = "pill";
    pill.innerHTML = '<span class="dot"></span><span>Check sponsor</span>';
    pill.style.display = "none";
    pill.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      hidePill();
      if (lastText) doLookup(lastText, lastRect);
    });
    root.appendChild(pill);

    card = document.createElement("div");
    card.className = "card";
    card.style.display = "none";
    card.addEventListener("mousedown", (e) => e.stopPropagation());
    root.appendChild(card);

    (document.body || document.documentElement).appendChild(host);
  }

  /* ------------------------------------------------------------- positioning */

  function clamp(rect, w, h) {
    const pad = 8;
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
    if (left < pad) left = pad;
    if (top + h > window.innerHeight - pad) top = Math.max(pad, rect.top - h - 8);
    return { left: Math.round(left), top: Math.round(top) };
  }

  function showPill(rect) {
    ensureUI();
    pill.style.display = "inline-flex";
    const pos = clamp(rect, pill.offsetWidth || 130, pill.offsetHeight || 30);
    pill.style.left = pos.left + "px";
    pill.style.top = pos.top + "px";
  }

  function hidePill() {
    if (pill) pill.style.display = "none";
  }

  function hideCard() {
    if (card) card.style.display = "none";
  }

  /* ---------------------------------------------------------------- lookup */

  function doLookup(query, rect) {
    chrome.runtime.sendMessage({ type: "lookup", query, badge: true }, (result) => {
      if (chrome.runtime.lastError || !result) return;
      renderCard(result, rect);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function kvkLink(kvk) {
    return kvk
      ? `KvK ${esc(kvk)} · <a href="https://www.kvk.nl/zoeken/?woord=${encodeURIComponent(
          kvk
        )}" target="_blank" rel="noreferrer noopener">verify ↗</a>`
      : "KvK number not listed";
  }

  function rowHtml(m, showBadge) {
    const badge =
      showBadge && typeof m.score === "number"
        ? `<span class="badge">${Math.round(m.score * 100)}%</span>`
        : "";
    return `<div class="row">${badge}<div class="grow">
        <div class="name">${esc(m.name)}</div>
        <div class="kvk">${kvkLink(m.kvk)}</div>
      </div></div>`;
  }

  const HEAD = {
    recognised: { ico: "✓", title: "Recognised sponsor" },
    possible: { ico: "≈", title: "Possible match — verify" },
    not_found: { ico: "✗", title: "Not in the register" },
  };

  function renderCard(result, rect) {
    ensureUI();
    const h = HEAD[result.status] || HEAD.not_found;
    let sub =
      result.status === "recognised"
        ? "This organisation can sponsor work permits"
        : result.status === "possible"
        ? "No exact match found"
        : "No recognised sponsor by this name";

    let bodyHtml = `<p class="q">Searched: <b>${esc(result.query)}</b></p>`;

    if (result.matches && result.matches.length) {
      bodyHtml += result.matches.map((m) => rowHtml(m, false)).join("");
      if (result.candidates && result.candidates.length) {
        bodyHtml += `<div class="sec">Other similar names</div>`;
        bodyHtml += result.candidates.map((m) => rowHtml(m, true)).join("");
      }
    } else if (result.candidates && result.candidates.length) {
      bodyHtml += `<p class="empty">No exact match, but these look similar. Check the KvK number carefully.</p>`;
      bodyHtml += result.candidates.map((m) => rowHtml(m, true)).join("");
    } else {
      bodyHtml += `<p class="empty">No recognised sponsor matches this name.<br>
        The register is updated monthly, and the employer's legal name may differ
        from its brand name — worth a manual check on the official page.</p>`;
    }

    card.innerHTML = `
      <div class="hd ${result.status}">
        <span class="ico">${h.ico}</span>
        <div class="grow"><div class="title">${h.title}</div><div class="sub">${sub}</div></div>
        <button class="x" title="Close">✕</button>
      </div>
      <div class="body">${bodyHtml}</div>
      <div class="ft">
        <span>IND register</span>
        <a href="${IND_URL}" target="_blank" rel="noreferrer noopener">official page ↗</a>
      </div>`;

    card.querySelector(".x").addEventListener("click", hideCard);

    card.style.display = "block";
    card.style.visibility = "hidden";
    const anchor = rect || { left: 20, top: 20, bottom: 40 };
    const pos = clamp(anchor, card.offsetWidth || 340, card.offsetHeight || 200);
    card.style.left = pos.left + "px";
    card.style.top = pos.top + "px";
    card.style.visibility = "visible";
  }

  /* ------------------------------------------------------------- selection */

  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { text, rect };
  }

  function onSelectionChanged() {
    const info = currentSelection();
    if (info && info.text.length <= MAX_SELECTION) {
      lastText = info.text;
      lastRect = info.rect;
      showPill(info.rect);
    } else {
      hidePill();
    }
  }

  document.addEventListener("mouseup", () => setTimeout(onSelectionChanged, 10), true);
  document.addEventListener("mousedown", (e) => {
    // Click outside our UI closes the card + pill.
    if (host && e.composedPath && e.composedPath().includes(host)) return;
    hideCard();
    hidePill();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideCard();
      hidePill();
    }
  });

  /* ------------------------------------------------ messages from background */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "render") {
      const info = currentSelection();
      renderCard(msg.result, info ? info.rect : lastRect);
    } else if (msg.type === "lookupSelection") {
      const info = currentSelection();
      if (info) {
        lastText = info.text;
        lastRect = info.rect;
        hidePill();
        doLookup(info.text, info.rect);
      }
    }
  });
})();
