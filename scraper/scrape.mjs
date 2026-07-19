#!/usr/bin/env node
/**
 * IND recognised-sponsors scraper.
 *
 * Downloads the public register of recognised sponsors for work from the IND
 * website and extracts every organisation + KvK number into JSON.
 *
 * The register is rendered as a single static HTML <table>, where each data row
 * looks like:
 *
 *     <tr>
 *         <th scope="row">Company Name B.V.</th>
 *         <td>12345678</td>
 *     </tr>
 *
 * Re-run this whenever you want to refresh the dataset bundled with the
 * extension. It writes ../extension/data/sponsors.json by default.
 *
 * Usage:
 *     node scrape.mjs                 # fetch live page + write JSON
 *     node scrape.mjs --html file     # parse a local HTML file instead
 *     node scrape.mjs --out ./somedir # change output directory
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SOURCE_URL =
  "https://ind.nl/en/public-register-recognised-sponsors/public-register-work";

function parseArgs(argv) {
  const args = { out: resolve(__dirname, "../extension/data"), html: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = resolve(argv[++i]);
    else if (argv[i] === "--html") args.html = resolve(argv[++i]);
  }
  return args;
}

/** Decode the handful of HTML entities that appear in company names. */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function clean(str) {
  return decodeEntities(str.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract { name, kvk } records from the register HTML.
 * Rows are <th scope="row">name</th> immediately followed by <td>kvk</td>.
 */
function extractSponsors(html) {
  const rows = [];
  const rowRe =
    /<th[^>]*scope=["']row["'][^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const name = clean(m[1]);
    const kvk = clean(m[2]);
    if (name) rows.push({ name, kvk });
  }
  return rows;
}

/** Pull the "last updated on <date>" line so we can show data freshness. */
function extractUpdatedDate(html) {
  const m = html.match(/last updated on ([^<.]+)/i);
  return m ? clean(m[1]) : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let html;
  if (args.html) {
    console.log(`Reading local HTML: ${args.html}`);
    html = await readFile(args.html, "utf-8");
  } else {
    console.log(`Fetching ${SOURCE_URL} ...`);
    const res = await fetch(SOURCE_URL, {
      headers: { "User-Agent": "ind-sponsor-checker/1.0 (personal use)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    html = await res.text();
  }

  const sponsors = extractSponsors(html);
  if (sponsors.length === 0) {
    throw new Error(
      "No sponsors found — the page structure may have changed. Inspect the HTML."
    );
  }

  // De-duplicate on name+kvk (defensive) and sort alphabetically, case-insensitive.
  const seen = new Set();
  const unique = [];
  for (const r of sponsors) {
    const key = `${r.name.toLowerCase()}|${r.kvk}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  unique.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );

  const updated = extractUpdatedDate(html);
  const payload = {
    source: SOURCE_URL,
    scrapedAt: new Date().toISOString(),
    registerUpdatedOn: updated,
    count: unique.length,
    sponsors: unique,
  };

  await mkdir(args.out, { recursive: true });
  const jsonPath = join(args.out, "sponsors.json");
  await writeFile(jsonPath, JSON.stringify(payload), "utf-8");

  console.log(`\n✔ Extracted ${unique.length} recognised sponsors`);
  if (updated) console.log(`  Register last updated on: ${updated}`);
  console.log(`  JSON → ${jsonPath}`);
  console.log("\nSample:");
  for (const r of unique.slice(0, 5)) console.log(`  • ${r.name} (${r.kvk})`);
}

main().catch((err) => {
  console.error("\n✖ Scrape failed:", err.message);
  process.exit(1);
});
