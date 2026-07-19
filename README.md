# IND Sponsor Checker

How to use:
-> *Remember to enable **developer mode** in extentions page in chrome*

https://github.com/user-attachments/assets/73c5a0da-5019-41b3-a46c-cdf14e0fbf1d


### Nice source of Visa sponsoring jobs
https://www.welcome-to-nl.nl/jobs/

---

A Chrome extension to quickly check whether a company is an **IND-recognised
sponsor for work** in the Netherlands — the official list of employers allowed
to sponsor work/knowledge-migrant visas.

Highlight a company name on any web page (a job board, LinkedIn, a careers page)
and instantly see if it's in the register, so you can filter employers before
applying.

Data comes from the official IND public register:
<https://ind.nl/en/public-register-recognised-sponsors/public-register-work>

---

## Features

- **Highlight-to-check** — select a company name on any page; a *Check sponsor*
  pill appears. Click it for a result card (✓ recognised / ≈ possible / ✗ not found).
- **Right-click menu** — *Check "…" in the IND sponsor register* on any selection.
- **Keyboard shortcut** — `Alt+Shift+S` checks the current selection.
- **Toolbar popup** — click the icon and type a company name or KvK number for
  live search with fuzzy matching.
- **Smart matching** — ignores legal/geographic noise (`B.V.`, `Netherlands`,
  `Holding`, …), tolerates typos, and can look up by 8-digit KvK number.
- **KvK verification links** — every result links to kvk.nl to confirm the
  exact legal entity.
- **Fully offline** — the register is bundled with the extension; no network
  calls, nothing about your browsing leaves the machine.
- **Recent searches** in the popup, and a toolbar badge (✓/~/✗) after a lookup.

---

## Project layout

```
ind_finder/
├── scraper/
│   └── scrape.mjs          # regenerates the bundled dataset from ind.nl
└── extension/
    ├── manifest.json       # MV3 manifest
    ├── data/
    │   └── sponsors.json   # bundled register (used by the extension)
    ├── icons/
    └── src/
        ├── matcher.js      # shared matching engine (background + popup)
        ├── background.js   # service worker: data, context menu, command
        ├── content.js      # on-page selection pill + result card
        ├── popup.html/.css/.js
```

---

## Install the extension (unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the icon from the puzzle-piece menu for easy access.

The keyboard shortcut can be changed at `chrome://extensions/shortcuts`.

> Works in any Chromium browser (Chrome, Edge, Brave, Arc).

---

## Updating the data

The IND register is updated monthly. To refresh the bundled dataset:

```bash
node scraper/scrape.mjs
```

This fetches the live page, extracts every organisation + KvK number, and
rewrites `extension/data/sponsors.json`. Reload the extension in
`chrome://extensions` afterwards to pick up the new data.

Options:

```bash
node scraper/scrape.mjs --html page.html   # parse a saved HTML file instead of fetching
node scraper/scrape.mjs --out ./somewhere  # write to a different directory
```

Requires Node 18+ (uses the built-in `fetch`). No dependencies to install.

---

## How matching works

Company names in the register carry legal and geographic suffixes, but people
usually highlight just the brand (`Uber`, `ASML`). The matcher builds two
normalised forms of every name:

- **norm** — lowercased, accent-stripped, punctuation removed.
- **core** — `norm` with noise words removed (`bv`, `nv`, `holding`,
  `netherlands`, `europe`, …).

A query is checked against both. An exact `norm`/`core` match (or an 8-digit KvK
match) is reported as **Recognised**. Otherwise the engine scores candidates by
token overlap, prefix/substring, and edit distance, and shows the closest names
as **Possible** matches to verify by KvK number.

> ⚠️ Always confirm the exact legal entity via the linked KvK page before
> relying on a result — several unrelated companies can share a brand word, and
> the employer's legal name often differs from the name in a job posting.
