<div align="center">

# arxiv_marker_ccf2026

**Resolve arXiv preprints to verified publications in Zotero 9/10 — with offline CCF 2026 rankings.**

[![Version](https://img.shields.io/badge/version-1.0.1-2563eb?style=flat-square)](manifest.json)
[![Zotero](https://img.shields.io/badge/Zotero-9%20%7C%2010-cc2936?style=flat-square)](https://www.zotero.org/)
[![CCF](https://img.shields.io/badge/CCF-2026-f59e0b?style=flat-square)](data/CCF_2026_SOURCE.md)
[![Catalogue](https://img.shields.io/badge/catalogue-681%20venues-7c3aed?style=flat-square)](data/ccf_2026_quick.md)
[![License](https://img.shields.io/badge/license-MIT-16a34a?style=flat-square)](LICENSE)
[![Build](https://img.shields.io/badge/XPI-reproducible-0f766e?style=flat-square)](tools/build-xpi.py)

[简体中文](README_zh.md)

</div>

`arxiv_marker_ccf2026` is an independent Zotero 9/10 plugin derived from the original
`arxiv-marker` concept. It discovers the formal conference or journal version of an arXiv
preprint, verifies the evidence, lets you review every proposed change, and displays local
Venue and CCF 2026 columns in the Zotero item list.

The plugin uses its own add-on ID, preferences, cache, reports, and undo snapshots. It can be
installed without sharing state with the original plugin. This project is not affiliated with
Zotero, arXiv, or the China Computer Federation.

## Highlights

| Capability | What it does |
|---|---|
| Verified publication discovery | Resolves arXiv items using DOI, title, authors, year, existing Zotero metadata, academic APIs, and official pages. |
| Review before write | Shows sources, confidence, CCF/CORE rank, type changes, and proposed fields before modifying the library. |
| Offline CCF 2026 | Includes all 681 entries from the seventh CCF catalogue: 295 journals and 386 conferences. |
| Native Zotero columns | Adds **Venue** and colored **CCF 2026** columns without easyScholar or zotero-style. |
| Safe local write-back | Saves a full snapshot before writing and provides an undo command for the latest operation. |
| Bounded networking | Uses staged concurrency, per-source pacing, deadlines, cancellation, deduplication, circuit breaks, and persistent caching. |

## How it works

1. Select parent items or a collection in Zotero.
2. The plugin gathers local metadata and queries eligible discovery sources concurrently.
3. Candidate records are checked against the original title, authors, year, DOI, and venue identity.
4. A review window presents the evidence and proposed Zotero fields.
5. Only checked rows are written; the previous state remains available for undo.

Weak evidence, timeouts, rate limits, and network failures are reported separately. An
unverified result is not treated as proof that a paper was never published.

## Discovery sources

The resolver can combine:

- arXiv Atom metadata and arXiv abstract pages;
- Semantic Scholar, DBLP, OpenReview, Crossref, and DataCite;
- OpenCitations Meta and optional OpenAlex;
- verified DOI content negotiation and related-version DOI links;
- official conference and publisher pages, including AAAI OJS and targeted USENIX pages;
- optional Brave Search and key-free DuckDuckGo HTML/Lite fallback.

Search results and page snippets are candidate evidence only. A destination record must still
pass title, author, and venue checks before the plugin proposes a write.

## What changed from the original arxiv-marker

- Rebuilt the repository as a single native Zotero 9/10 plugin; the legacy Python CLI, local Web
  UI, duplicate release reports, and split versioning were removed.
- Replaced the global batch barrier and mostly serial fallback chain with staged, bounded
  per-item discovery.
- Fixed browser JSON XHR handling so a successful JSON response is not discarded by reading
  the invalid `responseText` getter.
- Added arXiv HTML fallback, AAAI OJS discovery, DOI CSL negotiation, related Crossref DOIs,
  official-page metadata, and verified Web-search fallback.
- Added request budgets, host-family pacing, in-flight deduplication, short circuit breaks,
  persistent caching, and real request cancellation.
- Added the complete local CCF 2026 catalogue with conservative identity matching. Workshops,
  Findings, tutorials, demos, and companion tracks do not inherit a main-conference rank.
- Introduced a separate plugin identity and storage namespace:
  `arxiv_marker_ccf2026@local`.
- Made XPI packaging deterministic by normalizing archive order, timestamps, paths, and file
  permissions.

## Installation

### Build from source

Python's standard library is sufficient for packaging:

```powershell
py -3 .\tools\build-xpi.py
```

The output is:

```text
build/arxiv_marker_ccf2026-1.0.1.xpi
```

### Install in Zotero

1. Open **Tools → Plugins** in Zotero 9 or 10.
2. Choose **Install Plugin From File**.
3. Select the generated XPI.
4. Fully quit and restart Zotero.

The plugin reads its update manifest from the latest GitHub Release. Both the manifest and XPI
assets are publicly downloadable, so Zotero can check and install later releases without GitHub
credentials.

## Usage

- Right-click selected parent items and choose **Resolve venue with arxiv_marker_ccf2026**.
- Right-click a collection to process its regular items in a batch.
- Inspect the review table, select the rows you trust, and choose **Write selected**.
- Use **Deep recheck selected items** for difficult cases; it bypasses the query cache and
  expands discovery within a larger budget.
- Use the Tools menu to stop a run, clear the lookup cache, or undo the latest write.
- Enable the **Venue** and **CCF 2026** columns from Zotero's item-list column picker.

### Manual override

Add these lines to a Zotero item's `Extra` field when you have independently verified a venue:

```text
arxiv_marker_ccf2026-venue: AAAI
arxiv_marker_ccf2026-year: 2025
```

## Configuration

| Setting | Recommended default | Notes |
|---|---:|---|
| Concurrent items | `3` | Configurable from 1 to 6. |
| Official Web discovery | On | Queries supported conference and publisher pages. |
| Web-search fallback | On | Used only after stronger structured routes. |
| DuckDuckGo fallback | On | Requires no API key; may still be rate-limited. |
| Deep mode | Off | Use for a small number of difficult items. |
| Auto-select confidence | `0.80` | Lower-confidence proposals remain visible but unchecked. |

Semantic Scholar, OpenCitations, OpenAlex, and Brave credentials are optional. Sources that
require a missing credential are skipped while the rest of the pipeline continues.

Normal mode allows about 45 seconds of active work per item; deep mode allows about 90 seconds.
An individual HTTP request is capped at 8 seconds or the smaller remaining source/item budget.

## Data maintenance

The generated runtime catalogue lives in `content/scripts/zm-data.js`. After editing data under
`data/`, regenerate it with:

```powershell
node .\tools\gen-data.mjs
```

The generator validates the expected CCF counts before replacing the runtime table.

## Project layout

```text
bootstrap.js                       Zotero lifecycle and runtime loader
manifest.json                      Plugin identity and compatibility
prefs.js                           Default preferences
content/                           UI, resolver, scheduler, and generated runtime data
data/                              CCF 2026 and venue-matching source data
tools/build-xpi.py                 Reproducible XPI builder
tools/build-xpi.ps1                PowerShell XPI builder
tools/gen-data.mjs                 Runtime data generator
```

## Privacy and limitations

- Cache and last-run reports are stored in the Zotero data directory and may contain paper
  titles, item identifiers, evidence URLs, and public lookup results.
- API keys are not intentionally written to the plugin cache or report. Zotero's full debug
  output may still contain request URLs; inspect and redact logs before sharing them.
- Public APIs and publisher sites can change, throttle requests, block automation, or omit a
  publication. The plugin deliberately abstains when identity evidence is insufficient.
- Source-level checks and reproducible packaging do not replace an installation test in a real
  Zotero profile.

### Update delivery

`manifest.json` points to `releases/latest/download/update.json`. The update manifest points to
the immutable versioned XPI asset and includes its SHA-256 hash and Zotero compatibility range.
Both URLs are public HTTPS endpoints and are suitable for Zotero's unattended update checks.

## License and attribution

Project code is available under the [MIT License](LICENSE). The CCF catalogue is used as a local
bibliographic lookup dataset and remains subject to the rights of its publisher. See
[data/CCF_2026_SOURCE.md](data/CCF_2026_SOURCE.md) for source and matching policy.
