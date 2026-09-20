// 0.7: staged discovery with a shared bounded HTTP pool, lazy batch lookups and no
// global slow-source barrier. Runtime results are still confirmed in the review dialog.
var ZMFastPipeline = (() => {
  function deps() {
    return {
      Net: typeof ZMNetwork !== 'undefined' ? ZMNetwork : require('./network.js'),
      Discovery: typeof ZMDiscovery !== 'undefined' ? ZMDiscovery : require('./discovery.js'),
    };
  }
  async function resolve(R, items, opts = {}) {
    const { Net, Discovery } = deps();
    const deep = !!opts.exhaustive;
    const perItemMs = Number(opts.itemTimeoutMs) || (deep ? 90000 : 45000);
    const sourceMs = Number(opts.sourceTimeoutMs) || (deep ? 16000 : 10000);
    const token = opts.token || { cancelled: false };
    const runtime = Net.create({ request: opts.request || (async () => ({ status: 404, data: null })),
      cache: opts.cache, token, forceRefresh: !!opts.forceRefresh,
      concurrency: opts.httpConcurrency || 6, requestTimeoutMs: opts.requestTimeoutMs || 8000,
      minIntervalMs: opts.minIntervalMs, debug: opts.debug,
    });
    const allIDs = [...new Set(items.map((i) => R.extractArxivId(i.data || {})).filter(Boolean))];
    const batches = new Map(), stopBatches = new Set();
    const debug = opts.debug || (() => {});
    const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    function provider(key, request) {
      if (own(opts, key)) return opts[key];
      if (!opts.request) return null;
      const sleep = (ms) => request.isStopped() ? Promise.resolve() : new Promise((r) => setTimeout(r, Math.min(ms, 1000)));
      switch (key) {
        case 's2': return R.makeS2(request, opts.s2ApiKey, sleep);
        case 'arxiv': return R.makeArxiv(request, sleep);
        case 'dblp': return R.makeDBLP(request);
        case 'crossref': return R.makeCrossref(request, sleep);
        case 'openreview': return R.makeOpenReview(request, sleep);
        case 'datacite': return R.makeDataCite(request, sleep);
        case 'opencitations': return R.makeOpenCitations(request, opts.openCitationsToken, sleep);
        case 'openalex': return opts.openAlexApiKey ? R.makeOpenAlex(request, opts.openAlexApiKey, sleep) : null;
        case 'usenix': return opts.enableOfficialWeb === false ? null : R.makeUSENIX(request, sleep);
        case 'websearch': return opts.enableWebSearch === false ? null : R.makeWebSearch(request, {
          braveApiKey: opts.braveSearchApiKey, enableDuckDuckGo: opts.enableDuckDuckGo !== false,
          maxQueries: deep ? 4 : 3, maxPages: deep ? 10 : 5,
        }, sleep);
        default: return null;
      }
    }
    function batchByID(key, aid) {
      if (!aid || (own(opts, key) && !opts[key]) || (!own(opts, key) && !opts.request)) return Promise.resolve(null);
      const chunkSize = key === 'arxiv' ? 30 : 100;
      const index = Math.floor(allIDs.indexOf(aid) / chunkSize);
      const cacheKey = key + ':' + index;
      if (!batches.has(cacheKey)) {
        const ctx = runtime.context(sourceMs, 1);
        const p = provider(key, runtime.scoped(ctx));
        const ids = allIDs.slice(index * chunkSize, (index + 1) * chunkSize);
        batches.set(cacheKey, new Promise((resolveBatch) => {
          let settled = false;
          const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); ctx.cancel(); resolveBatch(value || {}); };
          const timer = setTimeout(() => finish({}), sourceMs);
          stopBatches.add(() => finish({}));
          Promise.resolve().then(() => p && p.batchByArxiv ? p.batchByArxiv(ids) : {}).then(finish, () => finish({}));
        }));
      }
      return batches.get(cacheKey).then((m) => m[aid] || null);
    }
    let finished = 0;
    async function one(it) {
      const started = Date.now(), data = it.data || {}, title = data.title || '', aid = R.extractArxivId(data);
      const lastname = R.firstAuthorLastname(data), yearHint = R.itemYear(data);
      const ctx = runtime.context(perItemMs, Number(opts.maxRequestsPerItem) || (deep ? 60 : 28));
      const hits = [], diagnostics = [], usedURLs = new Set();
      let arxivMeta = null;
      const known = R.existingVenueHit(data);
      const override = R.itemVenueOverride(data) || R.overridesGet(aid);
      function add(hit) {
        if (!hit || runtime.dead(ctx)) return;
        if (hit.title && !/^arxiv_|zotero_metadata|user_override/.test(hit.source || '')) {
          const identity = R.verifyIdentity(data, hit.title, hit.authors || []);
          if (!identity.ok) { diagnostics.push({ source: hit.source, status: 'rejected', reason: identity.reason }); return; }
        }
        if (hit.external_doi && R.isArxivDoi(hit.external_doi)) hit = { ...hit, external_doi: null };
        const row = R._hitRow(hit);
        if (row) hit = { ...hit, venue_type: row.kind };
        const key = JSON.stringify([hit.source, hit.venue_raw, hit.year, hit.external_doi, hit.evidence_url]);
        if (!hits.some((h) => h._dedup === key)) hits.push({ ...hit, _dedup: key });
      }
      add(known);
      function mergeMeta(meta) {
        if (!meta) return;
        if (meta.title && !R.verifyIdentity(data, meta.title, []).ok) return;
        arxivMeta = meta;
        for (const hit of meta.hits || []) add(hit);
      }
      function strong() {
        return hits.some((h) => h.venue_raw && h.year && !R.isNonvenue(h.venue_raw) &&
          ['crossref_doi', 'crossref_title', 'doi_csl', 'dblp', 'openreview', 'official_web', 'usenix_official', 'arxiv_journal_ref'].includes(h.source) &&
          R._hitRow(h) && (h.title_score === undefined || h.title_score === null || h.title_score >= 0.94));
      }
      function build() {
        // Fill missing fields only from the exact same venue/year. Never transfer a DOI
        // from a later journal extension to an earlier conference version.
        const [selected] = R.chooseVenue(hits);
        if (selected) for (const h of hits) {
          if (h === selected || R.canonicalOfHit(h) !== R.canonicalOfHit(selected) || h.year !== selected.year) continue;
          for (const k of ['external_doi', 'volume', 'issue', 'pages', 'publication_date']) if (!selected[k] && h[k]) selected[k] = h[k];
        }
        const res = R.resolutionFromHits(it, hits, { ...opts, arxivMeta });
        const reached = Date.now() >= ctx.deadline;
        const status = token.cancelled ? 'cancelled' : res.canonical ? 'resolved' : reached ? 'time-budget' : 'no-verified-result';
        res.diagnostics = { status, elapsed_ms: Date.now() - started, request_budget_remaining: ctx.remaining,
          sources: diagnostics, http: ctx.events.slice(0, 50) };
        if (res.canonical && !strong() && !known && !override) res.confidence = Math.min(res.confidence, 0.75);
        res.evidence.push(`diagnostic: ${status}; ${res.diagnostics.elapsed_ms}ms`);
        return res;
      }
      // Purely local corrections and explicit overrides need no network round trip.
      if (override || (known && !deep && !opts.forceRefresh)) return build();
      if (!String(title).trim() && !data.DOI) return build();
      // Each source has a child budget and cancellation scope. The losing HTTP requests
      // are aborted, not just detached Promise.race() tasks still using the connection pool.
      async function wave(label, tasks, early = true, budget = sourceMs) {
        if (runtime.dead(ctx) || !tasks.length) return;
        const children = [], pending = new Map(), begun = Date.now();
        await new Promise((resolveWave) => {
          let count = tasks.length, done = false, grace = null;
          const finish = () => {
            if (done) return; done = true; clearTimeout(timer); clearInterval(poll); clearTimeout(grace);
            for (const [name, t] of pending) diagnostics.push({ source: name, stage: label, status: runtime.dead(ctx) ? 'cancelled-or-item-deadline' : strong() && !deep ? 'stopped-after-evidence' : 'source-deadline', elapsed_ms: Date.now() - t });
            for (const c of children) c.cancel(); resolveWave();
          };
          const timer = setTimeout(finish, Math.max(1, Math.min(budget, ctx.deadline - Date.now())));
          const poll = setInterval(() => { if (runtime.dead(ctx)) finish(); }, 35);
          for (const task of tasks) {
            const child = runtime.context(budget, Number(opts.maxRequestsPerSource) || (deep ? 24 : 6), ctx);
            children.push(child);
            const req = runtime.scoped(child), t = Date.now();
            pending.set(task.name, t);
            const discover = Discovery.create(R, req, { deep });
            Promise.resolve().then(() => task.fn(req, discover)).then((value) => {
              if (done || runtime.dead(child)) return;
              pending.delete(task.name);
              if (task.metadata) mergeMeta(value); else if (Array.isArray(value)) value.forEach(add); else add(value);
              diagnostics.push({ source: task.name, stage: label, status: value ? 'returned' : 'no-result', elapsed_ms: Date.now() - t });
              if (!deep && early && strong() && grace === null) grace = setTimeout(finish, Number(opts.settleGraceMs) || 60);
            }, () => {
              pending.delete(task.name);
              if (!done) diagnostics.push({ source: task.name, stage: label, status: 'error', elapsed_ms: Date.now() - t });
            }).finally(() => { if (--count === 0) finish(); });
          }
        });
        debug(`${it.key}: stage=${label} ${Date.now() - begun}ms; candidates=${hits.filter((h) => h.venue_raw).length}`);
      }
      const sourceTask = (name, method, ...args) => ({ name: name + ':' + method,
        fn: (req) => { const p = provider(name, req); return p && p[method] ? p[method](...args) : null; } });
      const directURLs = [...new Set([data.url, ...(String(data.extra || '').match(/https:\/\/[^\s<>"']+/g) || [])].filter(Boolean))]
        .filter((u) => R._isOfficialPublisherUrl(u)).slice(0, 2);
      const formalDois = R._extractFormalDois(data, null, null);
      const initial = [];
      if (aid) {
        initial.push({ name: 'arxiv:batch', metadata: true, fn: () => batchByID('arxiv', aid) });
        initial.push({ name: 's2:batch', fn: () => batchByID('s2', aid) });
      }
      for (const url of directURLs) { usedURLs.add(url); initial.push({ name: 'official:link', fn: (_, d) => d.byURL(url, data) }); }
      if (formalDois.length) initial.push(sourceTask('crossref', 'byDoi', formalDois[0]));
      // Unlike 0.6, Crossref and DBLP are not held up by two sequential S2 searches.
      initial.push(sourceTask('crossref', 'bestByTitle', title, lastname, yearHint));
      initial.push(sourceTask('dblp', 'bestByTitle', title, lastname, yearHint, { doi: formalDois[0] }));
      await wave('primary', initial);
      if (!deep && strong()) return build();

      const second = [];
      if (aid && (!arxivMeta || !(arxivMeta.hits || []).length)) second.push({ name: 'arxiv:html', metadata: true, fn: (_, d) => d.arxivById(aid) });
      if (opts.enableOfficialWeb !== false && opts.request) second.push({ name: 'aaai:official-search', fn: (_, d) => d.aaai(title, lastname, yearHint, data) });
      second.push(sourceTask('openreview', 'bestByTitle', title, lastname, { arxivId: aid, data }));
      let discoveredDois = [...new Set([...formalDois, ...R._extractFormalDois(data, hits.find((h) => h.source === 'semantic_scholar'), arxivMeta),
        ...hits.flatMap((h) => h.related_dois || [])])].filter((d) => d && !R.isArxivDoi(d)).slice(0, 2);
      for (const doi of discoveredDois) {
        if (!formalDois.includes(doi)) second.push(sourceTask('crossref', 'byDoi', doi));
        second.push({ name: 'doi:content-negotiation', fn: (_, d) => d.doi(doi, data) });
      }
      await wave('direct-and-official', second);
      if (!deep && strong()) return build();

      const extra = [sourceTask('s2', 'bestByTitle', title, lastname, yearHint),
        sourceTask('datacite', 'bestByTitle', title, lastname, yearHint),
        sourceTask('openalex', 'bestByTitle', title, lastname, yearHint)];
      if (own(opts, 'websearch')) {
        extra.push(sourceTask('websearch', 'bestByTitle', title, lastname, yearHint, { arxivId: aid, doi: discoveredDois[0], data }));
      } else if (opts.request && opts.enableWebSearch !== false) {
        // Separate cancellation scopes: a blocked DuckDuckGo must not hold up Brave.
        for (const engine of ['brave', 'duckduckgo']) {
          if (engine === 'brave' && !opts.braveSearchApiKey) continue;
          if (engine === 'duckduckgo' && opts.enableDuckDuckGo === false) continue;
          extra.push({ name: engine + ':web', fn: (req) => R.makeWebSearch(req, {
            braveApiKey: engine === 'brave' ? opts.braveSearchApiKey : null,
            enableDuckDuckGo: engine === 'duckduckgo', maxQueries: deep ? 4 : 3, maxPages: deep ? 10 : 5,
          }).bestByTitle(title, lastname, yearHint, { arxivId: aid, doi: discoveredDois[0], data }) });
        }
      }
      const previousDois = new Set(discoveredDois);
      discoveredDois = [...new Set([...discoveredDois, ...R._extractFormalDois(data, null, arxivMeta),
        ...hits.flatMap((h) => h.related_dois || [])])].filter((d) => d && !R.isArxivDoi(d)).slice(0, 3);
      for (const doi of discoveredDois) if (!previousDois.has(doi)) {
        extra.push(sourceTask('crossref', 'byDoi', doi));
        extra.push({ name: 'doi:new-html-link', fn: (_, d) => d.doi(doi, data) });
      }
      const shortTitle = title.split(/[:：]/)[0].trim();
      if (shortTitle !== title && R.normTitle(shortTitle).split(' ').length >= 3) {
        // Query head but verify ALL candidates against the original complete title.
        extra.push({ name: 'crossref:short-title', fn: async (req) => {
          const p = provider('crossref', req); return p && p.bestByTitle ? p.bestByTitle(title, lastname, yearHint, shortTitle) : null;
        } });
      }
      for (const doi of discoveredDois) {
        extra.push(sourceTask('datacite', 'byDoi', doi), sourceTask('opencitations', 'byDoi', doi), sourceTask('openalex', 'byDoi', doi));
      }
      // Broad USENIX site search costs at most two search pages. The old blanket scan of
      // 30 program pages is no longer executed for every unresolved (e.g. AAAI) paper.
      extra.push(sourceTask('usenix', 'searchSite', title, lastname));
      await wave('expanded', extra, true, deep ? 25000 : 12000);
      if (!deep && strong()) return build();

      const last = [];
      const hints = [arxivMeta && arxivMeta.comment, arxivMeta && arxivMeta.journal_ref, data.extra,
        ...hits.map((h) => h.venue_raw)].filter(Boolean).join(' ');
      const usenixNames = ['USENIX Security', 'NSDI', 'OSDI', 'FAST', 'USENIX ATC', 'SOUPS', 'LISA', 'HotStorage', 'HotSec'];
      let hintedVenue = usenixNames.find((v) => new RegExp('(?:^|[^a-z])' + v + '(?:$|[^a-z])', 'i').test(hints));
      if (hintedVenue || deep) last.push(sourceTask('usenix', 'scanProgramPages', title, lastname,
        (arxivMeta && arxivMeta.published_year) || yearHint, { venue: hintedVenue || undefined, maxPages: deep ? 18 : 6 }));
      // Reuse official URLs discovered in source metadata (not references).
      const links = [...new Set([...(arxivMeta && arxivMeta.links || []), ...hits.map((h) => h.evidence_url)])]
        .filter((u) => u && !usedURLs.has(u) && R._isOfficialPublisherUrl(u)).slice(0, 4);
      for (const url of links) last.push({ name: 'official:metadata-link', fn: (_, d) => d.byURL(url, data) });
      await wave('targeted-followup', last, true, deep ? 25000 : 8000);
      return build();
    }
    const results = new Array(items.length); let cursor = 0;
    async function worker() {
      while (cursor < items.length && !token.cancelled) {
        const index = cursor++;
        try { results[index] = await one(items[index]); }
        catch (e) { results[index] = R.resolutionFromHits(items[index], [], opts); results[index].diagnostics = { status: 'error', message: Net.safeURL(String(e)).slice(0, 200) }; }
        finished++;
        if (opts.onProgress) opts.onProgress(results[index], { done: finished, total: items.length, stats: { ...runtime.stats } });
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.max(1, Math.min(6, Number(opts.itemConcurrency) || 3, items.length || 1)) }, worker));
      for (let i = 0; i < items.length; i++) if (!results[i]) {
        results[i] = R.resolutionFromHits(items[i], [], opts); results[i].diagnostics = { status: 'cancelled-before-start', elapsed_ms: 0 };
      }
      if (opts.onStats) opts.onStats({ ...runtime.stats });
      return results;
    } finally { for (const stop of stopBatches) stop(); runtime.close(); }
  }
  return { resolve };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ZMFastPipeline;
