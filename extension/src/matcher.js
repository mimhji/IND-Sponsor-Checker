/**
 * IND sponsor matching engine (shared).
 *
 * Loaded both by the background service worker (via importScripts) and by the
 * popup (via <script>). Attaches an `INDMatcher` object to the global scope.
 *
 * Company names in the register carry legal/geographic noise ("B.V.",
 * "Netherlands", "Holding", ...). Users typically highlight just the brand
 * ("Uber", "ASML"), so we normalise both sides and match on a "core" form,
 * while still keeping full-name exact matches as the highest-confidence signal.
 */
(function (global) {
  "use strict";

  // Legal-form + geographic noise tokens stripped to build the "core" name.
  const NOISE = new Set([
    "bv", "nv", "holding", "holdings", "group", "groep", "beheer",
    "nederland", "netherlands", "holland", "international", "internationaal",
    "europe", "european", "europa", "benelux", "worldwide", "global",
    "gmbh", "ltd", "limited", "inc", "sa", "ag", "sarl", "the",
  ]);

  function stripDiacritics(s) {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  /** Full normalised form: lowercase, ascii-ish, punctuation → space. */
  function normalize(str) {
    return stripDiacritics(String(str || "").toLowerCase())
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(normStr) {
    return normStr ? normStr.split(" ").filter(Boolean) : [];
  }

  /** Core form: normalised name with noise + very short tokens removed. */
  function coreOf(normStr) {
    const kept = tokens(normStr).filter((t) => t.length > 1 && !NOISE.has(t));
    // If stripping removed everything (e.g. "The B.V."), fall back to full norm.
    return kept.length ? kept.join(" ") : normStr;
  }

  /** Bounded Levenshtein similarity in [0,1]. */
  function similarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > Math.max(m, n) * 0.5 + 2) return 0; // quick reject
    const prev = new Array(n + 1);
    const cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      const ai = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return 1 - prev[n] / Math.max(m, n);
  }

  let INDEX = []; // [{ name, kvk, norm, core, tokenSet }]
  let META = {};

  function init(payload) {
    const sponsors = Array.isArray(payload) ? payload : payload.sponsors || [];
    META = Array.isArray(payload) ? {} : payload;
    INDEX = sponsors.map((s) => {
      const norm = normalize(s.name);
      const core = coreOf(norm);
      return {
        name: s.name,
        kvk: s.kvk,
        norm,
        core,
        tokenSet: new Set(tokens(core)),
      };
    });
    return INDEX.length;
  }

  function ready() {
    return INDEX.length > 0;
  }

  function meta() {
    return {
      count: INDEX.length,
      registerUpdatedOn: META.registerUpdatedOn || null,
      scrapedAt: META.scrapedAt || null,
      source: META.source || null,
    };
  }

  /**
   * Search the register.
   * @returns {{
   *   query, status:'recognised'|'possible'|'not_found',
   *   matches:Array, candidates:Array
   * }}
   */
  function search(query, opts) {
    const limit = (opts && opts.limit) || 8;
    const raw = String(query || "").trim();
    const result = { query: raw, status: "not_found", matches: [], candidates: [] };
    if (!raw || !ready()) return result;

    // KvK number lookup (7–8 digit numbers).
    const digits = raw.replace(/\D/g, "");
    if (/^\d{7,8}$/.test(digits) && digits === raw.replace(/\s/g, "")) {
      const hits = INDEX.filter((s) => s.kvk === digits);
      if (hits.length) {
        result.status = "recognised";
        result.matches = hits.map((s) => pick(s));
        return result;
      }
    }

    const qNorm = normalize(raw);
    const qCore = coreOf(qNorm);
    const qTokens = tokens(qCore);
    if (!qNorm) return result;

    const exact = [];
    const scored = [];

    for (const s of INDEX) {
      // Highest confidence: full or core name equality.
      if (s.norm === qNorm || (qCore && s.core === qCore)) {
        exact.push(s);
        continue;
      }
      let score = 0;
      // "related" = a genuine name variant (shares words / is a prefix or
      // substring), as opposed to a mere spelling neighbour found by fuzzy
      // distance. Used to keep the "similar names" list clean when we already
      // have an exact hit.
      let related = false;

      const allTokensIn =
        qTokens.length > 0 && qTokens.every((t) => s.tokenSet.has(t));
      if (allTokensIn) {
        // Query is a clean subset of the sponsor's core name.
        related = true;
        score = Math.max(score, 0.82 - 0.03 * Math.max(0, s.tokenSet.size - qTokens.length));
      }
      if (s.norm.startsWith(qNorm) || (qCore && s.core.startsWith(qCore))) {
        related = true;
        score = Math.max(score, 0.78);
      }
      if (qNorm.length >= 3 && s.norm.includes(qNorm)) {
        related = true;
        score = Math.max(score, 0.62);
      }

      let overlap = 0;
      for (const t of qTokens) if (s.tokenSet.has(t)) overlap++;
      if (overlap) {
        related = true;
        score = Math.max(score, 0.35 + 0.12 * overlap);
      }

      // Fuzzy typo tolerance only when there's already some signal or close length.
      if (overlap || score > 0 || Math.abs(s.core.length - qCore.length) <= 3) {
        score = Math.max(score, similarity(qCore, s.core) * 0.9);
      }

      if (score >= 0.4) scored.push({ s, score, related });
    }

    scored.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length);

    if (exact.length) {
      result.status = "recognised";
      // Show the barest legal name first (e.g. "Uber B.V." before "Uber Netherlands B.V.").
      exact.sort((a, b) => a.name.length - b.name.length);
      result.matches = exact.slice(0, 25).map((s) => pick(s));
      // Only surface genuine name variants alongside an exact hit, not fuzzy
      // spelling neighbours.
      result.candidates = scored
        .filter((x) => x.related)
        .slice(0, limit)
        .map((x) => pick(x.s, x.score));
    } else if (scored.length) {
      result.status = "possible";
      result.candidates = scored.slice(0, limit).map((x) => pick(x.s, x.score));
    }
    return result;
  }

  function pick(s, score) {
    const o = { name: s.name, kvk: s.kvk };
    if (typeof score === "number") o.score = Math.round(score * 100) / 100;
    return o;
  }

  global.INDMatcher = { init, search, ready, meta, normalize };
})(typeof self !== "undefined" ? self : this);
