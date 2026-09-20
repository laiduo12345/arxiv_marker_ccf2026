// Local CCF 2026 lookup and column helpers.
// Pure JavaScript: runs as a Zotero classic subscript and can also be loaded by local
// maintenance tooling. The complete 681-entry catalogue is generated into zm-data.js.

var _CCF2026_DATA =
  typeof ZM_CCF_2026 !== "undefined"
    ? ZM_CCF_2026
    : typeof require !== "undefined"
      ? require("./zm-data.js").CCF_2026
      : [];

var _CCF2026_META =
  typeof ZM_CCF_2026_META !== "undefined"
    ? ZM_CCF_2026_META
    : typeof require !== "undefined"
      ? require("./zm-data.js").CCF_2026_META
      : {};

const CCF2026_COLORS = Object.freeze({
  A: "#D84A4A",
  B: "#7B61A8",
  C: "#C58A2B",
});

const _CCF_TRACK_DISQUALIFIERS = [
  "workshop",
  "workshops",
  "findings",
  "tutorial",
  "tutorials",
  "demo",
  "demonstration",
  "doctoral consortium",
  "industry track",
  "short paper",
  "companion",
  "challenge",
  "shared task",
];

function ccfNorm(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function _ccfUnique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const s = String(value || "").trim();
    const n = ccfNorm(s);
    if (!s || !n || seen.has(n)) continue;
    seen.add(n);
    out.push(s);
  }
  return out;
}

function _ccfVariants(value) {
  const original = ccfNorm(value);
  if (!original) return [];
  let cleaned = original
    .replace(/\bproceedings of the\b/g, " ")
    .replace(/\bproceedings of\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\b/g, " ")
    .replace(/\bvol(?:ume)?\s*\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return _ccfUnique([original, cleaned]);
}

function _ccfHasTrackDisqualifier(value) {
  const n = ccfNorm(value);
  return _CCF_TRACK_DISQUALIFIERS.some((word) => n.includes(word));
}

function _ccfRowKey(row) {
  return `${row.domain}\u0000${row.kind}\u0000${row.canonical}\u0000${row.tier}`;
}

function _ccfAliases(row) {
  return _ccfUnique([row.canonical, row.full_name, ...(row.aliases || [])]);
}

function _ccfAggregate(rows, matchedBy, query) {
  const unique = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = _ccfRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  if (!unique.length) return null;
  const tiers = [...new Set(unique.map((r) => r.tier))];
  const identities = new Set(unique.map((r) => `${r.kind}|${ccfNorm(r.full_name || r.canonical)}`));
  if (tiers.length !== 1 || identities.size > 1) {
    return {
      ambiguous: true,
      query,
      matched_by: matchedBy,
      entries: unique,
      tiers,
    };
  }
  const canonicals = [...new Set(unique.map((r) => r.canonical))];
  const domains = [...new Set(unique.map((r) => r.domain))];
  const fullName = unique.map((r) => r.full_name).find(Boolean) || "";
  const publisher = unique.map((r) => r.publisher).find(Boolean) || "";
  const url = unique.map((r) => r.url).find(Boolean) || "";
  const dblpSlug = unique.map((r) => r.dblp_slug).find(Boolean) || "";
  return {
    ambiguous: false,
    tier: tiers[0],
    canonical: canonicals.length === 1 ? canonicals[0] : canonicals.join(" / "),
    full_name: fullName,
    publisher,
    url,
    dblp_slug: dblpSlug,
    kind: unique[0].kind,
    domain: domains.join(" / "),
    domains,
    query,
    matched_by: matchedBy,
    entries: unique,
  };
}

const _CCF_EXACT = new Map();
const _CCF_LONG_ALIASES = [];
const _CCF_ACRONYM_TOKENS = new Map();
const _CCF_SHORT_ACRONYM_TOKENS = new Map();
const _CCF_DERIVED_ACRONYMS = new Map();
const _CCF_DBLP_SLUGS = new Map();

function _ccfLooksLikeAcronym(value) {
  const raw = String(value || "").trim();
  const compact = raw.replace(/[^A-Za-z0-9]/g, "");
  if (compact.length < 4) return false;
  const capitals = (raw.match(/[A-Z]/g) || []).length;
  // All-uppercase abbreviations and CamelCase venue names such as MobiCom/EuroSys.
  return capitals >= 2 || (compact === compact.toUpperCase() && /[A-Z]/.test(compact));
}

for (const row of _CCF2026_DATA) {
  if (row.kind === "conference" && row.dblp_slug) {
    const slug = String(row.dblp_slug).trim().toLowerCase();
    if (!_CCF_DBLP_SLUGS.has(slug)) _CCF_DBLP_SLUGS.set(slug, []);
    _CCF_DBLP_SLUGS.get(slug).push(row);
  }
  for (const alias of _ccfAliases(row)) {
    const n = ccfNorm(alias);
    if (!n) continue;
    const key = `${row.kind}|${n}`;
    if (!_CCF_EXACT.has(key)) _CCF_EXACT.set(key, []);
    _CCF_EXACT.get(key).push(row);
    const tokens = n.split(" ");
    if (n.length >= 12 && tokens.length >= 3) {
      _CCF_LONG_ALIASES.push({ norm: n, tokens, row });
    }
  }
  if (_ccfLooksLikeAcronym(row.canonical)) {
    const acronym = ccfNorm(row.canonical);
    if (!_CCF_ACRONYM_TOKENS.has(acronym)) _CCF_ACRONYM_TOKENS.set(acronym, []);
    _CCF_ACRONYM_TOKENS.get(acronym).push(row);
    const compact = String(row.canonical || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (compact.length >= 4 && compact.length <= 16) {
      if (!_CCF_DERIVED_ACRONYMS.has(compact)) _CCF_DERIVED_ACRONYMS.set(compact, []);
      _CCF_DERIVED_ACRONYMS.get(compact).push(row);
    }
  } else {
    const raw = String(row.canonical || "").trim();
    const compact = raw.replace(/[^A-Za-z0-9]/g, "");
    // Preserve case for short acronyms. Normalized-token matching would otherwise turn
    // ordinary words such as "is", "re", or "ai" into false venue matches.
    if (compact.length >= 2 && compact.length <= 3 && compact === compact.toUpperCase() && /[A-Z]/.test(compact)) {
      if (!_CCF_SHORT_ACRONYM_TOKENS.has(compact)) _CCF_SHORT_ACRONYM_TOKENS.set(compact, []);
      _CCF_SHORT_ACRONYM_TOKENS.get(compact).push(row);
    }
  }
}
_CCF_LONG_ALIASES.sort((a, b) => b.tokens.length - a.tokens.length || b.norm.length - a.norm.length);


const _CCF_INITIALISM_STOP = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with",
]);
const _CCF_INITIALISM_PUBLISHER = new Set([
  "acm", "ieee", "usenix", "ifip", "springer", "siam", "aaai", "cvf", "sigact", "sigchi", "sigda", "sigplan", "sigsoft",
]);
const _CCF_INITIALISM_EDGE_GENERIC = new Set([
  "annual", "international", "joint", "conference", "symposium", "workshop", "meeting", "congress", "proceedings", "forum",
]);

function _ccfInitials(tokens) {
  return tokens.map((token) => token.slice(0, 1).toUpperCase()).join("");
}

// Infer conventional initialisms from long source names. This is deliberately exact:
// ICMLA produces ICMLA, never ICML. Multiple edge-trimmed variants recover forms such as
// HPCA (drop "IEEE International Symposium on") and NSDI (drop leading "Symposium").
function _ccfInitialismVariants(value) {
  const raw = String(value || "")
    .normalize("NFKC")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .match(/[A-Za-z0-9]+/g) || [];
  let tokens = raw
    .map((token) => token.toLowerCase())
    .filter((token) => token && !/^\d+$/.test(token) && !_CCF_INITIALISM_STOP.has(token));
  if (tokens.length < 2) return [];

  const sequences = [];
  const addSequence = (seq) => {
    if (seq.length >= 2) sequences.push(seq);
  };
  addSequence(tokens);
  addSequence(tokens.filter((token) => !_CCF_INITIALISM_PUBLISHER.has(token)));

  for (const base of sequences.slice()) {
    let left = base.slice();
    while (left.length >= 2 && (_CCF_INITIALISM_PUBLISHER.has(left[0]) || _CCF_INITIALISM_EDGE_GENERIC.has(left[0]))) {
      left = left.slice(1);
      addSequence(left);
    }
    let right = base.slice();
    while (right.length >= 2 && _CCF_INITIALISM_EDGE_GENERIC.has(right[right.length - 1])) {
      right = right.slice(0, -1);
      addSequence(right);
    }
    let both = left.slice();
    while (both.length >= 2 && _CCF_INITIALISM_EDGE_GENERIC.has(both[both.length - 1])) {
      both = both.slice(0, -1);
      addSequence(both);
    }
  }

  return _ccfUnique(sequences.map(_ccfInitials).filter((value) => value.length >= 4 && value.length <= 16));
}

const _CCF_LOOKUP_CACHE = new Map();

const _CCF_SAFE_WRAPPER_TOKENS = new Set([
  "proceedings", "of", "the", "annual", "joint", "international", "ieee", "acm",
  "usenix", "springer", "conference", "symposium", "meeting", "congress", "series",
  "volume", "vol", "edition", "on", "for", "and",
]);

function _ccfWrapperTokensSafe(tokens) {
  return tokens.every((token) =>
    /^(?:19|20)\d{2}$/.test(token) || /^\d+$/.test(token) || _CCF_SAFE_WRAPPER_TOKENS.has(token)
  );
}

function _ccfFindTokenRun(haystack, needle) {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let same = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        same = false;
        break;
      }
    }
    if (same) return i;
  }
  return -1;
}

function lookupCCF2026(value, kind = null) {
  const kindList = kind === "journal" || kind === "conference" ? [kind] : ["conference", "journal"];
  const variants = _ccfVariants(value);
  const cacheKey = `${kindList.join(",")}|${variants.join("|")}`;
  if (_CCF_LOOKUP_CACHE.has(cacheKey)) return _CCF_LOOKUP_CACHE.get(cacheKey);
  if (!variants.length) {
    _CCF_LOOKUP_CACHE.set(cacheKey, null);
    return null;
  }

  for (const variant of variants) {
    for (const k of kindList) {
      const rows = _CCF_EXACT.get(`${k}|${variant}`) || [];
      if (!rows.length) continue;
      const result = _ccfAggregate(rows, "exact", value);
      _CCF_LOOKUP_CACHE.set(cacheKey, result);
      return result;
    }
  }

  // Conservative acronym-token matching covers source strings such as
  // "Proceedings of ... (PPoPP 2026)" even when the compact CCF transcription only
  // contains the official abbreviation. Very short/generic names are excluded.
  if (kindList.includes("conference") && _ccfHasTrackDisqualifier(value)) {
    _CCF_LOOKUP_CACHE.set(cacheKey, null);
    return null;
  }
  const queryTokens = variants[0].split(" ");
  const acronymCandidates = [];

  // Short acronyms need case-sensitive matching. This recovers venue strings such as
  // "Proceedings of VR 2026" and "IEEE S&P" without treating ordinary words like
  // "is" or "re" as conference abbreviations.
  const rawTokens = String(value || "").match(/[A-Za-z0-9]+/g) || [];
  for (const token of rawTokens) {
    if (token !== token.toUpperCase()) continue;
    const rows = _CCF_SHORT_ACRONYM_TOKENS.get(token) || [];
    for (const row of rows) if (kindList.includes(row.kind)) acronymCandidates.push(row);
  }

  for (const token of queryTokens) {
    const rows = _CCF_ACRONYM_TOKENS.get(token) || [];
    for (const row of rows) if (kindList.includes(row.kind)) acronymCandidates.push(row);
  }
  const acronymResult = _ccfAggregate(acronymCandidates, "acronym-token", value);
  if (acronymResult && !acronymResult.ambiguous) {
    _CCF_LOOKUP_CACHE.set(cacheKey, acronymResult);
    return acronymResult;
  }

  const derivedCandidates = [];
  for (const acronym of _ccfInitialismVariants(value)) {
    const rows = _CCF_DERIVED_ACRONYMS.get(acronym) || [];
    for (const row of rows) if (kindList.includes(row.kind)) derivedCandidates.push(row);
  }
  const derivedResult = _ccfAggregate(derivedCandidates, "derived-initialism", value);
  if (derivedResult && !derivedResult.ambiguous) {
    _CCF_LOOKUP_CACHE.set(cacheKey, derivedResult);
    return derivedResult;
  }

  // Conservative long-name containment. Short acronyms never use substring matching,
  // preventing collisions such as IS/CC/RE.
  const candidates = [];
  for (const candidate of _CCF_LONG_ALIASES) {
    if (!kindList.includes(candidate.row.kind)) continue;
    if (candidate.tokens.length > queryTokens.length) continue;
    const index = _ccfFindTokenRun(queryTokens, candidate.tokens);
    if (index < 0) continue;
    const before = queryTokens.slice(0, index);
    const after = queryTokens.slice(index + candidate.tokens.length);
    // Require containment to look like a bibliographic wrapper, not the name of a
    // different venue. For example, ICML must not match "International Conference on
    // Machine Learning and Applications" (ICMLA).
    if (_ccfWrapperTokensSafe(before) && _ccfWrapperTokensSafe(after)) {
      candidates.push(candidate.row);
    }
  }
  const result = _ccfAggregate(candidates, "long-name", value);
  _CCF_LOOKUP_CACHE.set(cacheKey, result && !result.ambiguous ? result : result || null);
  return result;
}

function lookupCCF2026ByDblp(value) {
  const text = String(value || "");
  const match = text.match(/(?:^|\/)conf\/([^/?#]+)/i);
  if (!match) return null;
  const slug = match[1].toLowerCase();
  return _ccfAggregate(_CCF_DBLP_SLUGS.get(slug) || [], "dblp-slug", value);
}

function _ccfKindForItemData(data) {
  const itemType = String((data && data.itemType) || "");
  if (itemType === "conferencePaper") return "conference";
  if (itemType === "journalArticle") return "journal";
  if (data && (data.conferenceName || data.proceedingsTitle)) return "conference";
  if (data && (data.journalAbbreviation || data.publicationTitle)) return "journal";
  return null;
}

function lookupCCF2026ForItem(data) {
  data = data || {};
  const kind = _ccfKindForItemData(data);
  if (!kind) return null;
  const candidates = kind === "conference"
    ? [data.conferenceName, data.proceedingsTitle]
    : [data.journalAbbreviation, data.publicationTitle];

  // A workshop/Findings/etc. title must not inherit the main-conference rating merely
  // because a short conferenceName is also present.
  if (kind === "conference" && candidates.some((value) => value && _ccfHasTrackDisqualifier(value))) {
    return null;
  }

  let ambiguous = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const result = lookupCCF2026(candidate, kind);
    if (!result) continue;
    if (result.ambiguous) {
      ambiguous = result;
      continue; // a full proceedings title may disambiguate a short acronym such as FSE
    }
    return result;
  }
  return ambiguous;
}

function venueLabelForItem(data) {
  data = data || {};
  const itemType = String(data.itemType || "");
  if (itemType === "preprint") return "Preprint";
  const kind = _ccfKindForItemData(data);
  const match = lookupCCF2026ForItem(data);
  if (kind === "conference") {
    return String(data.conferenceName || (match && !match.ambiguous ? match.canonical : "") || data.proceedingsTitle || "");
  }
  if (kind === "journal") {
    return String(data.journalAbbreviation || (match && !match.ambiguous ? match.canonical : "") || data.publicationTitle || "");
  }
  return String(data.publicationTitle || data.proceedingsTitle || data.publisher || "");
}

function ccfColumnDataForItem(data) {
  const result = lookupCCF2026ForItem(data);
  if (!result || result.ambiguous || !result.tier) return "";
  const order = { A: "1", B: "2", C: "3" }[result.tier] || "9";
  return [order, result.tier, result.canonical, result.domain, result.full_name].join("\u001f");
}

function parseCcfColumnData(value) {
  const parts = String(value || "").split("\u001f");
  if (parts.length < 4 || !/^[ABC]$/.test(parts[1])) return null;
  return {
    order: parts[0],
    tier: parts[1],
    canonical: parts[2],
    domain: parts[3],
    full_name: parts[4] || "",
  };
}

var ZMCCF = {
  data: _CCF2026_DATA,
  meta: _CCF2026_META,
  colors: CCF2026_COLORS,
  norm: ccfNorm,
  lookup: lookupCCF2026,
  lookupDblp: lookupCCF2026ByDblp,
  lookupItem: lookupCCF2026ForItem,
  venueLabel: venueLabelForItem,
  columnData: ccfColumnDataForItem,
  parseColumnData: parseCcfColumnData,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = ZMCCF;
}
