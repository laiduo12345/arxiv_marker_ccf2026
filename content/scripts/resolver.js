// arxiv_marker_ccf2026 Zotero resolver.
// Pure bibliographic parsing and provider definitions; network scheduling is in pipeline.js. All I/O is
// INJECTED via opts.request(method, url, {headers, body}) -> {status, data}. This lets the
// SAME file run in Node (tests, fetch adapter) and in Zotero (loadSubScript, Zotero.HTTP
// adapter). Top-level vars/functions intentionally live in the shared plugin scope under
// loadSubScript; the guarded module.exports at the bottom is for the Node test harness.

// --- data (embedded; see content/scripts/zm-data.js / tools/gen-data.mjs) -------------
var ZMData =
  typeof require !== "undefined" ? require("./zm-data.js") : { RANKINGS: ZM_RANKINGS, OVERRIDES: ZM_OVERRIDES };
var ZMCCFResolver =
  typeof ZMCCF !== "undefined"
    ? ZMCCF
    : typeof require !== "undefined"
      ? require("./ccf.js")
      : null;

// ====================================================================== util ==========
var _ARXIV_NEW = /(\d{4}\.\d{4,5})(v\d+)?/i;
var _ARXIV_FULL = /^(\d{4}\.\d{4,5})(v\d+)?$/i;
var _ARXIV_TAGGED = /arxiv[:.\s/]*?(\d{4}\.\d{4,5})/i;

function extractArxivId(data) {
  const archiveId = data.archiveID || "";
  let m = archiveId.match(_ARXIV_TAGGED) || archiveId.match(_ARXIV_NEW);
  if (m && (archiveId.toLowerCase().includes("arxiv") || _ARXIV_FULL.test(archiveId.trim() || "x"))) {
    return m[1];
  }
  const doi = data.DOI || "";
  m = doi.match(_ARXIV_TAGGED);
  if (m) return m[1];
  for (const field of ["url", "extra"]) {
    const val = data[field] || "";
    if (val.toLowerCase().includes("arxiv")) {
      m = val.match(_ARXIV_TAGGED) || val.match(_ARXIV_NEW);
      if (m) return m[1];
    }
  }
  return null;
}

function normTitle(s) {
  if (!s) return "";
  s = String(s)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/&(?:amp|lt|gt|quot|apos);/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  return s.replace(/\s+/g, " ").trim();
}

function titleJaccard(a, b) {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return 0.0;
  if (na === nb) return 1.0;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  if (!ta.size || !tb.size) return 0.0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

function titleSimilarity(a, b) {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return 0.0;
  if (na === nb) return 1.0;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const token of ta) if (tb.has(token)) inter++;
  if (!inter) return 0.0;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = inter / union;
  const minSize = Math.min(ta.size, tb.size);
  const maxSize = Math.max(ta.size, tb.size);
  // Subtitle additions and camera-ready title expansions often preserve every token of
  // the shorter title. Reward that containment, while retaining a length penalty and
  // avoiding aggressive expansion for one- or two-token generic titles.
  if (minSize < 3) return jaccard;
  const overlap = inter / minSize;
  const lengthRatio = minSize / maxSize;
  const containment = overlap * (0.82 + 0.18 * lengthRatio);
  return Math.max(jaccard, containment);
}

function titleMatch(a, b, threshold = 0.85) {
  return titleSimilarity(a, b) >= threshold;
}

function firstAuthorLastname(data) {
  for (const c of data.creators || []) {
    if (c.creatorType === "author" && c.lastName) return c.lastName;
  }
  return "";
}

// ================================================================== rankings ==========
const _DISQUALIFIERS = new Set([
  "workshop", "workshops", "findings", "doctoral", "companion", "tutorial", "tutorials",
  "demonstration", "demonstrations", "poster", "abstracts", "satellite",
]);
const _GENERIC_SUFFIX = new Set([
  "symposium", "conference", "conferences", "proceedings", "meeting", "congress",
]);

function _tokens(s) {
  return s.toLowerCase().match(/[a-z0-9]+/g) || [];
}

let _TABLE_CACHE = null;
function _table() {
  if (_TABLE_CACHE) return _TABLE_CACHE;
  _TABLE_CACHE = ZMData.RANKINGS.map((r) => {
    const aliases = (r.aliases || "")
      .split("|")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    aliases.push(r.canonical.toLowerCase());
    return {
      canonical: r.canonical,
      kind: (r.kind || "conference").trim(),
      core: (r.core_tier || "").trim(),
      aliases,
      write_as: (r.write_as || "").trim(),
    };
  });
  return _TABLE_CACHE;
}

function _runIndex(hay, needle) {
  if (!needle.length) return -1;
  for (let i = 0; i <= hay.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function lookupCoreRanking(venueRaw) {
  if (!venueRaw) return null;
  const v = venueRaw.toLowerCase().trim();
  const vTokens = _tokens(v);
  if (!vTokens.length) return null;
  const blocked = vTokens.some((t) => _DISQUALIFIERS.has(t));
  let substringHit = null;
  for (const row of _table()) {
    for (const a of row.aliases) {
      if (v === a) return row;
      if (blocked || substringHit !== null) continue;
      const at = _tokens(a);
      const idx = _runIndex(vTokens, at);
      if (idx < 0) continue;
      const after = vTokens.slice(idx + at.length);
      if (after.length && !after.every((t) => /^\d+$/.test(t) || _GENERIC_SUFFIX.has(t))) continue;
      substringHit = row;
    }
  }
  return substringHit;
}

function _ccfToRanking(match) {
  if (!match || match.ambiguous) return null;
  return {
    canonical: match.canonical,
    kind: match.kind || "conference",
    core: "",
    aliases: [],
    write_as: match.full_name || "",
    full_name: match.full_name || "",
    publisher: match.publisher || "",
    url: match.url || "",
    dblp_slug: match.dblp_slug || "",
    ccf_tier: match.tier || "",
    ccf_domain: match.domain || "",
    ccf_match: match,
  };
}

// Unified venue canonicalizer. The original table supplies CORE tiers for a curated set;
// the local CCF 2026 table expands recognition to all 386 recommended conferences and
// 295 recommended journals. Ambiguous short names (e.g. FSE) still abstain.
function lookupRanking(venueRaw, kindHint = null) {
  const core = lookupCoreRanking(venueRaw);
  let ccf = null;
  if (ZMCCFResolver && ZMCCFResolver.lookup) {
    const hint = kindHint || (core && core.kind) || null;
    ccf = ZMCCFResolver.lookup(venueRaw, hint);
    if ((!ccf || ccf.ambiguous) && core) ccf = ZMCCFResolver.lookup(core.canonical, core.kind);
  }
  if (core) {
    const row = { ...core };
    if (ccf && !ccf.ambiguous) {
      row.ccf_tier = ccf.tier || "";
      row.ccf_domain = ccf.domain || "";
      row.ccf_match = ccf;
      row.full_name = ccf.full_name || row.write_as || "";
      row.publisher = ccf.publisher || "";
      row.url = ccf.url || "";
      row.dblp_slug = ccf.dblp_slug || "";
      // CCF may use a newer canonical name (KDD -> SIGKDD).
      row.canonical = ccf.canonical || row.canonical;
    }
    return row;
  }
  return _ccfToRanking(ccf);
}

// ================================================================= resolvers ==========
function isNonvenue(v) {
  if (!v) return true;
  const s = v.trim().toLowerCase();
  return s.includes("arxiv") || s === "corr" || s === "preprint" || s === "";
}

function _s2VenueType(pv, pubTypes) {
  // S2 often omits publicationVenue.type even when it clearly knows the paper is a
  // JournalArticle and gives the venue an ISSN (TNNLS / Science Robotics). Reading only
  // pv.type made those come back null and the proposal defaulted them to conferencePaper.
  // Fall back to the per-paper publicationTypes, then to the presence of an ISSN.
  if (pv.type) return pv.type;
  const types = pubTypes || [];
  if (types.includes("JournalArticle")) return "journal";
  if (types.includes("Conference")) return "conference";
  if (pv.issn) return "journal";
  return null;
}

function _authorsOf(info) {
  let a = (info.authors || {}).author;
  if (a && !Array.isArray(a)) a = [a];
  return (a || []).filter((x) => x && typeof x === "object").map((x) => x.text || "");
}

const _S2_FIELDS =
  "title,venue,publicationVenue,year,externalIds,publicationTypes,citationCount,influentialCitationCount,authors";
const _S2_BATCH = "https://api.semanticscholar.org/graph/v1/paper/batch";
const _S2_MATCH = "https://api.semanticscholar.org/graph/v1/paper/search/match";
const _S2_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search";

function _defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _normalizePerson(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function _authorMatches(authorLastname, authors) {
  const needle = _normalizePerson(authorLastname);
  if (!needle) return true;
  for (const author of authors || []) {
    const name = _normalizePerson(typeof author === "string" ? author : author && author.name);
    if (!name) continue;
    const tokens = name.split(" ");
    if (tokens.includes(needle) || (` ${name} `).includes(` ${needle} `)) return true;
  }
  return false;
}

function verifyIdentity(data, foundTitle, authors = []) {
  const query = normTitle(data.title), found = normTitle(foundTitle);
  if (!query || !found) return { ok: false, reason: "missing-title" };
  const jac = titleJaccard(query, found), sim = titleSimilarity(query, found);
  const qt = query.split(" "), ft = found.split(" ");
  const ratio = Math.min(qt.length, ft.length) / Math.max(qt.length, ft.length);
  if (jac < 0.82 && !(sim >= 0.90 && ratio >= 0.70)) return { ok: false, reason: "title-mismatch" };
  const qs = (data.creators || []).filter((c) => !c.creatorType || c.creatorType === "author");
  const fs = (authors || []).map((a) => _normalizePerson(typeof a === "string" ? a : a.name || [a.given, a.family].filter(Boolean).join(" "))).filter(Boolean);
  if (!qs.length || !fs.length) return { ok: query === found || (sim >= 0.96 && ratio >= 0.9), reason: "title-only", score: sim };
  let overlaps = 0, first = false;
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i], family = _normalizePerson(q.lastName || q.name || "");
    const given = _normalizePerson(q.firstName || "").split(" ")[0];
    const familyParts = family.split(" ").filter((t) => t.length >= 4);
    const match = fs.some((f) => {
      const words = f.split(" ");
      const givenOk = !given || given.length === 1 || words.includes(given) || words.includes(given.slice(0, 1));
      if (family && (` ${f} `).includes(` ${family} `)) return givenOk;
      // Peigne-Lefebvre versus Peigné; do not match generic short surnames/initials.
      return !!given && given.length > 1 && f.split(" ").includes(given) && familyParts.some((t) => f.split(" ").includes(t));
    });
    if (match) { overlaps++; if (i === 0) first = true; }
  }
  return { ok: first || (overlaps >= 2 && sim >= 0.92), reason: first || overlaps >= 2 ? "title-and-authors" : "author-mismatch", score: sim };
}

function _s2RecordToHit(rec, source, evidenceUrl) {
  if (!rec) return null;
  const pv = rec.publicationVenue || {};
  const ext = rec.externalIds || {};
  const name = pv.name || rec.venue;
  const alts = pv.alternate_names || pv.alternateNames || [];
  const altList = Array.isArray(alts) ? alts : [];
  const abbrev =
    altList.find((a) => {
      const row = lookupRanking(a, _s2VenueType(pv, rec.publicationTypes));
      return !!(row && row.ccf_tier);
    }) ||
    altList.find((a) => /[A-Z]/.test(a) && a === a.toUpperCase() && a.length >= 2 && a.length <= 16) ||
    null;
  return {
    source,
    title: rec.title || null,
    authors: rec.authors || [],
    title_score: null,
    venue_raw: isNonvenue(name) ? null : name,
    year: rec.year ?? null,
    venue_type: _s2VenueType(pv, rec.publicationTypes),
    citation_count: rec.citationCount ?? null,
    influential_citations: rec.influentialCitationCount ?? null,
    external_doi: ext.DOI ?? null,
    dblp_key: ext.DBLP ?? null,
    evidence_url: evidenceUrl || rec.url || null,
    issn: pv.issn ?? null,
    abbrev,
    publisher: null,
  };
}

function makeS2(request, apiKey, sleep) {
  sleep = sleep || _defaultSleep;
  const baseHeaders = {};
  if (apiKey) baseHeaders["x-api-key"] = apiKey;

  async function requestWithRetry(method, url, opts = {}, tries = 6) {
    tries = request.managed ? 1 : tries;
    let delay = 1500;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await request(method, url, {
          ...opts,
          headers: { ...baseHeaders, ...(opts.headers || {}) },
        });
        const transient = res.status === 0 || res.status === 408 || res.status === 425 ||
          res.status === 429 || (res.status >= 500 && res.status < 600);
        if (transient) {
          if (i < tries - 1) {
            await sleep(delay);
            delay = Math.min(delay * 2, 30000);
            continue;
          }
          return null;
        }
        if (res.status < 200 || res.status >= 300) return null;
        return res.data;
      } catch (e) {
        if (i < tries - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 30000);
        }
      }
    }
    return null;
  }

  async function batchByArxiv(arxivIds) {
    const out = {};
    for (let i = 0; i < arxivIds.length; i += 100) {
      const chunk = arxivIds.slice(i, i + 100);
      const recs = await requestWithRetry(
        "POST",
        _S2_BATCH + "?fields=" + encodeURIComponent(_S2_FIELDS),
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunk.map((a) => "ARXIV:" + a) }),
        }
      );
      if (!recs) continue;
      for (let j = 0; j < chunk.length; j++) {
        const rec = recs[j];
        if (!rec) continue;
        out[chunk[j]] = _s2RecordToHit(
          rec,
          "semantic_scholar",
          "https://www.semanticscholar.org/arxiv/" + chunk[j]
        );
      }
    }
    return out;
  }

  function candidateScore(rec, title, authorLastname, yearHint) {
    const jac = titleSimilarity(title, rec.title || "");
    if (jac < 0.78) return null;
    const authors = rec.authors || [];
    const authorOk = _authorMatches(authorLastname, authors);
    if (authorLastname && authors.length && !authorOk && jac < 0.96) return null;
    const year = rec.year ?? null;
    if (yearHint && year && Math.abs(year - yearHint) > 4 && jac < 0.96) return null;
    const hit = _s2RecordToHit(
      rec,
      "semantic_scholar_title",
      rec.paperId ? "https://www.semanticscholar.org/paper/" + rec.paperId : null
    );
    if (!hit || !hit.venue_raw) return null;
    hit.title_score = jac;
    const row = lookupRanking(hit.venue_raw, hit.venue_type);
    let score = jac * 10;
    if (authorOk && authorLastname) score += 2;
    if (yearHint && year && Math.abs(year - yearHint) <= 1) score += 1;
    if (row && row.ccf_tier) score += 8;
    else if (row) score += 3;
    return { score, hit };
  }

  async function bestByTitle(title, authorLastname = "", yearHint = null) {
    if (!String(title || "").trim()) return null;
    const urls = [
      _S2_MATCH + "?query=" + encodeURIComponent(title) + "&fields=" + encodeURIComponent(_S2_FIELDS),
      _S2_SEARCH + "?query=" + encodeURIComponent(title) + "&limit=10&fields=" + encodeURIComponent(_S2_FIELDS),
    ];
    const candidates = [];
    for (let i = 0; i < urls.length; i++) {
      const data = await requestWithRetry("GET", urls[i], {});
      if (!data) continue;
      const records = i === 0
        ? (Array.isArray(data.data) ? data.data : data.data ? [data.data] : [data])
        : (Array.isArray(data.data) ? data.data : []);
      for (const rec of records) {
        const scored = candidateScore(rec, title, authorLastname, yearHint);
        if (scored) candidates.push(scored);
      }
      if (candidates.some((c) => {
        const row = lookupRanking(c.hit.venue_raw, c.hit.venue_type);
        return row && row.ccf_tier;
      })) break;
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].hit : null;
  }

  return { batchByArxiv, bestByTitle };
}


// ====================================================================== arXiv =========
const _ARXIV_API = "https://export.arxiv.org/api/query";
const _ARXIV_ACCEPT_RE = /\b(?:accepted|published|to\s+appear|forthcoming|in\s+proceedings|camera[- ]ready|presented)\b/i;
const _ARXIV_NEGATIVE_RE = /\b(?:submitted|submission|under\s+review|withdrawn|rejected|workshop|findings|tutorial|demo|companion)\b/i;

function _decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function _xmlTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const m = String(block || "").match(re);
  return m ? _decodeXml(m[1]) : "";
}

function _yearFromText(value) {
  const m = String(value || "").match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
  return m ? parseInt(m[1], 10) : null;
}

function _venueHitFromText(text, source, defaultYear, extra = {}) {
  if (!text) return null;
  const kindHint = /journal|transactions|letters|review/i.test(text) ? "journal" : null;
  const row = lookupRanking(text, kindHint);
  if (!row) return null;
  return {
    source,
    title: null,
    authors: [],
    title_score: 1,
    venue_raw: row.canonical,
    year: _yearFromText(text) || defaultYear || null,
    venue_type: row.kind,
    citation_count: null,
    influential_citations: null,
    external_doi: extra.doi || null,
    dblp_key: null,
    evidence_url: extra.evidence_url || null,
    issn: null,
    abbrev: row.canonical,
    publisher: null,
    note: text,
  };
}

function parseArxivAtom(xml) {
  const out = {};
  const entries = String(xml || "").match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  for (const entry of entries) {
    const idText = _xmlTag(entry, "id");
    const m = idText.match(/(?:abs\/|arxiv[:.])?(\d{4}\.\d{4,5})(?:v\d+)?/i);
    if (!m) continue;
    const aid = m[1];
    const published = _xmlTag(entry, "published");
    const publishedYear = _yearFromText(published);
    const journalRef = _xmlTag(entry, "arxiv:journal_ref");
    const comment = _xmlTag(entry, "arxiv:comment");
    const doi = _xmlTag(entry, "arxiv:doi") || null;
    const hits = [];
    const journalHit = _venueHitFromText(journalRef, "arxiv_journal_ref", publishedYear, {
      doi,
      evidence_url: "https://arxiv.org/abs/" + aid,
    });
    if (journalHit) hits.push(journalHit);
    if (comment && _ARXIV_ACCEPT_RE.test(comment) && !_ARXIV_NEGATIVE_RE.test(comment)) {
      const commentHit = _venueHitFromText(comment, "arxiv_comment", publishedYear, {
        doi,
        evidence_url: "https://arxiv.org/abs/" + aid,
      });
      if (commentHit) hits.push(commentHit);
    }
    out[aid] = {
      arxiv_id: aid,
      title: _xmlTag(entry, "title"),
      comment,
      journal_ref: journalRef,
      doi,
      published_year: publishedYear,
      hits,
    };
  }
  return out;
}

function makeArxiv(request, sleep) {
  sleep = sleep || _defaultSleep;
  async function getWithRetry(url, tries = 4) {
    tries = request.managed ? 1 : tries;
    let delay = 1000;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await request("GET", url, {
          responseType: "text",
          headers: { Accept: "application/atom+xml, application/xml, text/xml" },
        });
        const transient = res.status === 0 || res.status === 408 || res.status === 425 ||
          res.status === 429 || (res.status >= 500 && res.status < 600);
        if (transient) {
          if (i < tries - 1) {
            await sleep(delay);
            delay = Math.min(delay * 2, 10000);
            continue;
          }
          return "";
        }
        if (res.status < 200 || res.status >= 300) return "";
        if (typeof res.data === "string") return res.data;
        if (res.text) return res.text;
        return "";
      } catch (e) {
        if (i < tries - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 10000);
        }
      }
    }
    return "";
  }

  async function batchByArxiv(arxivIds) {
    const out = {};
    for (let i = 0; i < arxivIds.length; i += 30) {
      const chunk = arxivIds.slice(i, i + 30);
      const url = _ARXIV_API + "?id_list=" + encodeURIComponent(chunk.join(",")) +
        "&start=0&max_results=" + chunk.length;
      const xml = await getWithRetry(url);
      Object.assign(out, parseArxivAtom(xml));
    }
    return out;
  }

  return { batchByArxiv, parse: parseArxivAtom };
}


// ================================================================= OpenReview =========
const _OR_SEARCH = "https://api2.openreview.net/notes/search";
const _OR_REJECT_PHRASES = [
  "withdrawn", "withdrawal", "rejected", "rejection", "desk rejected",
  "desk_rejected", "submission",
  "submitted to", "under review", "under_review", "pending decision", "pending_decision",
  "workshop", "workshops", "findings", "tutorial", "tutorials",
  "abstract", "abstracts", "demonstration", "demonstrations",
  "doctoral consortium", "companion",
];

function _orValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return value.value;
  }
  return value;
}

function _safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function _openReviewYear(venueId, venueText, pdate) {
  for (const value of [venueId || "", venueText || ""]) {
    const m = String(value).match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
    if (m) return parseInt(m[1], 10);
  }
  let stamp = Number(pdate);
  if (Number.isFinite(stamp) && stamp > 0) {
    if (stamp < 10000000000) stamp *= 1000;
    return new Date(stamp).getUTCFullYear();
  }
  return null;
}

function openReviewVenueMeta(venueId, venueText, pdate) {
  venueId = String(venueId || "").trim();
  venueText = String(venueText || "").trim();
  if (!venueId) return null;

  const status = _safeDecode(`${venueId} ${venueText}`).toLowerCase();
  if (_OR_REJECT_PHRASES.some((phrase) => status.includes(phrase))) return null;

  const parts = venueId.split("/").filter(Boolean).map(_safeDecode);
  const host = parts.length ? parts[0] : "";
  const hostShort = host.replace(/\.(?:cc|org|net|com|edu)$/i, "");
  const candidates = [
    hostShort,
    ...parts,
    venueText,
    venueId.replace(/\//g, " ").replace(/_/g, " "),
  ];

  let row = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    row = lookupRanking(candidate);
    if (row) break;
  }
  if (!row) return null;

  return {
    row,
    kind: row.kind,
    year: _openReviewYear(venueId, venueText, pdate),
  };
}

function _firstString(value) {
  value = _orValue(value);
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item || "").trim();
      if (text) return text;
    }
  }
  return null;
}

function makeOpenReview(request, sleep) {
  sleep = sleep || _defaultSleep;
  const cache = new Map();

  async function getWithRetry(url, tries = 3) {
    tries = request.managed ? 1 : tries;
    let delay = 1000;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await request("GET", url, { headers: { Accept: "application/json" } });
        const transient = res.status === 0 || res.status === 408 || res.status === 425 ||
          res.status === 429 || (res.status >= 500 && res.status < 600);
        if (transient) {
          if (i < tries - 1) {
            await sleep(delay);
            delay = Math.min(delay * 2, 10000);
            continue;
          }
          return [];
        }
        if (res.status < 200 || res.status >= 300) return [];
        return ((res.data || {}).notes || []);
      } catch (e) {
        if (i < tries - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 10000);
        }
      }
    }
    return [];
  }

  async function searchNotes(term, type = "terms", content = "all") {
    term = String(term || "").trim();
    if (!term) return [];
    const key = `${content}|${type}|${normTitle(term)}`;
    if (cache.has(key)) return cache.get(key);

    const url = _OR_SEARCH + "?term=" + encodeURIComponent(term) +
      `&type=${encodeURIComponent(type)}&content=${encodeURIComponent(content)}&source=forum&limit=50`;
    const notes = await getWithRetry(url);
    const byId = new Map();
    const anonymous = [];
    for (const note of notes) {
      if (!note || typeof note !== "object") continue;
      if (note.id) byId.set(note.id, note);
      else anonymous.push(note);
    }
    const out = [...byId.values(), ...anonymous];
    cache.set(key, out);
    return out;
  }

  async function searchTitle(title, exact) {
    return searchNotes(title, exact ? "exact" : "terms", "title");
  }

  function bestFromNotes(notes, title, authorLastname, queryData) {
    let best = null;
    let bestScore = -1;
    const normalizePerson = (value) => String(value || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    const authorNeedle = normalizePerson(authorLastname);

    for (const note of notes) {
      if (!note || typeof note !== "object") continue;
      if (note.replyto) continue;
      if (note.forum && note.id !== note.forum) continue;

      const content = note.content || {};
      const foundTitle = String(_orValue(content.title) || "");
      const jac = titleJaccard(title, foundTitle);
      if (jac < 0.88) continue;

      let authors = _orValue(content.authors) || [];
      if (!Array.isArray(authors)) authors = [authors];
      const firstAuthor = authors.length ? normalizePerson(authors[0]) : "";
      const authorOk = !authorNeedle || (
        !!firstAuthor && (` ${firstAuthor} `).includes(` ${authorNeedle} `)
      );
      if (queryData && Array.isArray(queryData.creators) && queryData.creators.length) {
        if (!verifyIdentity(queryData, foundTitle, authors).ok) continue;
      } else if (authorNeedle) {
        // The hint is the arXiv first author's surname. Matching only a later co-author
        // is insufficient; missing author metadata requires an almost exact title.
        if (authors.length && !authorOk) continue;
        if (!authors.length && jac < 0.98) continue;
      }

      const venueId = _orValue(content.venueid) || _orValue(content.venue_id);
      const venueText = _orValue(content.venue);
      const meta = openReviewVenueMeta(venueId, venueText, note.pdate);
      if (!meta) continue;

      const forumId = note.forum || note.id;
      const doi = _firstString(content.doi) || _firstString(content.DOI);
      const score = jac + (authorOk && authorNeedle ? 0.1 : 0);
      if (score <= bestScore) continue;

      bestScore = score;
      best = {
        source: "openreview",
        title: foundTitle, authors, title_score: jac,
        venue_raw: meta.row.canonical,
        year: meta.year,
        venue_type: meta.kind,
        citation_count: null,
        influential_citations: null,
        external_doi: doi,
        dblp_key: null,
        evidence_url: forumId
          ? "https://openreview.net/forum?id=" + encodeURIComponent(forumId)
          : "https://openreview.net",
        issn: null,
        abbrev: meta.row.canonical,
      };
    }
    return best;
  }

  async function bestByTitle(title, authorLastname = "", identifiers = {}) {
    if (!String(title || "").trim()) return null;

    // Title-first: most public submissions do not contain their arXiv id. Do not
    // spend two requests on equivalent id strings before trying the indexed title.
    const pick = (notes) => bestFromNotes(notes, title, authorLastname, identifiers.data);
    let hit = pick(await searchTitle(title, true));
    if (hit) return hit;
    hit = pick(await searchTitle(title, false));
    if (hit) return hit;
    for (const term of [identifiers.arxivId, identifiers.doi && _stripDoiUrl(identifiers.doi)].filter(Boolean)) {
      if (request.isStopped && request.isStopped()) break;
      hit = pick(await searchNotes(term, "terms", "all"));
      if (hit) return hit;
    }
    return null;
  }

  return { bestByTitle, searchTitle, searchNotes };
}

// ========================================================== official web / search =====
// Structured scholarly indexes can lag behind conference acceptance announcements.
// These helpers add two conservative fallbacks:
//   1. official conference websites (USENIX has accepted-paper/program pages before DBLP),
//   2. exact-title web search (optional Brave API + no-key DuckDuckGo HTML/Lite), followed
//      by local verification of the destination page's title, first author, venue, and
//      acceptance/publication wording. Search snippets alone are accepted only under a
//      stricter threshold and never override a contradictory authoritative source.

const _WEB_ACCEPT_RE = /(?:\b(?:accepted(?:\s+(?:at|to|by|for))?|to\s+appear|forthcoming|published(?:\s+(?:at|in))?|presented(?:\s+at)?|conference\s+paper|technical\s+sessions?|accepted\s+papers?|prepublication|proceedings)\b|(?:被|已被|获得|获)\s*[^。；;]{0,80}(?:录用|接收)|(?:录用|接收)(?:于|至|到|为)?|正式发表(?:于)?|发表于|入选(?:了)?)/i;
const _WEB_NEGATIVE_RE = /(?:\b(?:submitted(?:\s+to)?|under\s+review|rejected|withdrawn|call\s+for\s+papers?|cfp|workshop|findings|tutorial|demo|companion|short\s+paper|poster\s+abstract)\b|投稿(?:至|于)?|审稿中|评审中|拒稿|撤稿|征稿|研讨会|工作坊|短文|海报|演示论文)/i;
const _WEB_SKIP_HOSTS = new Set([
  "arxiv.org", "export.arxiv.org", "semanticscholar.org", "www.semanticscholar.org",
  "dblp.org", "www.dblp.org", "api.crossref.org", "api.datacite.org",
  "openalex.org", "api.openalex.org", "opencitations.net", "api.opencitations.net",
]);
const _OFFICIAL_PUBLISHER_HOSTS = [
  "proceedings.mlr.press", "proceedings.ijcai.org", "www.ijcai.org", "drops.dagstuhl.de",
  "usenix.org", "ndss-symposium.org", "openaccess.thecvf.com", "cv-foundation.org",
  "aclanthology.org", "aclweb.org", "proceedings.mlr.press", "jmlr.org",
  "proceedings.neurips.cc", "dl.acm.org", "acm.org", "ieeexplore.ieee.org",
  "computer.org", "ieee.org", "link.springer.com", "drops.dagstuhl.de", "dagstuhl.de",
  "ojs.aaai.org", "proceedings.aaai.org", "aaai.org", "openreview.net",
  "iacr.org", "eprint.iacr.org", "ieee-security.org", "sigsac.org",
];

function _safeCodePoint(value, radix) {
  const n = parseInt(value, radix);
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "";
  try { return String.fromCodePoint(n); } catch (e) { return ""; }
}

function _decodeHtml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => _safeCodePoint(hex, 16))
    .replace(/&#(\d+);/g, (_m, dec) => _safeCodePoint(dec, 10))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function _htmlToText(html) {
  return _decodeHtml(String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function _htmlAttr(attrs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = String(attrs || "").match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  if (quoted) return _decodeHtml(quoted[2]).trim();
  const bare = String(attrs || "").match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*([^\\s>]+)`, "i"));
  return bare ? _decodeHtml(bare[1]).trim() : "";
}

function _htmlMetaValues(html, names) {
  const wanted = new Set((names || []).map((name) => String(name).toLowerCase()));
  const out = [];
  const re = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const attrs = m[1];
    const key = (_htmlAttr(attrs, "name") || _htmlAttr(attrs, "property") || _htmlAttr(attrs, "itemprop")).toLowerCase();
    if (!wanted.has(key)) continue;
    const value = _htmlAttr(attrs, "content");
    if (value) out.push(value);
  }
  return out;
}

function _htmlHeadingValues(html) {
  const out = [];
  const re = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < 20) {
    const value = _htmlToText(m[1]);
    if (value) out.push(value);
  }
  const title = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) out.push(_htmlToText(title[1]));
  return out;
}

function _absoluteUrl(base, href) {
  href = _decodeHtml(String(href || "").trim());
  if (!href || /^javascript:|^mailto:|^#/i.test(href)) return null;
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

function _htmlAnchors(html, baseUrl) {
  const out = [];
  const re = /<a\b([^>]*\bhref\s*=\s*(?:["'][\s\S]*?["']|[^\s>]+)[^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < 5000) {
    const href = _htmlAttr(m[1], "href");
    const url = _absoluteUrl(baseUrl, href);
    const text = _htmlToText(m[2]);
    if (url) out.push({ url, text });
  }
  return out;
}

function _hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function _isOfficialPublisherUrl(url) {
  const host = _hostOf(url);
  return _OFFICIAL_PUBLISHER_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
}

function _paperContext(text, title, radius = 2400) {
  text = String(text || "");
  const lower = text.toLowerCase();
  const needle = String(title || "").toLowerCase().trim();
  let index = needle ? lower.indexOf(needle) : -1;
  if (index < 0 && needle) {
    const prefix = needle.slice(0, Math.min(42, needle.length));
    index = lower.indexOf(prefix);
  }
  if (index < 0) return text.slice(0, radius * 2);
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + needle.length + radius));
}

function _bestPageTitleScore(html, title, resultTitle = "") {
  const candidates = [
    resultTitle,
    ..._htmlMetaValues(html, ["citation_title", "dc.title", "dcterms.title", "og:title", "twitter:title"]),
    ..._htmlHeadingValues(html),
  ].filter(Boolean);
  let best = 0;
  for (const candidate of candidates) best = Math.max(best, titleSimilarity(title, candidate));
  return best;
}

function _pageAuthors(html) {
  return _htmlMetaValues(html, ["citation_author", "dc.creator", "dcterms.creator", "author"]);
}

function _findCcfVenueInText(text, kindHint = "conference") {
  if (!ZMCCFResolver || !Array.isArray(ZMCCFResolver.data)) return null;
  const raw = String(text || "");
  const norm = ZMCCFResolver.norm ? ZMCCFResolver.norm(raw) : normTitle(raw);
  if (!norm) return null;
  const rawTokens = raw.match(/[A-Za-z0-9&+.-]+/g) || [];
  const exactUpper = new Set(rawTokens.filter((t) => t === t.toUpperCase()).map((t) => t.replace(/[^A-Za-z0-9]/g, "")));
  const exactTokens = new Set(rawTokens.map((t) => t.replace(/[^A-Za-z0-9]/g, "").toLowerCase()).filter(Boolean));
  const matches = [];
  for (const row of ZMCCFResolver.data) {
    if (kindHint && row.kind !== kindHint) continue;
    const aliases = [row.full_name, row.canonical, ...(row.aliases || [])].filter(Boolean);
    let best = 0;
    for (const alias of aliases) {
      const aliasNorm = ZMCCFResolver.norm ? ZMCCFResolver.norm(alias) : normTitle(alias);
      if (!aliasNorm) continue;
      const tokens = aliasNorm.split(" ");
      const compact = String(alias).replace(/[^A-Za-z0-9]/g, "");
      const phrasePresent = (` ${norm} `).includes(` ${aliasNorm} `);
      const distinctiveTwoToken = tokens.length === 2 && aliasNorm.length >= 10 && /[A-Z]{3,}/.test(String(alias));
      if (phrasePresent && ((tokens.length >= 3 && aliasNorm.length >= 12) || distinctiveTwoToken)) {
        best = Math.max(best, alias === row.full_name ? 12 : alias === row.canonical ? 11 : 9);
      } else if (compact.length >= 4 && compact.length <= 24 && exactUpper.has(compact.toUpperCase())) {
        best = Math.max(best, alias === row.canonical ? 8 : 6);
      } else {
        // Mixed-case brands such as NeurIPS, EuroSys, CoNEXT, RecSys, and MobileHCI
        // are not all-uppercase acronyms. Accept an exact token only when its casing shape
        // is distinctive; ordinary words such as Performance or Networking remain ignored.
        const mixedBrand = /[A-Z].*[A-Z]/.test(String(alias)) && /[a-z]/.test(String(alias));
        if (mixedBrand && compact.length >= 5 && exactTokens.has(compact.toLowerCase())) {
          best = Math.max(best, alias === row.canonical ? 8 : 6);
        }
      }
    }
    if (best) matches.push({ score: best, row });
  }
  matches.sort((a, b) => b.score - a.score || String(a.row.canonical).localeCompare(String(b.row.canonical)));
  if (!matches.length) return null;
  const top = matches[0];
  const tied = matches.filter((m) => m.score === top.score);
  const keys = new Set(tied.map((m) => `${m.row.kind}|${m.row.canonical}|${m.row.tier}`));
  if (keys.size > 1) return null;
  return {
    canonical: top.row.canonical,
    kind: top.row.kind || "conference",
    core: "",
    aliases: [],
    write_as: top.row.full_name || "",
    full_name: top.row.full_name || "",
    publisher: top.row.publisher || "",
    url: top.row.url || "",
    dblp_slug: top.row.dblp_slug || "",
    ccf_tier: top.row.tier || "",
    ccf_domain: top.row.domain || "",
    ccf_match: {
      ambiguous: false,
      canonical: top.row.canonical,
      full_name: top.row.full_name || "",
      publisher: top.row.publisher || "",
      url: top.row.url || "",
      dblp_slug: top.row.dblp_slug || "",
      tier: top.row.tier || "",
      domain: top.row.domain || "",
      kind: top.row.kind || "conference",
      entries: [top.row],
    },
  };
}

function _officialVenueFromUrl(url) {
  const value = String(url || "");
  let m = value.match(/usenix\.org\/conference\/usenixsecurity(\d{2,4})(?:\/|$)/i);
  if (m) return { venue: "USENIX Security", year: _twoOrFourDigitYear(m[1]) };
  m = value.match(/usenix\.org\/conference\/(nsdi|osdi|fast|soups|lisa|hotstorage|hotsec)(\d{2,4})(?:\/|$)/i);
  if (m) return { venue: m[1], year: _twoOrFourDigitYear(m[2]) };
  m = value.match(/usenix\.org\/conference\/(?:usenix)?atc(\d{2,4})(?:\/|$)/i);
  if (m) return { venue: "USENIX ATC", year: _twoOrFourDigitYear(m[1]) };
  m = value.match(/openaccess\.thecvf\.com\/(CVPR|ICCV|WACV)(\d{4})/i);
  if (m) return { venue: m[1].toUpperCase(), year: parseInt(m[2], 10) };
  m = value.match(/proceedings\.neurips\.cc\/(?:paper_files\/paper\/)?((?:19|20)\d{2})(?:\/|$)/i);
  if (m) return { venue: "NeurIPS", year: parseInt(m[1], 10) };
  m = value.match(/aclanthology\.org\/((?:19|20)\d{2})\.(acl|emnlp|naacl|coling|conll)(?:[-./]|$)/i);
  if (m) {
    const venue = { acl: "ACL", emnlp: "EMNLP", naacl: "NAACL", coling: "COLING", conll: "CoNLL" }[m[2].toLowerCase()];
    return { venue, year: parseInt(m[1], 10) };
  }
  if (/ndss-symposium\.org/i.test(value)) {
    m = value.match(/(?:ndss|symposium)[^0-9]{0,8}((?:19|20)\d{2})/i);
    return { venue: "NDSS", year: m ? parseInt(m[1], 10) : null };
  }
  return null;
}

function _twoOrFourDigitYear(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  if (n >= 1900) return n;
  return n >= 70 ? 1900 + n : 2000 + n;
}

function _pageVenueCandidates(html) {
  return [
    ..._htmlMetaValues(html, [
      "citation_conference_title", "citation_journal_title", "citation_book_title",
      "dc.source", "dcterms.ispartof", "prism.publicationname",
    ]),
    ..._htmlMetaValues(html, ["og:description", "twitter:description", "description"]),
  ].filter(Boolean);
}

function _pageYear(html, url, context, yearHint) {
  const dateValues = _htmlMetaValues(html, [
    "citation_publication_date", "citation_date", "dc.date", "dcterms.date",
    "article:published_time", "date",
  ]);
  for (const value of [...dateValues, url || "", context || ""]) {
    const year = _yearFromText(value);
    if (year && (!yearHint || Math.abs(year - yearHint) <= 3)) return year;
  }
  return yearHint || null;
}

function _pageToVenueHit({ url, html, title, authorLastname = "", resultTitle = "", snippet = "", source = "official_web", knownVenue = null, yearHint = null, official = false }) {
  html = String(html || "");
  if (!html) return null;
  const primaryTitles = _htmlMetaValues(html, ["citation_title", "dc.title", "dcterms.title"]);
  if (primaryTitles.length && !primaryTitles.some((t) => titleSimilarity(title, t) >= 0.90)) return null;
  const text = _htmlToText(html);
  const context = _paperContext(text, title);
  const titleScore = _bestPageTitleScore(html, title, "");
  const contextScore = titleSimilarity(title, context);
  // Institutional announcements often place the exact English paper title inside a
  // paragraph under a local-language headline rather than in citation meta tags. Treat an
  // exact normalized substring as exact title evidence.
  const exactTitleInText = !!normTitle(title) && normTitle(text).includes(normTitle(title));
  const bestTitleScore = exactTitleInText ? 1.0 : Math.max(titleScore, contextScore);
  if (bestTitleScore < 0.88) return null;

  const metaAuthors = _pageAuthors(html);
  const authorOk = !authorLastname || _authorMatches(authorLastname, metaAuthors) || _normalizePerson(context).includes(_normalizePerson(authorLastname));
  if (authorLastname && !authorOk && bestTitleScore < 0.98) return null;

  const urlVenue = _officialVenueFromUrl(url);
  const venueCandidates = [
    knownVenue,
    urlVenue && urlVenue.venue,
    ..._pageVenueCandidates(html),
  ].filter(Boolean);
  let row = null;
  let rawVenue = null;
  for (const candidate of venueCandidates) {
    const candidateRow = lookupRanking(candidate);
    if (!candidateRow) continue;
    row = candidateRow;
    rawVenue = candidate;
    if (candidateRow.ccf_tier) break;
  }
  if (!row) {
    row = _findCcfVenueInText(`${resultTitle} ${snippet} ${context}`, "conference");
    rawVenue = row && row.canonical;
  }
  if (!row) return null;

  // Status terms are evaluated in a tighter window than venue/title extraction so a site's
  // global navigation link to “Workshops” does not taint an otherwise valid paper page.
  const statusContext = _paperContext(text, title, 900);
  const proofText = `${resultTitle} ${snippet} ${statusContext}`;
  const pageLooksFormal = official || _isOfficialPublisherUrl(url) || /\/presentation\/|accepted-papers|technical-sessions|proceedings/i.test(url);
  const structuredStatus = _htmlMetaValues(html, ["citation_conference_title", "citation_journal_title", "citation_section"]).join(" ");
  if (_WEB_NEGATIVE_RE.test(primaryTitles.length && pageLooksFormal ? structuredStatus : proofText)) return null;
  if (!pageLooksFormal && !_WEB_ACCEPT_RE.test(proofText)) return null;

  const doi = _firstString(_htmlMetaValues(html, ["citation_doi", "dc.identifier", "dcterms.identifier"])) || null;
  const year = (urlVenue && urlVenue.year) || _pageYear(html, url, context, yearHint);
  return {
    source,
    title,
    authors: metaAuthors,
    title_score: bestTitleScore,
    venue_raw: rawVenue || row.canonical,
    venue_candidates: venueCandidates,
    year,
    venue_type: row.kind,
    citation_count: null,
    influential_citations: null,
    external_doi: doi && !isArxivDoi(doi) ? _stripDoiUrl(doi) : null,
    dblp_key: null,
    evidence_url: url,
    issn: _firstString(_htmlMetaValues(html, ["citation_issn"])) || null,
    abbrev: row.canonical,
    publisher: row.publisher || null,
  };
}

async function _getTextWithRetry(request, url, sleep, cache, tries = 3) {
    tries = request.managed ? 1 : tries;
  if (cache && cache.has(url)) return cache.get(url);
  let delay = 800;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await request("GET", url, {
        responseType: "text",
        timeout: 12000,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      const transient = res.status === 0 || res.status === 408 || res.status === 425 || res.status === 429 || (res.status >= 500 && res.status < 600);
      if (transient) {
        if (i < tries - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 8000);
          continue;
        }
        return "";
      }
      if (res.status < 200 || res.status >= 300) return "";
      const text = typeof res.data === "string" ? res.data : (res.text || "");
      if (cache) cache.set(url, text);
      return text;
    } catch (e) {
      if (i < tries - 1) {
        await sleep(delay);
        delay = Math.min(delay * 2, 8000);
      }
    }
  }
  return "";
}

const _USENIX_EVENTS = [
  { canonical: "USENIX Security", slugs: ["usenixsecurity"], pages: ["cycle1-accepted-papers", "cycle2-accepted-papers", "cycle3-accepted-papers", "accepted-papers", "technical-sessions"] },
  { canonical: "NSDI", slugs: ["nsdi"], pages: ["accepted-papers", "technical-sessions"] },
  { canonical: "OSDI", slugs: ["osdi"], pages: ["accepted-papers", "technical-sessions"] },
  { canonical: "FAST", slugs: ["fast"], pages: ["accepted-papers", "technical-sessions"] },
  { canonical: "USENIX ATC", slugs: ["atc", "usenixatc"], pages: ["accepted-papers", "technical-sessions"] },
  { canonical: "SOUPS", slugs: ["soups"], pages: ["accepted-papers", "technical-sessions"] },
  { canonical: "LISA", slugs: ["lisa"], pages: ["accepted-papers", "technical-sessions"] },
  { canonical: "HotStorage", slugs: ["hotstorage"], pages: ["accepted-papers", "technical-sessions"] },
  { canonical: "HotSec", slugs: ["hotsec"], pages: ["accepted-papers", "technical-sessions"] },
];

function _usenixEventFromUrl(url) {
  const inferred = _officialVenueFromUrl(url);
  if (!inferred) return null;
  const row = lookupRanking(inferred.venue, "conference");
  return row ? { row, year: inferred.year } : null;
}

function _pageContainsPaper(html, title, authorLastname) {
  const text = _htmlToText(html);
  const context = _paperContext(text, title, 1800);
  const titleOk = titleSimilarity(title, context) >= 0.93 || normTitle(text).includes(normTitle(title));
  if (!titleOk) return false;
  if (!authorLastname) return true;
  return _normalizePerson(context).includes(_normalizePerson(authorLastname));
}

function makeUSENIX(request, sleep) {
  sleep = sleep || _defaultSleep;
  const cache = new Map();

  async function verifyCandidate(url, title, authorLastname, resultTitle = "") {
    const event = _usenixEventFromUrl(url);
    if (!event) return null;
    const html = await _getTextWithRetry(request, url, sleep, cache);
    if (!html || !_pageContainsPaper(html, title, authorLastname)) return null;
    return _pageToVenueHit({
      url, html, title, authorLastname, resultTitle,
      source: "usenix_official", knownVenue: event.row.canonical,
      yearHint: event.year, official: true,
    });
  }

  async function searchSite(title, authorLastname) {
    const encoded = encodeURIComponent(title);
    const searchUrls = [
      `https://www.usenix.org/search/node/${encoded}`,
      `https://www.usenix.org/search?search_api_fulltext=${encoded}`,
    ];
    for (const searchUrl of searchUrls) {
      const html = await _getTextWithRetry(request, searchUrl, sleep, cache);
      if (!html) continue;
      const candidates = _htmlAnchors(html, searchUrl)
        .filter((a) => /usenix\.org\/conference\//i.test(a.url))
        .map((a) => ({ ...a, score: titleSimilarity(title, a.text) }))
        .filter((a) => a.score >= 0.72)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
      for (const candidate of candidates) {
        const hit = await verifyCandidate(candidate.url, title, authorLastname, candidate.text);
        if (hit) return hit;
      }
    }
    return null;
  }

  async function scanProgramPages(title, authorLastname, yearHint, scanOptions = {}) {
    const currentYear = new Date().getUTCFullYear();
    const base = yearHint || currentYear;
    const years = [...new Set([base, base + 1, base - 1].filter((y) => y >= 2000 && y <= currentYear + 3))];
    // Search the most likely year across every USENIX venue before adjacent years. This
    // keeps common cases fast while allowing SOUPS/LISA/workshop-style USENIX venues to be
    // reached instead of spending the whole budget on Security's neighbouring years.
    let budget = scanOptions.maxPages || 12;
    for (const year of years) {
      const yy = String(year).slice(-2);
      for (const event of _USENIX_EVENTS.filter((e) => !scanOptions.venue || e.canonical === scanOptions.venue)) {
        const row = lookupRanking(event.canonical, "conference");
        if (!row) continue;
        for (const slug of event.slugs) {
          for (const page of event.pages) {
            if (budget-- <= 0) return null;
            const url = `https://www.usenix.org/conference/${slug}${yy}/${page}`;
            const html = await _getTextWithRetry(request, url, sleep, cache, 1);
            if (!html || !_pageContainsPaper(html, title, authorLastname)) continue;
            const matchingLink = _htmlAnchors(html, url)
              .map((a) => ({ ...a, score: titleSimilarity(title, a.text) }))
              .filter((a) => a.score >= 0.90)
              .sort((a, b) => b.score - a.score)[0];
            if (matchingLink && /usenix\.org\/conference\//i.test(matchingLink.url)) {
              const direct = await verifyCandidate(matchingLink.url, title, authorLastname, matchingLink.text);
              if (direct) return direct;
            }
            return _pageToVenueHit({
              url, html, title, authorLastname, source: "usenix_official",
              knownVenue: row.canonical, yearHint: year, official: true,
            });
          }
        }
      }
    }
    return null;
  }

  async function bestByTitle(title, authorLastname = "", yearHint = null) {
    if (!String(title || "").trim()) return null;
    return await searchSite(title, authorLastname) || await scanProgramPages(title, authorLastname, yearHint);
  }

  return { bestByTitle, searchSite, scanProgramPages };
}

function _decodeDuckDuckGoUrl(url) {
  try {
    const absolute = url.startsWith("//") ? "https:" + url : url;
    const parsed = new URL(absolute);
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.searchParams.get("uddg")) {
      return decodeURIComponent(parsed.searchParams.get("uddg"));
    }
    return absolute;
  } catch (e) {
    return url;
  }
}

function _parseDuckDuckGoResults(html, baseUrl) {
  const out = [];
  for (const anchor of _htmlAnchors(html, baseUrl)) {
    const url = _decodeDuckDuckGoUrl(anchor.url);
    const host = _hostOf(url);
    if (!host || host.endsWith("duckduckgo.com") || _WEB_SKIP_HOSTS.has(host)) continue;
    if (!/^https?:/i.test(url)) continue;
    out.push({ url, title: anchor.text, snippet: "", provider: "duckduckgo" });
  }
  const seen = new Set();
  return out.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).slice(0, 30);
}

function _parseBraveResults(data) {
  const results = data && data.web && data.web.results || [];
  return results.map((r) => ({
    url: r.url,
    title: r.title || "",
    snippet: [r.description, ...(r.extra_snippets || [])].filter(Boolean).join(" "),
    provider: "brave",
  })).filter((r) => r.url);
}

function makeWebSearch(request, options = {}, sleep) {
  sleep = sleep || _defaultSleep;
  const cache = new Map();
  const braveApiKey = String(options.braveApiKey || "").trim();
  const enableDuckDuckGo = options.enableDuckDuckGo !== false;

  async function braveSearch(query) {
    if (!braveApiKey) return [];
    const url = "https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query) + "&count=20&search_lang=en&safesearch=moderate";
    try {
      const res = await request("GET", url, {
        headers: { Accept: "application/json", "X-Subscription-Token": braveApiKey },
      });
      if (res.status < 200 || res.status >= 300) return [];
      return _parseBraveResults(res.data);
    } catch (e) {
      return [];
    }
  }

  async function duckDuckGoSearch(query) {
    if (!enableDuckDuckGo) return [];
    const urls = [
      "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
      "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query),
    ];
    for (const url of urls) {
      const html = await _getTextWithRetry(request, url, sleep, cache, 2);
      if (!html) continue;
      const results = _parseDuckDuckGoResults(html, url);
      if (results.length) return results;
    }
    return [];
  }

  function resultPlausibility(result, title, authorLastname) {
    const combined = `${result.title || ""} ${result.snippet || ""}`;
    const score = Math.max(titleSimilarity(title, result.title || ""), titleSimilarity(title, combined));
    const authorOk = !authorLastname || _normalizePerson(combined).includes(_normalizePerson(authorLastname));
    const official = _isOfficialPublisherUrl(result.url);
    let total = score * 10 + (official ? 6 : 0) + (authorOk && authorLastname ? 1 : 0);
    if (_WEB_ACCEPT_RE.test(combined)) total += 2;
    return { score, total, official };
  }

  async function resultToHit(result, title, authorLastname, yearHint, queryData) {
    const plausibility = resultPlausibility(result, title, authorLastname);
    if (plausibility.score < 0.65 && !plausibility.official) return null;
    const html = await _getTextWithRetry(request, result.url, sleep, cache, 2);
    if (html) {
      let hit;
      if (plausibility.official) {
        const discoveryModule = typeof ZMDiscovery !== "undefined" ? ZMDiscovery : require("./discovery.js");
        hit = discoveryModule.create(ZMResolver, request).officialPage(result.url, html, queryData || {
          title, date: yearHint ? String(yearHint) : "", creators: authorLastname ? [{ creatorType: "author", lastName: authorLastname }] : [],
        });
      } else {
        hit = _pageToVenueHit({
          url: result.url, html, title, authorLastname,
          resultTitle: result.title, snippet: result.snippet,
          source: `${result.provider}_web`, yearHint, official: false,
        });
      }
      if (hit) return hit;
    }

    // Last-resort snippet evidence. Require near-exact title, author (when available),
    // explicit acceptance language, and an unambiguous CCF venue. This source receives a
    // lower weight than official pages and remains visible for manual review.
    const combined = `${result.title || ""} ${result.snippet || ""}`;
    const score = titleSimilarity(title, combined);
    if (score < 0.94 || !_WEB_ACCEPT_RE.test(combined) || _WEB_NEGATIVE_RE.test(combined)) return null;
    if (authorLastname && !_normalizePerson(combined).includes(_normalizePerson(authorLastname))) return null;
    const row = _findCcfVenueInText(combined, "conference");
    if (!row) return null;
    return {
      source: `${result.provider}_snippet`, title, authors: [], title_score: score,
      venue_raw: row.canonical, venue_candidates: [row.canonical],
      year: _yearFromText(combined) || yearHint || null, venue_type: row.kind,
      citation_count: null, influential_citations: null, external_doi: null, dblp_key: null,
      evidence_url: result.url, issn: null, abbrev: row.canonical, publisher: row.publisher || null,
    };
  }

  async function bestByTitle(title, authorLastname = "", yearHint = null, identifiers = {}) {
    if (!String(title || "").trim()) return null;
    const normalized = normTitle(title);
    const head = String(title).split(/[:：]/)[0].trim();
    const queries = [...new Set([
      `"${title}"`,
      normTitle(head).split(" ").length >= 3 ? `"${head}"` : normalized,
      normalized,
      identifiers.arxivId ? `"${identifiers.arxivId}" proceedings` : "",
    ].filter(Boolean))].slice(0, options.maxQueries || 3);
    const all = [];
    for (const query of queries) {
      // Brave and DuckDuckGo have independent indexes. Query both when enabled instead of
      // treating DuckDuckGo only as an error fallback; early acceptance pages are often
      // present in one index but absent from the other.
      const [brave, ddg] = await Promise.all([braveSearch(query), duckDuckGoSearch(query)]);
      all.push(...brave, ...ddg);
      if (all.some((r) => _isOfficialPublisherUrl(r.url))) break;
    }
    const seen = new Set();
    const ranked = all.filter((r) => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).map((r) => ({ r, ...resultPlausibility(r, title, authorLastname) }))
      .filter((x) => x.score >= 0.55 || x.official)
      .sort((a, b) => b.total - a.total)
      .slice(0, options.maxPages || 6);

    const hits = [];
    let cursor = 0, foundOfficial = null;
    await new Promise((resolvePages) => {
      let workers = Math.min(2, ranked.length);
      if (!workers) { resolvePages(); return; }
      async function worker() {
        try {
          while (!foundOfficial && cursor < ranked.length && !(request.isStopped && request.isStopped())) {
            const entry = ranked[cursor++];
            const hit = await resultToHit(entry.r, title, authorLastname, yearHint, identifiers.data);
            if (foundOfficial) break;
            if (hit) hits.push(hit);
            if (hit && ["official_web", "usenix_official"].includes(hit.source)) {
              foundOfficial = hit; resolvePages(); break;
            }
          }
        } finally { if (--workers === 0) resolvePages(); }
      }
      const count = workers;
      for (let i = 0; i < count; i++) worker().catch(() => {});
    });
    if (foundOfficial) return foundOfficial;
    if (!hits.length) return null;
    hits.sort((a, b) => {
      const ar = _hitRow(a); const br = _hitRow(b);
      return _individualHitScore(b, br) - _individualHitScore(a, ar);
    });
    return hits[0];
  }

  return { bestByTitle, braveSearch, duckDuckGoSearch };
}

function makeDBLP(request) {
  const cache = new Map();

  async function search(query) {
    query = String(query || "").trim();
    if (!query) return [];
    if (cache.has(query)) return cache.get(query);
    const url = "https://dblp.org/search/publ/api?q=" + encodeURIComponent(query) + "&format=json&h=30";
    try {
      const res = await request("GET", url, { headers: { Accept: "application/json" } });
      if (res.status < 200 || res.status >= 300) return [];
      const hits = (((res.data || {}).result || {}).hits || {}).hit || [];
      cache.set(query, hits);
      return hits;
    } catch (e) {
      return [];
    }
  }

  function scoreRecord(info, title, authorLastname, yearHint) {
    const foundTitle = String(info.title || "");
    const jac = titleSimilarity(title, foundTitle);
    const authors = _authorsOf(info);
    const authorOk = _authorMatches(authorLastname, authors);
    const yearText = String(info.year ?? "");
    const year = /^\d+$/.test(yearText) ? parseInt(yearText, 10) : null;
    const yearClose = !!(yearHint && year && Math.abs(year - yearHint) <= 1);
    if (!(jac >= 0.82 || (jac >= 0.60 && authorOk && yearClose))) return null;
    if (authorLastname && authors.length && !authorOk && jac < 0.96) return null;
    if (yearHint && year && Math.abs(year - yearHint) > 5 && jac < 0.96) return null;

    let venue = info.venue;
    if (Array.isArray(venue)) venue = venue.length ? venue[0] : null;
    const type = String(info.type || "");
    let kind = /conference|workshop/i.test(type) ? "conference" : /journal/i.test(type) ? "journal" : null;
    let row = !isNonvenue(venue) ? lookupRanking(venue, kind) : null;
    if (isNonvenue(venue) && ZMCCFResolver && ZMCCFResolver.lookupDblp) {
      const slugMatch = ZMCCFResolver.lookupDblp(info.key || info.url);
      if (slugMatch && !slugMatch.ambiguous) {
        row = _ccfToRanking(slugMatch);
        venue = row.canonical;
        kind = row.kind;
      }
    }
    if (isNonvenue(venue)) return null;
    let score = jac * 10;
    if (authorLastname && authorOk) score += 2;
    if (yearClose) score += 1;
    if (row && row.ccf_tier) score += 10;
    else if (row) score += 3;
    if (kind === "conference") score += 1;
    return { score, venue, year, kind: row ? row.kind : kind, row, info, title: foundTitle, authors, jac };
  }

  async function bestByTitle(title, authorLastname = "", yearHint = null, identifiers = {}) {
    const head = title.split(/[:：]/)[0];
    const queries = [...new Set([
      normTitle(title),
      normTitle(head).split(" ").length >= 3 ? normTitle(head) : "",
      identifiers.doi || "",
      identifiers.arxivId || "",
    ].filter(Boolean))];

    const seenRecords = new Map();
    for (const query of queries) {
      for (const hit of await search(query)) {
        const info = hit && hit.info || {};
        const key = String(info.key || info.url || `${info.title}|${info.year}|${info.venue}`);
        if (!seenRecords.has(key)) seenRecords.set(key, info);
      }
      const reliable = [...seenRecords.values()].some((info) => {
        const candidate = scoreRecord(info, title, authorLastname, yearHint);
        return candidate && candidate.row && candidate.kind === "conference" && candidate.jac >= 0.94;
      });
      if (reliable) break;
      // An identifier lookup is highly selective, but still let title matching verify it.
      if (seenRecords.size >= 30) break;
    }

    const candidates = [];
    for (const info of seenRecords.values()) {
      const scored = scoreRecord(info, title, authorLastname, yearHint);
      if (scored) candidates.push(scored);
    }
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) return null;
    const best = candidates[0];
    return {
      source: "dblp",
      title: best.title,
      authors: best.authors,
      title_score: best.jac,
      venue_raw: best.venue,
      year: best.year,
      venue_type: best.kind,
      external_doi: best.info.doi ?? null,
      evidence_url: best.info.url ?? null,
      citation_count: null,
      influential_citations: null,
      issn: null,
      abbrev: best.row ? best.row.canonical : best.venue,
      publisher: best.info.publisher ?? null,
      dblp_key: best.info.key ?? null,
    };
  }

  return { bestByTitle, search };
}

// ==================================================================== Crossref =========
const _CROSSREF_WORKS = "https://api.crossref.org/works";

function _firstArrayValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = String(item || "").trim();
      if (s) return s;
    }
    return "";
  }
  return String(value || "").trim();
}

function _crossrefYear(message) {
  for (const key of ["published-print", "published-online", "published", "issued", "created"]) {
    const parts = message && message[key] && message[key]["date-parts"];
    const y = parts && parts[0] && Number(parts[0][0]);
    if (Number.isFinite(y) && y > 1800 && y < 2200) return y;
  }
  return null;
}

function _crossrefDate(message) {
  for (const key of ["published-print", "published-online", "published", "issued"]) {
    const parts = message && message[key] && message[key]["date-parts"];
    const p = parts && parts[0];
    if (p && p.length >= 3 && p[1] >= 1 && p[1] <= 12 && p[2] >= 1 && p[2] <= 31) {
      return `${p[0]}-${String(p[1]).padStart(2, "0")}-${String(p[2]).padStart(2, "0")}`;
    }
  }
  return null;
}

function _crossrefVenueCandidates(message) {
  const out = [];
  const eventName = message && message.event && message.event.name;
  if (eventName) out.push(eventName);
  for (const key of ["short-container-title", "container-title"]) {
    const values = message && message[key];
    if (Array.isArray(values)) out.push(...values);
    else if (values) out.push(values);
  }
  return [...new Set(out.map((v) => String(v || "").trim()).filter(Boolean))];
}

function _crossrefAuthors(message) {
  return (message && message.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" "));
}

function _stripDoiUrl(value) {
  return String(value || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim() || null;
}

// Encode a DOI for use in a URL path without destroying the mandatory slash between
// registrant prefix and suffix. Several metadata APIs document DOI paths in this form.
function _doiPath(value) {
  const doi = _stripDoiUrl(value);
  if (!doi) return "";
  return doi.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function _crossrefMessageToHit(message, source, queryTitle = "", authorLastname = "", yearHint = null) {
  if (!message) return null;
  const title = _firstArrayValue(message.title);
  const jac = queryTitle ? titleSimilarity(queryTitle, title) : 1;
  if (queryTitle && jac < 0.80) return null;
  const authors = _crossrefAuthors(message);
  const authorOk = _authorMatches(authorLastname, authors);
  if (queryTitle && authorLastname && authors.length && !authorOk && jac < 0.96) return null;
  const year = _crossrefYear(message);
  if (queryTitle && yearHint && year && Math.abs(year - yearHint) > 5 && jac < 0.96) return null;

  const relatedDois = Object.entries(message.relation || {})
    .filter(([k]) => /^(?:is-preprint-of|is-version-of|is-identical-to)$/.test(k))
    .flatMap(([, values]) => (Array.isArray(values) ? values : []).filter((v) => v["id-type"] === "doi").map((v) => v.id));
  if (["posted-content", "preprint", "report"].includes(String(message.type || "").toLowerCase())) {
    return relatedDois.length ? { source, title, authors, title_score: jac, venue_raw: null,
      venue_type: null, year, external_doi: null, related_dois: relatedDois, evidence_url: message.URL || null } : null;
  }
  const venueCandidates = _crossrefVenueCandidates(message);
  let selectedVenue = venueCandidates[0] || "";
  let selectedRow = null;
  for (const venue of venueCandidates) {
    const genericRow = lookupRanking(venue);
    const isConferenceSeries = genericRow && genericRow.kind === "conference" &&
      (/\b(?:conference|symposium|proceedings|congress)\b/i.test(venue) || /^10\.1609\/aaai\./i.test(message.DOI || ""));
    const row = isConferenceSeries ? genericRow : lookupRanking(venue, message.type === "journal-article" ? "journal" : null);
    if (row) {
      selectedVenue = venue;
      selectedRow = row;
      if (row.ccf_tier) break;
    }
  }
  if (!selectedVenue || isNonvenue(selectedVenue)) return null;

  const kind = selectedRow
    ? selectedRow.kind
    : message.type === "journal-article" ? "journal"
      : message.type === "proceedings-article" || message.type === "book-chapter" ? "conference"
        : null;
  if (!kind && !selectedRow) return null;
  if (["posted-content", "preprint", "report"].includes(String(message.type || "").toLowerCase())) return null;

  return {
    source,
    title,
    authors,
    title_score: jac,
    venue_raw: selectedVenue,
    venue_candidates: venueCandidates,
    year,
    venue_type: kind,
    citation_count: message["is-referenced-by-count"] ?? null,
    influential_citations: null,
    external_doi: message.DOI || null,
    dblp_key: null,
    evidence_url: message.URL || (message.DOI ? "https://doi.org/" + message.DOI : null),
    issn: _firstArrayValue(message.ISSN) || null,
    abbrev: _firstArrayValue(message["short-container-title"]) || null,
    publisher: message.publisher || null,
    publication_date: _crossrefDate(message),
    volume: message.volume || null, issue: message.issue || null, pages: message.page || null,
    related_dois: relatedDois,
  };
}

function makeCrossref(request, sleep) {
  sleep = sleep || _defaultSleep;
  const cache = new Map();
  async function getWithRetry(url, tries = 4) {
    tries = request.managed ? 1 : tries;
    if (cache.has(url)) return cache.get(url);
    let delay = 1000;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await request("GET", url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "arxiv_marker_ccf2026/1.0.0",
          },
        });
        const transient = res.status === 0 || res.status === 408 || res.status === 425 ||
          res.status === 429 || (res.status >= 500 && res.status < 600);
        if (transient) {
          if (i < tries - 1) {
            await sleep(delay);
            delay = Math.min(delay * 2, 15000);
            continue;
          }
          return null;
        }
        if (res.status < 200 || res.status >= 300) return null;
        cache.set(url, res.data);
        return res.data;
      } catch (e) {
        if (i < tries - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 15000);
        }
      }
    }
    return null;
  }

  async function byDoi(doi) {
    doi = _stripDoiUrl(doi);
    if (!doi || isArxivDoi(doi)) return null;
    const data = await getWithRetry(_CROSSREF_WORKS + "/" + _doiPath(doi));
    const message = data && data.message;
    return _crossrefMessageToHit(message, "crossref_doi");
  }

  async function bestByTitle(title, authorLastname = "", yearHint = null, queryOverride = null) {
    if (!String(title || "").trim()) return null;
    const query = queryOverride || title; // verify against full title even for shorter discovery queries
    // Do not use Crossref's `select` here: supported selectable fields vary across
    // deployments, while the unfiltered response is small at rows=15 and reliably
    // includes event/container metadata.
    const url = _CROSSREF_WORKS + "?query.bibliographic=" + encodeURIComponent(query) +
      "&rows=15";
    const data = await getWithRetry(url);
    const items = data && data.message && data.message.items || [];
    const scored = [];
    for (const message of items) {
      const hit = _crossrefMessageToHit(message, "crossref_title", title, authorLastname, yearHint);
      if (!hit) continue;
      const row = lookupRanking(hit.venue_raw, hit.venue_type);
      let score = (hit.title_score || 0) * 10;
      if (row && row.ccf_tier) score += 8;
      else if (row) score += 3;
      if (authorLastname && _authorMatches(authorLastname, hit.authors)) score += 2;
      if (yearHint && hit.year && Math.abs(hit.year - yearHint) <= 1) score += 1;
      scored.push({ score, hit });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.length ? scored[0].hit : null;
  }

  return { byDoi, bestByTitle };
}

// ==================================================================== DataCite =========
const _DATACITE_DOIS = "https://api.datacite.org/dois";

function _dataciteTitle(attributes) {
  for (const entry of attributes && attributes.titles || []) {
    const value = entry && entry.title;
    if (value) return String(value);
  }
  return "";
}

function _dataciteAuthors(attributes) {
  return (attributes && attributes.creators || [])
    .map((creator) => creator && (creator.name || [creator.givenName, creator.familyName].filter(Boolean).join(" ")))
    .filter(Boolean);
}

function _dataciteVenueCandidates(attributes) {
  const out = [];
  const container = attributes && attributes.container || {};
  if (container.title) out.push(container.title);
  // Some repositories encode the proceedings title as a related item rather than in
  // `container`. Use it only as a candidate; the CCF lookup remains conservative.
  for (const item of attributes && attributes.relatedItems || []) {
    if (item && item.titles) {
      for (const title of item.titles) if (title && title.title) out.push(title.title);
    }
  }
  return [...new Set(out.map((value) => String(value || "").trim()).filter(Boolean))];
}

function _dataciteRecordToHit(record, source, queryTitle = "", authorLastname = "", yearHint = null) {
  const attributes = record && (record.attributes || record.data && record.data.attributes);
  if (!attributes) return null;
  const title = _dataciteTitle(attributes);
  const jac = queryTitle ? titleSimilarity(queryTitle, title) : 1;
  if (queryTitle && jac < 0.80) return null;
  const authors = _dataciteAuthors(attributes);
  const authorOk = _authorMatches(authorLastname, authors);
  if (queryTitle && authorLastname && authors.length && !authorOk && jac < 0.96) return null;
  const year = Number(attributes.publicationYear) || null;
  if (queryTitle && yearHint && year && Math.abs(year - yearHint) > 5 && jac < 0.96) return null;

  const venueCandidates = _dataciteVenueCandidates(attributes);
  const typeText = [
    attributes.types && attributes.types.resourceType,
    attributes.types && attributes.types.resourceTypeGeneral,
    attributes.container && attributes.container.type,
  ].filter(Boolean).join(" ");
  let kindHint = /journal/i.test(typeText) ? "journal" : /conference|proceedings/i.test(typeText) ? "conference" : null;
  let selectedVenue = venueCandidates[0] || "";
  let selectedRow = null;
  for (const candidate of venueCandidates) {
    const row = lookupRanking(candidate, kindHint);
    if (!row) continue;
    selectedVenue = candidate;
    selectedRow = row;
    if (row.ccf_tier) break;
  }
  if (!selectedVenue || isNonvenue(selectedVenue)) return null;
  const kind = selectedRow ? selectedRow.kind : kindHint;
  if (!kind) return null;

  const doi = attributes.doi || record.id || null;
  return {
    source,
    title,
    authors,
    title_score: jac,
    venue_raw: selectedVenue,
    venue_candidates: venueCandidates,
    year,
    venue_type: kind,
    citation_count: attributes.citationCount ?? null,
    influential_citations: null,
    external_doi: doi,
    dblp_key: null,
    evidence_url: attributes.url || (doi ? "https://doi.org/" + doi : null),
    issn: null,
    abbrev: selectedRow ? selectedRow.canonical : null,
    publisher: attributes.publisher || null,
  };
}

function makeDataCite(request, sleep) {
  sleep = sleep || _defaultSleep;
  const cache = new Map();

  async function getWithRetry(url, tries = 4) {
    tries = request.managed ? 1 : tries;
    if (cache.has(url)) return cache.get(url);
    let delay = 1000;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await request("GET", url, {
          headers: {
            Accept: "application/vnd.api+json, application/json",
            "User-Agent": "arxiv_marker_ccf2026/1.0.0",
          },
        });
        const transient = res.status === 0 || res.status === 408 || res.status === 425 ||
          res.status === 429 || (res.status >= 500 && res.status < 600);
        if (transient) {
          if (i < tries - 1) {
            await sleep(delay);
            delay = Math.min(delay * 2, 15000);
            continue;
          }
          return null;
        }
        if (res.status < 200 || res.status >= 300) return null;
        cache.set(url, res.data);
        return res.data;
      } catch (e) {
        if (i < tries - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 15000);
        }
      }
    }
    return null;
  }

  async function byDoi(doi) {
    doi = _stripDoiUrl(doi);
    if (!doi || isArxivDoi(doi)) return null;
    const data = await getWithRetry(_DATACITE_DOIS + "/" + _doiPath(doi));
    return _dataciteRecordToHit(data && data.data, "datacite_doi");
  }

  async function bestByTitle(title, authorLastname = "", yearHint = null) {
    if (!String(title || "").trim()) return null;
    const escapedTitle = String(title).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
    const query = `titles.title:"${escapedTitle}"`;
    const url = _DATACITE_DOIS + "?query=" + encodeURIComponent(query) + "&page[size]=15";
    const data = await getWithRetry(url);
    const scored = [];
    for (const record of data && data.data || []) {
      const hit = _dataciteRecordToHit(record, "datacite_title", title, authorLastname, yearHint);
      if (!hit) continue;
      const row = _hitRow(hit);
      let score = (hit.title_score || 0) * 10;
      if (row && row.ccf_tier) score += 8;
      else if (row) score += 3;
      if (authorLastname && _authorMatches(authorLastname, hit.authors)) score += 2;
      if (yearHint && hit.year && Math.abs(hit.year - yearHint) <= 1) score += 1;
      scored.push({ score, hit });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.length ? scored[0].hit : null;
  }

  return { byDoi, bestByTitle };
}


// =============================================================== OpenCitations Meta =====
const _OPENCITATIONS_META = "https://api.opencitations.net/meta/v1/metadata";

function _openCitationsVenue(value) {
  // OpenCitations appends identifiers in square brackets to the human-readable venue.
  return String(value || "").replace(/\s+\[[^\]]*\]\s*$/g, "").trim();
}

function _openCitationsAuthors(value) {
  return String(value || "").split(/\s*;\s*/).map((entry) =>
    entry.replace(/\s+\[[^\]]*\]\s*$/g, "").trim()
  ).filter(Boolean);
}

function _openCitationsRecordToHit(record, source = "opencitations_doi") {
  if (!record || typeof record !== "object") return null;
  const venue = _openCitationsVenue(record.venue);
  if (!venue || isNonvenue(venue)) return null;
  const typeText = String(record.type || "").toLowerCase();
  const kindHint = /journal/.test(typeText)
    ? "journal"
    : /proceedings|conference/.test(typeText)
      ? "conference"
      : null;
  const row = lookupRanking(venue, kindHint);
  const kind = row ? row.kind : kindHint;
  if (!kind) return null;
  const doiMatch = String(record.id || "").match(/(?:^|\s)doi:([^\s]+)/i);
  return {
    source,
    title: String(record.title || ""),
    authors: _openCitationsAuthors(record.author),
    title_score: 1,
    venue_raw: venue,
    venue_candidates: [venue],
    year: _yearFromText(record.pub_date),
    venue_type: kind,
    citation_count: null,
    influential_citations: null,
    external_doi: doiMatch ? doiMatch[1] : null,
    dblp_key: null,
    evidence_url: doiMatch ? "https://doi.org/" + doiMatch[1] : null,
    issn: null,
    abbrev: row ? row.canonical : null,
    publisher: _openCitationsVenue(record.publisher) || null,
  };
}

function makeOpenCitations(request, accessToken, sleep) {
  sleep = sleep || _defaultSleep;
  const cache = new Map();

  async function getWithRetry(url, tries = 4) {
    tries = request.managed ? 1 : tries;
    if (cache.has(url)) return cache.get(url);
    let delay = 1000;
    for (let i = 0; i < tries; i++) {
      try {
        const headers = { Accept: "application/json" };
        if (accessToken) headers.authorization = String(accessToken).trim();
        const res = await request("GET", url, { headers });
        const transient = res.status === 0 || res.status === 408 || res.status === 425 ||
          res.status === 429 || (res.status >= 500 && res.status < 600);
        if (transient) {
          if (i < tries - 1) {
            await sleep(delay);
            delay = Math.min(delay * 2, 15000);
            continue;
          }
          return null;
        }
        if (res.status < 200 || res.status >= 300) return null;
        cache.set(url, res.data);
        return res.data;
      } catch (e) {
        if (i < tries - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 15000);
        }
      }
    }
    return null;
  }

  async function byDoi(doi) {
    doi = _stripDoiUrl(doi);
    if (!doi || isArxivDoi(doi)) return null;
    const data = await getWithRetry(_OPENCITATIONS_META + "/doi:" + _doiPath(doi));
    const records = Array.isArray(data) ? data : [];
    for (const record of records) {
      const hit = _openCitationsRecordToHit(record);
      if (hit) return hit;
    }
    return null;
  }

  return { byDoi };
}

// ==================================================================== OpenAlex =========
const _OPENALEX_WORKS = "https://api.openalex.org/works";

function _openAlexSources(work) {
  const out = [];
  const add = (source) => {
    if (!source || !source.display_name) return;
    if (!out.some((x) => x.display_name === source.display_name)) out.push(source);
  };
  add(work && work.primary_location && work.primary_location.source);
  for (const loc of work && work.locations || []) add(loc && loc.source);
  return out;
}

function _openAlexAuthors(work) {
  return (work && work.authorships || [])
    .map((a) => a && a.author && a.author.display_name)
    .filter(Boolean);
}

function _openAlexWorkToHit(work, title, authorLastname, yearHint, source = "openalex") {
  if (!work) return null;
  const foundTitle = work.display_name || work.title || "";
  const jac = String(title || "").trim() ? titleSimilarity(title, foundTitle) : 1;
  if (String(title || "").trim() && jac < 0.80) return null;
  const authors = _openAlexAuthors(work);
  const authorOk = _authorMatches(authorLastname, authors);
  if (authorLastname && authors.length && !authorOk && jac < 0.96) return null;
  const year = work.publication_year ?? null;
  if (yearHint && year && Math.abs(year - yearHint) > 5 && jac < 0.96) return null;

  const sources = _openAlexSources(work);
  let selected = sources[0] || null;
  let row = null;
  for (const source of sources) {
    const candidate = lookupRanking(source.display_name, source.type === "journal" ? "journal" : null);
    if (candidate) {
      selected = source;
      row = candidate;
      if (candidate.ccf_tier) break;
    }
  }
  if (!selected || !selected.display_name || isNonvenue(selected.display_name)) return null;
  const kind = row
    ? row.kind
    : selected.type === "journal" ? "journal"
      : selected.type === "conference" ? "conference"
        : work.type === "article" ? "journal" : null;
  if (!kind) return null;
  if (selected.type === "repository" || work.type === "preprint") return null;
  const doi = _stripDoiUrl(work.doi);
  return {
    source,
    title: foundTitle,
    authors,
    title_score: jac,
    venue_raw: selected.display_name,
    year,
    venue_type: kind,
    citation_count: work.cited_by_count ?? null,
    influential_citations: null,
    external_doi: doi,
    dblp_key: null,
    evidence_url: work.id || null,
    issn: selected.issn_l || null,
    abbrev: selected.abbreviated_title || null,
    publisher: selected.host_organization_name || null,
  };
}

function makeOpenAlex(request, apiKey, sleep) {
  sleep = sleep || _defaultSleep;
  const cache = new Map();
  async function getWithRetry(url, tries = 3) {
    tries = request.managed ? 1 : tries;
    if (cache.has(url)) return cache.get(url);
    let delay = 1000;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await request("GET", url, { headers: { Accept: "application/json" } });
        const transient = res.status === 0 || res.status === 408 || res.status === 425 ||
          res.status === 429 || res.status === 503 || (res.status >= 500 && res.status < 600);
        if (transient) {
          if (i < tries - 1) {
            await sleep(delay);
            delay = Math.min(delay * 2, 10000);
            continue;
          }
          return null;
        }
        if (res.status < 200 || res.status >= 300) return null;
        cache.set(url, res.data);
        return res.data;
      } catch (e) {
        if (i < tries - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, 10000);
        }
      }
    }
    return null;
  }

  async function byDoi(doi) {
    doi = _stripDoiUrl(doi);
    if (!doi || isArxivDoi(doi) || !apiKey) return null;
    const params = [
      "select=" + encodeURIComponent("id,display_name,publication_year,doi,type,cited_by_count,primary_location,locations,authorships"),
      "api_key=" + encodeURIComponent(apiKey),
    ];
    const data = await getWithRetry(_OPENALEX_WORKS + "/doi:" + _doiPath(doi) + "?" + params.join("&"));
    return _openAlexWorkToHit(data, "", "", null, "openalex_doi");
  }

  async function bestByTitle(title, authorLastname = "", yearHint = null) {
    if (!String(title || "").trim()) return null;
    const params = [
      "search=" + encodeURIComponent(title),
      "per-page=10",
      "select=" + encodeURIComponent("id,display_name,publication_year,doi,type,cited_by_count,primary_location,locations,authorships"),
    ];
    if (apiKey) params.push("api_key=" + encodeURIComponent(apiKey));
    const data = await getWithRetry(_OPENALEX_WORKS + "?" + params.join("&"));
    const works = data && data.results || [];
    const scored = [];
    for (const work of works) {
      const hit = _openAlexWorkToHit(work, title, authorLastname, yearHint);
      if (!hit) continue;
      const row = lookupRanking(hit.venue_raw, hit.venue_type);
      let score = (hit.title_score || 0) * 10;
      if (row && row.ccf_tier) score += 8;
      else if (row) score += 3;
      if (authorLastname && _authorMatches(authorLastname, hit.authors)) score += 2;
      if (yearHint && hit.year && Math.abs(hit.year - yearHint) <= 1) score += 1;
      scored.push({ score, hit });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.length ? scored[0].hit : null;
  }

  return { byDoi, bestByTitle };
}


// ================================================================== pipeline ==========
const _CITE_BUCKETS = [10000, 5000, 1000, 500, 100, 50, 10];

function citeBucket(n) {
  if (n === null || n === undefined) return null;
  for (const b of _CITE_BUCKETS) if (n >= b) return `${b}+`;
  return "<10";
}

function itemYear(data) {
  const d = (data.date || "").trim();
  for (let i = 0; i < d.length - 3; i++) {
    const chunk = d.slice(i, i + 4);
    if (/^\d{4}$/.test(chunk) && (chunk.startsWith("19") || chunk.startsWith("20"))) return parseInt(chunk, 10);
  }
  return null;
}

const _SOURCE_WEIGHT = Object.freeze({
  override: 100,
  usenix_official: 40,
  official_web: 36,
  doi_csl: 34,
  crossref_doi: 34,
  datacite_doi: 33,
  arxiv_journal_ref: 32,
  opencitations_doi: 30,
  openalex_doi: 30,
  openreview: 31,
  dblp: 29,
  crossref_title: 26,
  datacite_title: 25,
  openalex: 24,
  semantic_scholar: 22,
  semantic_scholar_title: 21,
  brave_web: 20,
  duckduckgo_web: 19,
  arxiv_comment: 20,
  zotero_metadata: 19,
  brave_snippet: 16,
  duckduckgo_snippet: 15,
});

function _hitRow(hit) {
  if (!hit) return null;
  if (ZMCCFResolver && ZMCCFResolver.lookupDblp) {
    for (const value of [hit.dblp_key, hit.evidence_url]) {
      const match = ZMCCFResolver.lookupDblp(value);
      const row = _ccfToRanking(match);
      if (row) return row;
    }
  }
  const candidates = [
    ...(Array.isArray(hit.venue_candidates) ? hit.venue_candidates : []),
    hit.venue_raw,
    hit.abbrev,
  ].filter(Boolean);
  let fallback = null;
  for (const candidate of candidates) {
    const row = lookupRanking(candidate, hit.venue_type || null);
    if (!row) continue;
    if (row.ccf_tier) return row;
    if (!fallback) fallback = row;
  }
  return fallback;
}

function _canonicalKey(hit, row) {
  if (row && row.canonical) return `${row.kind}|${row.canonical}`;
  return `${hit.venue_type || "unknown"}|${normTitle(hit.venue_raw || "")}`;
}

function _individualHitScore(hit, row) {
  let score = _SOURCE_WEIGHT[hit.source] || 12;
  if (row) {
    score += 7;
    if (row.ccf_tier) score += 22;
    if (row.core) score += 3;
    // When the same work has both a later journal republication and an original
    // proceedings record, the resolver prefers the conference record.
    if (row.kind === "conference") score += 7;
  }
  if (Number.isFinite(hit.title_score)) score += Math.max(0, Math.min(3, hit.title_score * 3));
  if (hit.external_doi && !isArxivDoi(hit.external_doi)) score += 1;
  return score;
}

function sourceFamily(source) {
  const s = String(source || "unknown");
  if (/^semantic_scholar/.test(s)) return "semantic_scholar";
  if (/^(?:crossref|doi_csl)/.test(s)) return "crossref_or_doi";
  if (/^datacite/.test(s)) return "datacite";
  if (/^openalex/.test(s)) return "openalex";
  if (/^arxiv_/.test(s)) return "arxiv";
  if (/^(?:official_web|usenix_official|brave_|duckduckgo_)/.test(s)) return "web_evidence";
  return s;
}

function chooseVenue(hits) {
  const groups = new Map();
  for (const hit of hits || []) {
    if (!hit || !hit.venue_raw || isNonvenue(hit.venue_raw)) continue;
    const row = _hitRow(hit);
    const key = _canonicalKey(hit, row);
    const score = _individualHitScore(hit, row);
    if (!groups.has(key)) groups.set(key, { key, row, entries: [], best: null, max: -Infinity });
    const group = groups.get(key);
    group.entries.push({ hit, row, score });
    if (score > group.max) {
      group.max = score;
      group.best = hit;
      group.row = row || group.row;
    }
  }
  if (!groups.size) return [null, null];
  const ranked = [...groups.values()].map((group) => {
    const distinctSources = new Set(group.entries.map((e) => sourceFamily(e.hit.source))).size;
    const agreementBonus = Math.max(0, distinctSources - 1) * 10;
    const familyBest = new Map();
    for (const e of group.entries) {
      const family = sourceFamily(e.hit.source);
      if (!familyBest.has(family) || familyBest.get(family).score < e.score) familyBest.set(family, e);
    }
    const supportingBonus = [...familyBest.values()].sort((a, b) => b.score - a.score)
      .slice(1, 4).reduce((sum, e) => sum + e.score * 0.08, 0);
    return { ...group, total: group.max + agreementBonus + supportingBonus };
  });
  ranked.sort((a, b) => b.total - a.total || b.max - a.max);
  return [ranked[0].best, ranked[0].row];
}

function confidence(hits, chosen, row) {
  if (!chosen) return 0.0;
  if (/snippet$/.test(chosen.source || "")) return 0.65;
  if (!row) return 0.6;
  const canonical = row.canonical;
  const agreeing = (hits || []).filter((hit) => {
    const r = _hitRow(hit);
    return r && r.canonical === canonical && (!row.kind || r.kind === row.kind);
  });
  const sources = new Set(agreeing.map((h) => sourceFamily(h.source)));
  if (sources.size >= 3) return 0.99;
  if (sources.size >= 2) return 0.95;
  if (["usenix_official", "official_web", "doi_csl", "crossref_doi", "datacite_doi", "opencitations_doi", "arxiv_journal_ref", "openreview", "dblp"].includes(chosen.source)) {
    return row.ccf_tier ? 0.92 : 0.89;
  }
  if (row.ccf_tier) return 0.87;
  return 0.85;
}

function buildTags(res) {
  const tags = [];
  if (res.canonical) tags.push(`venue:${res.canonical}`);
  if (res.year) tags.push(`year:${res.year}`);
  if (res.ccf_tier) tags.push(`CCF2026:${res.ccf_tier}`);
  if (res.core_tier) tags.push(`CORE:${res.core_tier}`);
  tags.push(`acceptance:${res.acceptance}`);
  const bucket = citeBucket(res.citation_count);
  if (bucket) tags.push(`cite:${bucket}`);
  return tags;
}

function duplicateArxivGroups(results) {
  const groups = {};
  for (const r of results) {
    if (r.arxiv_id) (groups[r.arxiv_id] = groups[r.arxiv_id] || []).push(r.item_key);
  }
  const out = {};
  for (const [aid, keys] of Object.entries(groups)) if (keys.length > 1) out[aid] = keys;
  return out;
}

function overridesGet(arxivId) {
  if (!arxivId) return null;
  return ZMData.OVERRIDES[arxivId.trim()] || null;
}

function existingVenueHit(data) {
  data = data || {};
  const itemType = String(data.itemType || "");
  const conferenceCandidates = [data.conferenceName, data.proceedingsTitle].filter(Boolean);
  const journalCandidates = [data.journalAbbreviation, data.publicationTitle].filter(Boolean);
  const kindHint = itemType === "conferencePaper" || conferenceCandidates.length
    ? "conference"
    : itemType === "journalArticle" || journalCandidates.length
      ? "journal"
      : null;
  const candidates = kindHint === "conference" ? conferenceCandidates : kindHint === "journal" ? journalCandidates : [];
  let selected = null;
  let row = null;
  for (const candidate of candidates) {
    const found = lookupRanking(candidate, kindHint);
    if (!found) continue;
    selected = candidate;
    row = found;
    if (found.ccf_tier) break;
  }
  if (!selected || !row) return null;
  return {
    source: "zotero_metadata",
    title: data.title || "",
    authors: [],
    title_score: 1,
    venue_raw: selected,
    venue_candidates: candidates,
    year: itemYear(data),
    venue_type: row.kind,
    citation_count: null,
    influential_citations: null,
    external_doi: data.DOI || null,
    dblp_key: null,
    evidence_url: data.url || null,
    issn: data.ISSN || null,
    abbrev: kindHint === "conference" ? data.conferenceName || row.canonical : data.journalAbbreviation || row.canonical,
    publisher: data.publisher || null,
  };
}

function itemVenueOverride(data) {
  const extra = String(data && data.extra || "");
  let venue = "";
  let year = null;
  for (const line of extra.split(/\r\n|\r|\n/)) {
    let m = line.match(/^\s*(?:arxiv_marker_ccf2026-venue|venue override)\s*:\s*(.+?)\s*$/i);
    if (m) venue = m[1].trim();
    m = line.match(/^\s*(?:arxiv_marker_ccf2026-year|venue year)\s*:\s*((?:19|20)\d{2})\s*$/i);
    if (m) year = parseInt(m[1], 10);
  }
  if (!venue) return null;
  const row = lookupRanking(venue);
  if (!row) return null;
  return { venue, year, row };
}

function hasRecognizedVenue(hits) {
  return (hits || []).some((h) => !!_hitRow(h));
}

function hasRecognizedConference(hits) {
  return (hits || []).some((h) => {
    const row = _hitRow(h);
    return !!(row && row.kind === "conference");
  });
}

function hasCCFVenue(hits) {
  return (hits || []).some((h) => {
    const row = _hitRow(h);
    return !!(row && row.ccf_tier);
  });
}

function hasCCFConference(hits) {
  return (hits || []).some((h) => {
    const row = _hitRow(h);
    return !!(row && row.kind === "conference" && row.ccf_tier);
  });
}

const _STRONG_CONFERENCE_SOURCES = new Set([
  "usenix_official",
  "official_web",
  "openreview",
  "dblp",
  "crossref_doi",
  "datacite_doi",
  "opencitations_doi",
  "openalex_doi",
  "arxiv_journal_ref",
]);

// A single weak/aggregated source should not end the search. Keep escalating until a
// CCF conference is backed by an authoritative record or two independent sources agree.
function hasStrongCCFConference(hits) {
  const groups = new Map();
  for (const hit of hits || []) {
    const row = _hitRow(hit);
    if (!row || row.kind !== "conference" || !row.ccf_tier) continue;
    const key = row.canonical;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(sourceFamily(hit.source));
    if (_STRONG_CONFERENCE_SOURCES.has(hit.source)) return true;
  }
  return [...groups.values()].some((sources) => sources.size >= 2);
}

function canonicalOfHit(hit) {
  if (!hit || !hit.venue_raw) return null;
  const row = _hitRow(hit);
  return row ? row.canonical : hit.venue_raw;
}

function _extractFormalDois(data, s2hit, arxivMeta) {
  const values = [
    data && data.DOI,
    data && data.extra,
    s2hit && s2hit.external_doi,
    arxivMeta && arxivMeta.doi,
  ];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || "");
    const matches = text.match(/10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/gi) || [];
    // A bare DOI field may not need regex extraction, but normalize it through the same path.
    if (!matches.length && /^10\.\d{4,9}\//i.test(text.trim())) matches.push(text.trim());
    for (let doi of matches) {
      doi = _stripDoiUrl(doi).replace(/[\],.;:)}]+$/g, "");
      if (!doi || isArxivDoi(doi)) continue;
      const key = doi.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(doi);
    }
  }
  return out;
}

function _resolverFromOptions(opts, key, factory) {
  if (Object.prototype.hasOwnProperty.call(opts, key)) return opts[key];
  return opts.request ? factory() : null;
}

// Result composition is independent of network scheduling and can be tested in isolation.
function resolutionFromHits(it, hits, opts = {}) {
  const data = it.data || {}, key = it.key, title = data.title || "";
  const aid = extractArxivId(data);
  const s2hit = hits.find((h) => h.source === "semantic_scholar") || null;
  const arxivMeta = opts.arxivMeta || null;
  const cmap = opts.collectionsMap || {};
  const today = opts.today || _todayStr();
  const [chosen, row] = chooseVenue(hits);
  // Keep citation counts in one named measurement system. Crossref/OpenAlex values
  // are not interchangeable with Semantic Scholar counts or independent votes.
  const citationHits = hits.filter((h) => /^semantic_scholar/.test(h.source || "") && h.citation_count !== null && h.citation_count !== undefined);
  const cites = citationHits.length ? Math.max(...citationHits.map((h) => Number(h.citation_count) || 0)) : null;
  const inflHits = hits.filter((h) => h.influential_citations !== null && h.influential_citations !== undefined);
  const infl = inflHits.length ? Math.max(...inflHits.map((h) => Number(h.influential_citations) || 0)) : null;

  const res = {
    item_key: key,
    version: it.version || data.version || 0,
    title,
    arxiv_id: aid,
    venue_raw: chosen ? chosen.venue_raw : null,
    canonical: row ? row.canonical : chosen ? chosen.venue_raw : null,
    kind: row ? row.kind : chosen ? chosen.venue_type : null,
    year: chosen && chosen.year
      ? chosen.year
      : (arxivMeta && arxivMeta.published_year) || (s2hit && s2hit.year) || itemYear(data),
    ccf_tier: row && row.ccf_tier ? row.ccf_tier : null,
    ccf_domain: row && row.ccf_domain ? row.ccf_domain : null,
    core_tier: row && row.core ? row.core : null,
    acceptance: chosen ? "accepted" : "unknown",
    confidence: confidence(hits, chosen, row),
    citation_count: cites,
    influential_citations: infl,
    sources: [...new Set(hits.map((h) => h.source))],
    evidence: hits.map((h) => `${h.source}: ${h.venue_raw || "-"} (${h.evidence_url || ""})`),
    suggested_tags: [],
    existing_tags: (data.tags || []).map((t) => t.tag || ""),
    collections: (data.collections || []).map((k) => cmap[k] || k),
    current_item_type: data.itemType || "preprint",
    target_item_type: null,
    fields: {},
  };
  res.suggested_tags = buildTags(res);

  let proposalHit = chosen;

  const ov = overridesGet(aid);
  if (ov && ov.canonical) {
    const orow = lookupRanking(ov.canonical);
    res.canonical = orow ? orow.canonical : ov.canonical;
    res.venue_raw = ov.canonical;
    res.kind = orow ? orow.kind : res.kind;
    res.year = ov.year || res.year;
    res.ccf_tier = orow && orow.ccf_tier ? orow.ccf_tier : null;
    res.ccf_domain = orow && orow.ccf_domain ? orow.ccf_domain : null;
    res.core_tier = orow && orow.core ? orow.core : null;
    res.acceptance = "accepted";
    res.confidence = 1.0;
    res.sources = ["override", ...res.sources];
    res.evidence = [`override: ${ov.canonical}`, ...res.evidence];
    res.suggested_tags = buildTags(res);
  }

  const userOverride = itemVenueOverride(data);
  if (userOverride) {
    const urow = userOverride.row;
    res.canonical = urow.canonical;
    res.venue_raw = userOverride.venue;
    res.kind = urow.kind;
    res.year = userOverride.year || res.year || itemYear(data);
    res.ccf_tier = urow.ccf_tier || null;
    res.ccf_domain = urow.ccf_domain || null;
    res.core_tier = urow.core || null;
    res.acceptance = "accepted";
    res.confidence = 1.0;
    res.sources = ["user_override", ...res.sources.filter((source) => source !== "user_override")];
    res.evidence = [`user_override: ${userOverride.venue}`, ...res.evidence];
    res.suggested_tags = buildTags(res);
    proposalHit = {
      source: "user_override",
      venue_raw: userOverride.venue,
      year: res.year,
      venue_type: urow.kind,
      abbrev: urow.canonical,
    };
  }

  if (proposalHit && res.canonical && canonicalOfHit(proposalHit) !== res.canonical) proposalHit = null;
  const [itype, fields] = buildProposal(res, proposalHit, aid, data, today);
  res.target_item_type = itype;
  res.fields = fields;
  return res;
}

async function resolveItems(items, opts = {}) {
  const pipeline = typeof ZMFastPipeline !== "undefined" ? ZMFastPipeline
    : typeof require !== "undefined" ? require("./pipeline.js") : null;
  if (!pipeline) throw new Error("arxiv_marker_ccf2026: pipeline.js was not loaded");
  return pipeline.resolve(ZMResolver, items, opts);
}

// ================================================================== proposal ==========
const _TOOL_LINE =
  /^\s*(?:\d+\s+citations\s*\(semantic\s*scholar\)|citations:\s*\d+\s*\(semanticscholar\)|(?:zotero|arxiv)-marker:|arxiv_marker_ccf2026:)/i;

const _PUBLISHER = {
  CVPR: "IEEE", ICCV: "IEEE", WACV: "IEEE", ICRA: "IEEE", IROS: "IEEE",
  ECCV: "Springer",
  ICML: "PMLR", AISTATS: "PMLR", COLT: "PMLR", UAI: "PMLR",
  ACL: "ACL", EMNLP: "ACL", NAACL: "ACL",
  KDD: "ACM", WWW: "ACM", SIGIR: "ACM", SIGGRAPH: "ACM", "ACM MM": "ACM",
  AAAI: "AAAI Press", IJCAI: "IJCAI", "USENIX Security": "USENIX",
};

const _TITLE_STOPWORDS = new Set(["a", "an", "the", "of", "for", "and", "in", "on", "to", "at", "via"]);

function isArxivDoi(doi) {
  return !!doi && doi.toLowerCase().includes("arxiv");
}

function smartTitle(s) {
  const words = s.split(/\s+/).filter(Boolean);
  return words
    .map((w, i) =>
      i && _TITLE_STOPWORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.slice(0, 1).toUpperCase() + w.slice(1)
    )
    .join(" ");
}

function fullName(canonical, raw) {
  const row = lookupRanking(canonical || raw || "");
  if (row && row.write_as) return row.write_as;
  // When the selected source exposes only the canonical abbreviation/name, prefer the
  // complete CCF catalogue name for bibliographic metadata while still writing the compact
  // canonical value to conferenceName/journalAbbreviation.
  if (row && row.full_name && raw && normTitle(raw) === normTitle(row.canonical)) return row.full_name;
  if (raw && raw.split(/\s+/).filter(Boolean).length >= 2) return raw;
  if (row) {
    const cands = [row.canonical, ...row.aliases];
    let longest = cands[0];
    for (const c of cands) if (c.length > longest.length) longest = c;
    if (longest.split(/\s+/).filter(Boolean).length >= 2) return smartTitle(longest);
  }
  return raw || canonical || "";
}

function _todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function managedFieldsMatch(data, fields, publicationYear) {
  for (const [key, value] of Object.entries(fields)) {
    if (key === "extra") continue;
    if (key === "date") {
      if (publicationYear && itemYear(data) !== publicationYear) return false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) && String(data.date || "") !== value) return false;
      continue;
    }
    if (String(data[key] || "") !== String(value || "")) return false;
  }
  return true;
}

function buildProposal(res, venueHit, arxivId, data, today) {
  today = today || _todayStr();
  if (res.acceptance !== "accepted" || !res.canonical) return [null, {}];

  const name = fullName(res.canonical, res.venue_raw);
  let doi = null;
  let issn = null;
  let abbrev = res.canonical;
  if (venueHit) {
    if (venueHit.external_doi && !isArxivDoi(venueHit.external_doi)) doi = venueHit.external_doi;
    issn = venueHit.issn;
    abbrev = venueHit.abbrev || res.canonical;
  }

  const fields = {};
  let itype;
  if ((res.kind || "conference") === "journal") {
    itype = "journalArticle";
    fields.publicationTitle = name;
    if (abbrev) fields.journalAbbreviation = abbrev;
    if (issn) fields.ISSN = issn;
  } else {
    itype = "conferencePaper";
    fields.proceedingsTitle = name;
    // Full proceedings title for metadata matching; short canonical conference name for
    // compact attachment names such as ICLR2026 Paper Title.pdf.
    fields.conferenceName = res.canonical;
    const catalogue = lookupRanking(res.canonical, "conference");
    const pub = (venueHit && venueHit.publisher) || (catalogue && catalogue.publisher) || _PUBLISHER[res.canonical];
    if (pub) fields.publisher = pub;
  }
  if (doi) fields.DOI = doi;
  for (const key of ["volume", "issue", "pages"]) {
    if (venueHit && venueHit[key] && !(key === "issue" && itype === "conferencePaper")) fields[key] = String(venueHit[key]);
  }
  const formalDate = venueHit && venueHit.publication_date;
  if (formalDate && /^\d{4}-\d{2}-\d{2}$/.test(formalDate) && Number(formalDate.slice(0, 4)) === res.year &&
      (data.itemType === "preprint" || !data.date || /^\d{4}$/.test(data.date) || itemYear(data) !== res.year)) {
    fields.date = formalDate; // a verified formal date may replace the arXiv submission date
  } else if (res.year && itemYear(data) !== res.year) {
    fields.date = String(res.year); // no exact date known: do not invent month/day
  }

  const extra = data.extra || "";
  const lines = extra ? extra.split(/\r\n|\r|\n/) : [];
  const kept = lines.filter((ln) => !_TOOL_LINE.test(ln));
  if (arxivId && !kept.some((ln) => ln.toLowerCase().includes("arxiv"))) kept.push(`arXiv:${arxivId}`);
  if (res.citation_count !== null && res.citation_count !== undefined) {
    kept.push(`Citations: ${res.citation_count} (SemanticScholar) [${today}]`);
  }
  kept.push(`arxiv_marker_ccf2026: resolved ${today}`);
  fields.extra = kept.join("\n").trim();

  if ((data.itemType || "") === itype && managedFieldsMatch(data, fields, res.year)) {
    return [null, {}];
  }
  return [itype, fields];
}

// --- exports for local tooling; under loadSubScript these live in the shared scope -----
var ZMResolver = {
  extractArxivId, normTitle, titleJaccard, titleSimilarity, titleMatch, firstAuthorLastname,
  lookupCoreRanking, lookupRanking, isNonvenue,
  makeS2, makeArxiv, parseArxivAtom, makeOpenReview, makeUSENIX, makeWebSearch, makeDBLP, makeCrossref, makeDataCite, makeOpenCitations, makeOpenAlex, openReviewVenueMeta,
  _decodeHtml, _htmlToText, _htmlAnchors, _pageToVenueHit, _parseDuckDuckGoResults, _parseBraveResults, _findCcfVenueInText,
  citeBucket, itemYear, chooseVenue, confidence, buildTags, duplicateArxivGroups,
  hasRecognizedVenue, hasRecognizedConference, hasCCFVenue, hasCCFConference, hasStrongCCFConference, canonicalOfHit,
  resolveItems, resolutionFromHits, verifyIdentity, overridesGet, existingVenueHit, itemVenueOverride,
  _htmlMetaValues, _htmlHeadingValues, _isOfficialPublisherUrl, _venueHitFromText, _crossrefMessageToHit,
  _hitRow, _extractFormalDois, _SOURCE_WEIGHT, sourceFamily,
  isArxivDoi, smartTitle, fullName, managedFieldsMatch, buildProposal,
};
if (typeof module !== "undefined" && module.exports) {
  module.exports = ZMResolver;
}
