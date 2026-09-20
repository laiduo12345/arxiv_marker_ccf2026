// Regenerates content/scripts/zm-data.js from the canonical repo data files.
// Reads ../data/* and writes the generated runtime table under content/scripts/.
// Run from the repository root: node tools/gen-data.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "..", "data");
const outFile = resolve(here, "..", "content", "scripts", "zm-data.js");

// Minimal CSV: venue_rankings.csv and overrides.csv deliberately avoid quoted comma
// fields; aliases use "|". Trailing optional columns may be absent.
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  const header = lines.shift().split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

function norm(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const s = String(value || "").trim();
    const n = norm(s);
    if (!s || !n || seen.has(n)) continue;
    seen.add(n);
    out.push(s);
  }
  return out;
}

const CCF_TITLE_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with",
]);

function displayTitle(value) {
  const s = String(value || "").trim();
  if (!s || /[A-Z]/.test(s)) return s;
  return s.split(/\s+/).map((word, index) => {
    if (index > 0 && CCF_TITLE_STOPWORDS.has(word)) return word;
    return word.slice(0, 1).toUpperCase() + word.slice(1);
  }).join(" ");
}

const rankRows = parseCsv(readFileSync(resolve(dataDir, "venue_rankings.csv"), "utf-8"));
const RANKINGS = rankRows.map((r) => ({
  canonical: r.canonical,
  kind: r.kind || "conference",
  core_tier: r.core_tier || "",
  aliases: r.aliases || "",
  write_as: r.write_as || "",
}));

const ovRows = parseCsv(readFileSync(resolve(dataDir, "overrides.csv"), "utf-8"));
const OVERRIDES = {};
for (const r of ovRows) {
  const aid = (r.arxiv_id || "").trim();
  if (!aid) continue;
  const year = /^\d+$/.test((r.year || "").trim()) ? parseInt(r.year, 10) : null;
  OVERRIDES[aid] = { canonical: (r.canonical || "").trim(), year };
}

// ----------------------------------------------------------------------------- CCF 2026
// The compact Markdown file is a complete transcription of all 681 entries. Only one
// title in that compact list contains a literal comma; protect it before splitting.
const CCF_COMMA_TITLES = ["Designs, Codes and Cryptography"];

function splitCcfNames(text) {
  let protectedText = text;
  const placeholders = [];
  for (let i = 0; i < CCF_COMMA_TITLES.length; i++) {
    const title = CCF_COMMA_TITLES[i];
    const token = `__CCF_COMMA_${i}__`;
    protectedText = protectedText.replace(title, token);
    placeholders.push([token, title]);
  }
  return protectedText.split(/,\s*/).map((part) => {
    let value = part.trim();
    for (const [token, title] of placeholders) value = value.replace(token, title);
    return value;
  }).filter(Boolean);
}

function parseRenamedName(raw) {
  const m = raw.match(/^(.+?)（原\s*(.+?)）$/);
  if (!m) return { canonical: raw.trim(), oldNames: [] };
  return {
    canonical: m[1].trim(),
    oldNames: m[2].split(/[、/]/).map((s) => s.trim()).filter(Boolean),
  };
}

function parseCcfQuick(text) {
  let domain = "";
  const out = [];
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      domain = line.slice(3).trim();
      continue;
    }
    const m = line.match(/^- ([ABC])类(期刊|会议)：(.+)$/);
    if (!m) continue;
    const tier = m[1];
    const kind = m[2] === "期刊" ? "journal" : "conference";
    for (const rawName of splitCcfNames(m[3])) {
      const renamed = parseRenamedName(rawName);
      out.push({
        canonical: renamed.canonical,
        kind,
        tier,
        domain,
        renamed_from: renamed.oldNames,
        aliases: uniqueStrings([renamed.canonical, rawName, ...renamed.oldNames]),
      });
    }
  }
  return out;
}

function parseCcfConferenceFull(text) {
  let domain = "";
  let tier = "";
  const rows = [];
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      domain = line.slice(3).trim();
      tier = "";
      continue;
    }
    const tierMatch = line.match(/^###\s+([ABC])$/);
    if (tierMatch) {
      tier = tierMatch[1];
      continue;
    }
    if (!domain || !tier || !line.startsWith("|")) continue;
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const [abbr, fullName, publisher, url] = cells;
    const primary = abbr || fullName;
    const renamed = parseRenamedName(primary);
    rows.push({
      domain,
      tier,
      canonical: renamed.canonical,
      raw_abbr: abbr,
      full_name: fullName,
      publisher,
      url,
      renamed_from: renamed.oldNames,
    });
  }
  return rows;
}

function dblpSlug(url) {
  const match = String(url || "").match(/dblp(?:\.uni-trier)?\.(?:de|org)\/db\/conf\/([^/?#]+)/i);
  return match ? match[1].trim() : "";
}

const MANUAL_ALIASES = JSON.parse(readFileSync(resolve(dataDir, "ccf_2026_aliases.json"), "utf-8"));
const ccfText = readFileSync(resolve(dataDir, "ccf_2026_quick.md"), "utf-8");
const CCF_2026 = parseCcfQuick(ccfText);
const conferenceFullText = readFileSync(resolve(dataDir, "ccf_2026_conferences_full.md"), "utf-8");
const CCF_CONFERENCE_FULL = parseCcfConferenceFull(conferenceFullText);
if (CCF_CONFERENCE_FULL.length !== 386) {
  throw new Error(`CCF 2026 full conference metadata count mismatch: ${CCF_CONFERENCE_FULL.length}`);
}
const conferenceFullByKey = new Map(
  CCF_CONFERENCE_FULL.map((row) => [`${row.domain}|${row.tier}|${norm(row.canonical)}`, row])
);

// Add complete official conference metadata and maintained aliases, then reuse the
// resolver's established venue aliases whenever an entry overlaps. This preserves the
// complete 681-entry directory while giving every one of the 386 conferences a full
// name, publisher and (when supplied by CCF) a DBLP/source URL.
const missingConferenceMetadata = [];
for (const entry of CCF_2026) {
  if (entry.kind === "conference") {
    const full = conferenceFullByKey.get(`${entry.domain}|${entry.tier}|${norm(entry.canonical)}`);
    if (!full) {
      missingConferenceMetadata.push(`${entry.domain}|${entry.tier}|${entry.canonical}`);
    } else {
      entry.full_name = displayTitle(full.full_name);
      entry.publisher = full.publisher || "";
      entry.url = full.url || "";
      entry.dblp_slug = dblpSlug(full.url);
      entry.aliases = uniqueStrings([
        ...entry.aliases,
        full.raw_abbr,
        full.full_name,
        ...full.renamed_from,
      ]);
    }
  }
  const exactKey = `${entry.domain}|${entry.kind}|${entry.canonical}`;
  const wildcardKey = `*|${entry.kind}|${entry.canonical}`;
  entry.aliases = uniqueStrings([
    ...entry.aliases,
    ...(MANUAL_ALIASES[exactKey] || []),
    ...(MANUAL_ALIASES[wildcardKey] || []),
  ]);

  const entryNorms = new Set(entry.aliases.map(norm));
  for (const ranking of RANKINGS) {
    if (ranking.kind !== entry.kind) continue;
    const rankingNames = uniqueStrings([
      ranking.canonical,
      ...(ranking.aliases || "").split("|"),
      ranking.write_as,
    ]);
    if (!rankingNames.some((name) => entryNorms.has(norm(name)))) continue;
    entry.aliases = uniqueStrings([...entry.aliases, ...rankingNames]);
    for (const alias of rankingNames) entryNorms.add(norm(alias));
  }

  if (!entry.full_name) {
    const longNames = entry.aliases
      .filter((name) => norm(name).split(" ").length >= 3)
      .filter((name) => !/[（(]原\s*/.test(name))
      .sort((a, b) => {
        const aCase = /[A-Z]/.test(a) ? 1 : 0;
        const bCase = /[A-Z]/.test(b) ? 1 : 0;
        return bCase - aCase || b.length - a.length;
      });
    const selectedFullName =
      entry.renamed_from.length && entry.canonical.includes(" ")
        ? entry.canonical
        : longNames[0] || (entry.canonical.includes(" ") ? entry.canonical : "");
    entry.full_name = displayTitle(selectedFullName);
  }
  entry.publisher = entry.publisher || "";
  entry.url = entry.url || "";
  entry.dblp_slug = entry.dblp_slug || "";
  delete entry.renamed_from;
}
if (missingConferenceMetadata.length) {
  throw new Error(`Missing CCF 2026 conference metadata: ${missingConferenceMetadata.join(", ")}`);
}

const CCF_2026_META = {
  edition: 7,
  year: 2026,
  publisher: "中国计算机学会",
  source: "第七版中国计算机学会推荐国际学术会议和期刊目录（正式版）",
  official_url: "https://www.ccf.org.cn/Academic_Evaluation/By_category/",
  entries: CCF_2026.length,
  journals: CCF_2026.filter((e) => e.kind === "journal").length,
  conferences: CCF_2026.filter((e) => e.kind === "conference").length,
  conference_full_names: CCF_2026.filter((e) => e.kind === "conference" && e.full_name).length,
  conference_publishers: CCF_2026.filter((e) => e.kind === "conference" && e.publisher).length,
  conference_urls: CCF_2026.filter((e) => e.kind === "conference" && e.url).length,
  conference_dblp_slugs: CCF_2026.filter((e) => e.kind === "conference" && e.dblp_slug).length,
  domains: new Set(CCF_2026.map((e) => e.domain)).size,
};

if (CCF_2026_META.entries !== 681 || CCF_2026_META.journals !== 295 || CCF_2026_META.conferences !== 386) {
  throw new Error(`CCF 2026 transcription count mismatch: ${JSON.stringify(CCF_2026_META)}`);
}

const banner = `// AUTO-GENERATED by tools/gen-data.mjs from data/* — do not edit by hand.
// Resolver venue/override tables plus the complete local CCF 2026 catalogue.
// Loaded as a classic subscript in Zotero; CommonJS export remains available for local tooling.`;

const body = `${banner}
var ZM_RANKINGS = ${JSON.stringify(RANKINGS, null, 2)};
var ZM_OVERRIDES = ${JSON.stringify(OVERRIDES, null, 2)};
var ZM_CCF_2026_META = ${JSON.stringify(CCF_2026_META, null, 2)};
var ZM_CCF_2026 = ${JSON.stringify(CCF_2026, null, 2)};
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RANKINGS: ZM_RANKINGS,
    OVERRIDES: ZM_OVERRIDES,
    CCF_2026_META: ZM_CCF_2026_META,
    CCF_2026: ZM_CCF_2026,
  };
}
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, body, "utf-8");
console.log(
  `wrote ${outFile}: ${RANKINGS.length} resolver venues, ` +
  `${Object.keys(OVERRIDES).length} overrides, ${CCF_2026_META.entries} CCF 2026 entries ` +
  `(${CCF_2026_META.journals} journals + ${CCF_2026_META.conferences} conferences)`
);
