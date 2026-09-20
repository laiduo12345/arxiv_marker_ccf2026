// Additional discovery routes, separate from transport and orchestration.
// Do not treat a search result or a reference-list mention as an acceptance decision.
var ZMDiscovery = (() => {
  function create(R, request, options = {}) {
    const text = R._htmlToText;
    const meta = R._htmlMetaValues;
    const unique = (xs) => [...new Set(xs.filter(Boolean))];
    const first = (xs) => xs && xs.length ? xs[0] : '';
    const formalDoi = (s) => {
      const v = String(s || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
      return /^10\.\d{4,9}\/\S+$/i.test(v) && !R.isArxivDoi(v) ? v : null;
    };
    function queryVariants(title) {
      const clean = String(title || '').normalize('NFKC').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();
      const head = clean.split(/[:：]/)[0].trim();
      const words = R.normTitle(clean).split(' ');
      return unique([clean, R.normTitle(clean), R.normTitle(head).split(' ').length >= 3 ? head : '',
        words.length > 12 ? words.slice(0, 10).join(' ') : '']).slice(0, 4);
    }
    async function get(url, responseType = 'text', headers = {}) {
      if (request.isStopped && request.isStopped()) return null;
      try {
        const res = await request('GET', url, { responseType, headers });
        if (res.status !== 200) return null;
        if (responseType === 'json') {
          if (typeof res.data === 'string') { try { return JSON.parse(res.data); } catch (_) { return null; } }
          return res.data;
        }
        return typeof res.data === 'string' ? res.data : res.text || null;
      } catch (_) { return null; }
    }
    function arxivPage(html, aid) {
      if (!html) return null;
      const foundId = first(meta(html, ['citation_arxiv_id'])) || '';
      if (foundId && R.extractArxivId({ archiveID: foundId }) !== aid) return null;
      const title = first(meta(html, ['citation_title'])) || text((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').replace(/^Title:\s*/i, '');
      if (!title) return null;
      function tableValue(label, cls) {
        const row = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].find((m) => new RegExp(label + '\\s*:', 'i').test(text(m[1])));
        if (row) {
          const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
          if (cells.length > 1) return text(cells[cells.length - 1][1]);
        }
        const m = html.match(new RegExp('<td\\b[^>]*class=["\\\'][^"\\\']*\\b' + cls + '\\b[^"\\\']*["\\\'][^>]*>([\\s\\S]*?)<\\/td>', 'i'));
        return m ? text(m[1]) : '';
      }
      const comment = tableValue('Comments?', 'comments');
      const journal = tableValue('Journal reference', 'jref');
      const doi = formalDoi(first(meta(html, ['citation_doi']))) || formalDoi(tableValue('DOI', 'doi'));
      const published = first(meta(html, ['citation_date', 'citation_publication_date'])) || '';
      const year = Number((published.match(/(?:19|20)\d{2}/) || [])[0]) || null;
      const links = unique(R._htmlAnchors(html, 'https://arxiv.org/abs/' + aid).map((a) => a.url).filter((u) => R._isOfficialPublisherUrl(u)));
      const hits = [];
      const j = R._venueHitFromText(journal, 'arxiv_journal_ref', year, { doi, evidence_url: 'https://arxiv.org/abs/' + aid });
      if (j) hits.push({ ...j, title });
      if (comment && /\b(?:accepted|published|to\s+appear)\b/i.test(comment) && !/\b(?:submitted|under\s+review|rejected|withdrawn|workshop|findings)\b/i.test(comment)) {
        const c = R._venueHitFromText(comment, 'arxiv_comment', year, { doi, evidence_url: 'https://arxiv.org/abs/' + aid });
        if (c) hits.push({ ...c, title });
      }
      return { arxiv_id: aid, title, comment, journal_ref: journal, doi, published_year: year, hits, links };
    }
    async function arxivById(aid) {
      if (!/^\d{4}\.\d{4,5}$/.test(aid || '')) return null;
      return arxivPage(await get('https://arxiv.org/abs/' + aid), aid);
    }
    function jsonLD(html) {
      const records = [];
      for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
          const parsed = JSON.parse(match[1]);
          const stack = Array.isArray(parsed) ? parsed.slice() : [parsed];
          while (stack.length && records.length < 50) {
            const o = stack.shift(); if (!o || typeof o !== 'object') continue;
            if (Array.isArray(o['@graph'])) stack.push(...o['@graph']);
            const typ = String(o['@type'] || '');
            if (/ScholarlyArticle|Article|CreativeWork/i.test(typ)) records.push(o);
          }
        } catch (_) { /* malformed JSON-LD is not evidence */ }
      }
      return records;
    }
    function officialPage(url, html, data = {}) {
      if (!html || !R._isOfficialPublisherUrl(url)) return null;
      // Strip navigation/footer and reference lists before status checks. Metadata is kept.
      const clean = html.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
      const titles = meta(clean, ['citation_title', 'dc.title', 'dcterms.title']);
      const ld = jsonLD(clean);
      for (const o of ld) if (o.headline || o.name) titles.push(o.headline || o.name);
      const found = titles.length ? titles.sort((a, b) => R.titleSimilarity(data.title, b) - R.titleSimilarity(data.title, a))[0]
        : first(R._htmlHeadingValues(clean).filter((t) => R.titleSimilarity(data.title, t) >= 0.90));
      if (!found || !R.verifyIdentity(data, found, meta(clean, ['citation_author', 'dc.creator', 'dcterms.creator'])).ok) return null;
      let rendered = clean;
      // Metadata-only JSON-LD sites still go through the same verified title/venue parser.
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      for (const o of ld) {
        if (R.titleSimilarity(data.title, o.headline || o.name || '') < 0.9) continue;
        let part = o.isPartOf;
        const names = [];
        for (let i = 0; part && i < 4; i++, part = part.isPartOf) if (part.name) names.push(part.name);
        for (const name of names) rendered += `<meta name="citation_conference_title" content="${esc(name)}">`;
        if (o.datePublished) rendered += `<meta name="citation_date" content="${esc(o.datePublished)}">`;
      }
      const hit = R._pageToVenueHit({ url, html: rendered, title: data.title,
        authorLastname: R.firstAuthorLastname(data), official: true, source: 'official_web', yearHint: R.itemYear(data) });
      if (!hit) return null;
      hit.title = found;
      hit.identity_verified = true;
      hit.volume = first(meta(clean, ['citation_volume'])) || null;
      hit.issue = first(meta(clean, ['citation_issue'])) || null;
      const start = first(meta(clean, ['citation_firstpage'])), end = first(meta(clean, ['citation_lastpage']));
      hit.pages = start ? [start, end].filter(Boolean).join('-') : null;
      const date = first(meta(clean, ['citation_publication_date', 'citation_date', 'dc.date.issued']));
      hit.publication_date = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(date) ? date.replace(/\//g, '-') : null;
      // Formal edition/track is retained as evidence, not conflated with main-vs-workshop.
      hit.track = first(meta(clean, ['citation_section'])) || null;
      if (/^https:\/\/ojs\.aaai\.org\/index\.php\/AAAI\/article\/view\//i.test(url)) {
        const row = R.lookupRanking('AAAI', 'conference');
        hit.venue_raw = row.canonical; hit.venue_candidates = [row.full_name]; hit.venue_type = 'conference'; hit.abbrev = 'AAAI';
      }
      return hit;
    }
    async function byURL(url, data) {
      if (!R._isOfficialPublisherUrl(url) || /\.pdf(?:$|[?#])|\/article\/view\/\d+\/\d+/i.test(url)) return null;
      const html = await get(url);
      return officialPage(url, html, data);
    }
    async function aaai(title, authorLastname = '', yearHint = null, data = {}) {
      data = { ...data, title, date: data.date || String(yearHint || ''), creators: data.creators || [{ creatorType: 'author', lastName: authorLastname }] };
      const variants = queryVariants(title);
      const head = String(title).split(/[:：]/)[0];
      const queries = unique([R.normTitle(head).split(' ').length >= 3 ? head : variants[1], variants[0]]).slice(0, options.deep ? 2 : 1);
      for (const q of queries) {
        const url = 'https://ojs.aaai.org/index.php/AAAI/search?query=' + encodeURIComponent(q);
        const html = await get(url); if (!html) continue;
        const candidates = R._htmlAnchors(html, url).filter((a) => /^https:\/\/ojs\.aaai\.org\/index\.php\/AAAI\/article\/view\/\d+(?:[?#].*)?$/i.test(a.url))
          .map((a) => ({ ...a, score: R.titleSimilarity(title, a.text) })).filter((a) => a.score >= 0.80).sort((a, b) => b.score - a.score).slice(0, 3);
        for (const candidate of candidates) { const hit = await byURL(candidate.url, data); if (hit) return hit; }
      }
      return null;
    }
    async function doi(doiValue, data) {
      const value = formalDoi(doiValue); if (!value) return null;
      const obj = await get('https://doi.org/' + value.split('/').map(encodeURIComponent).join('/'), 'json', { Accept: 'application/vnd.citationstyles.csl+json' });
      if (obj && !Array.isArray(obj)) {
        const m = { ...obj, title: Array.isArray(obj.title) ? obj.title : [obj.title || ''],
          'container-title': Array.isArray(obj['container-title']) ? obj['container-title'] : [obj['container-title'] || ''] };
        const hit = R._crossrefMessageToHit(m, 'doi_csl', data.title, R.firstAuthorLastname(data), R.itemYear(data));
        if (hit && R.verifyIdentity(data, hit.title, hit.authors).ok) return hit;
      }
      // AAAI's DOI suffix contains the OJS article id. General rule, not a paper override.
      const match = value.match(/^10\.1609\/aaai\.v\d+i\d+\.(\d+)$/i);
      return match ? byURL('https://ojs.aaai.org/index.php/AAAI/article/view/' + match[1], data) : null;
    }
    return { get, queryVariants, arxivPage, arxivById, officialPage, byURL, aaai, doi, formalDoi };
  }
  return { create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ZMDiscovery;
