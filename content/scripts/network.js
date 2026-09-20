// Bounded, cancellable HTTP scheduling shared by every resolver. No Zotero dependency.
// Credentials are fingerprinted, never persisted as URLs or printed in diagnostics.
var ZMNetwork = (() => {
  const VERSION = 1;
  const now = () => Date.now();
  const later = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  function fingerprint(s) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ s.charCodeAt(i); }
    return `${s.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
  }
  function safeURL(s) {
    return String(s).replace(/([?&](?:api_key|apikey|secretkey|token|key)=)[^&#]*/gi, '$1[REDACTED]');
  }
  function httpURL(s) {
    // Works in Zotero classic subscripts as well as Node; do not require a DOM URL global.
    const m = String(s).match(/^https:\/\/([^/?#]+)([^#]*)/i);
    if (!m || !/^(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/i.test(m[1]) || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(m[1])) return null;
    return { host: m[1].toLowerCase(), url: 'https://' + m[1].toLowerCase() + (m[2] || '/') };
  }
  function family(host) {
    if (/^(?:www\.)?dblp\.(?:org|uni-trier\.de)$/.test(host)) return 'dblp';
    if (host === 'arxiv.org' || host === 'export.arxiv.org') return 'arxiv';
    if (/(?:^|\.)duckduckgo\.com$/.test(host)) return 'duckduckgo';
    return host;
  }
  function retryAfter(headers) {
    const value = headers && (headers['retry-after'] || headers['Retry-After']);
    if (!value) return 60000;
    const seconds = Number(value);
    return Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now() || 60000);
  }
  function createCache(snapshot) {
    const map = new Map();
    if (snapshot && snapshot.schema === VERSION && Array.isArray(snapshot.entries)) {
      for (const e of snapshot.entries.slice(-500)) if (e && e.key && e.expires > now() && e.response) map.set(e.key, e);
    }
    function snapshotOut() {
      const entries = []; let bytes = 0;
      for (const e of [...map.values()].reverse()) {
        if (e.expires <= now()) continue;
        const n = JSON.stringify(e).length * 2;
        if (n > 600000 || bytes + n > 8 * 1024 * 1024) continue;
        bytes += n; entries.unshift(e);
        if (entries.length >= 500) break;
      }
      return { schema: VERSION, entries };
    }
    return {
      get(key) { const e = map.get(key); if (!e || e.expires <= now()) { map.delete(key); return null; } map.delete(key); map.set(key, e); return e.response; },
      put(key, response, ttl) { if (JSON.stringify(response).length > 300000) return; map.delete(key); map.set(key, { key, response, expires: now() + ttl }); if (map.size > 500) map.delete(map.keys().next().value); },
      clear() { map.clear(); }, snapshot: snapshotOut,
    };
  }
  function create(options = {}) {
    if (typeof options.request !== 'function') throw new Error('Missing HTTP adapter');
    const raw = options.request;
    const cache = options.cache || createCache();
    const limit = Math.max(1, Math.min(8, Number(options.concurrency) || 6));
    const requestMs = Math.max(10, Number(options.requestTimeoutMs) || 8000);
    const debug = options.debug || (() => {});
    const hosts = new Map(), inFlight = new Map(), jobs = new Set();
    let active = 0, closed = false;
    const stats = { requests: 0, cacheHits: 0, deduplicated: 0, timeouts: 0, rateLimited: 0, circuitSkips: 0, cancelled: 0, maxActive: 0 };
    function state(host) {
      const f = family(host);
      if (!hosts.has(f)) hosts.set(f, { active: 0, next: 0, failures: 0, until: 0 });
      return hosts.get(f);
    }
    function interval(host) {
      if (options.minIntervalMs !== undefined) return Number(options.minIntervalMs); // deterministic test adapter only
      const f = family(host);
      if (f === 'arxiv') return 3100;
      if (f === 'dblp' || f === 'api.semanticscholar.org') return 1100;
      if (f === 'duckduckgo') return 1500;
      return 300;
    }
    function failure(reason, originalStatus = 0) { return { status: 499, originalStatus, terminal: true, reason, data: null, text: '' }; }
    function context(ms = 45000, maxRequests = 28, parent = null) {
      const ctx = { deadline: Math.min(now() + ms, parent ? parent.deadline : Infinity), remaining: maxRequests, parent, cancelled: false, events: [] };
      ctx.cancel = () => { ctx.cancelled = true; for (const job of jobs) job.prune(); };
      return ctx;
    }
    function dead(ctx) {
      return closed || !!(options.token && options.token.cancelled) || !!(ctx && (ctx.cancelled || now() >= ctx.deadline || (ctx.parent && dead(ctx.parent))));
    }
    function ttl(response, url) {
      if (response.status === 404) return 15 * 60 * 1000;
      const d = response.data;
      if (d === null || (Array.isArray(d) && (!d.length || d.every((v) => v == null)))) return 15 * 60 * 1000;
      if (d && typeof d === 'object' && (d.total === 0 || (Array.isArray(d.notes) && !d.notes.length) ||
          (d.message && d.message['total-results'] === 0) || (d.result && d.result.hits && Number(d.result.hits['@total']) === 0))) return 15 * 60 * 1000;
      if (/\/works\/10\.|\/article\/view\/|\/v\d+\/[^/?]+\.html/.test(url)) return 7 * 86400000;
      if (/arxiv\.org\/(?:api\/query|abs\/)/.test(url)) return 86400000;
      return 6 * 3600000;
    }
    async function perform(job, parsed, method, opts) {
      const h = state(parsed.host);
      while (true) {
        job.prune();
        if (!job.waiters.size) return failure('cancelled');
        if (h.until > now()) { stats.circuitSkips++; return failure('circuit-open'); }
        if (active < limit && h.active < 1 && now() >= h.next) break;
        await later(Math.min(35, Math.max(1, h.next - now())));
      }
      active++; h.active++; h.next = now() + interval(parsed.host);
      stats.maxActive = Math.max(stats.maxActive, active); stats.requests++;
      const started = now();
      let timer, poll, abort = () => {}, aborted = false;
      const doAbort = () => { aborted = true; try { abort(); } catch (_) {} };
      try {
        const maxDeadline = Math.max(...[...job.waiters].map((w) => w.ctx ? w.ctx.deadline : now() + requestMs));
        const timeout = Math.max(1, Math.min(requestMs, opts.timeout || requestMs, maxDeadline - now()));
        const stop = new Promise((resolve) => {
          timer = setTimeout(() => { stats.timeouts++; doAbort(); resolve(failure('timeout')); }, timeout);
          poll = setInterval(() => { job.prune(); if (!job.waiters.size) { doAbort(); resolve(failure('cancelled')); } }, 25);
        });
        const result = await Promise.race([
          Promise.resolve().then(() => raw(method, parsed.url, { ...opts, timeout,
            registerAbort(fn) { abort = fn; if (aborted) doAbort(); },
          })).catch(() => failure('network-error')),
          stop,
        ]);
        job.prune();
        if (!job.waiters.size) return failure('cancelled');
        const status = Number(result && result.status) || 0;
        if (status === 429 || status === 403) {
          h.until = now() + (status === 429 ? retryAfter(result.headers) : 60000);
          stats.rateLimited += status === 429 ? 1 : 0;
        } else if (status === 0 || status >= 500 || (result && ['network-error', 'timeout'].includes(result.reason))) {
          h.failures++; if (h.failures >= 2) h.until = now() + 45000;
        } else if (status >= 200 && status < 300) h.failures = 0;
        const response = status === 200 || status === 404 ? { status, data: result.data ?? null,
          text: typeof result.data === 'string' ? '' : result.text || '', headers: result.headers || {}, responseURL: safeURL(result.responseURL || parsed.url) }
          : failure((result && result.reason) || `http-${status}`, status);
        if (status === 200 || status === 404) cache.put(job.key, response, ttl(response, parsed.url));
        debug(`HTTP ${parsed.host} status=${status} ${now() - started}ms${response.reason ? ' ' + response.reason : ''}`);
        const notified = new Set();
        for (const w of job.waiters) for (let c = w.ctx; c; c = c.parent) {
          if (notified.has(c)) continue; notified.add(c);
          c.events.push({ host: parsed.host, status, elapsed_ms: now() - started, reason: response.reason || null });
        }
        return response;
      } finally { clearTimeout(timer); clearInterval(poll); active--; h.active--; }
    }
    async function request(ctx, method, url, opts = {}) {
      const parsed = httpURL(url);
      if (!parsed) return failure('unsafe-url');
      if (dead(ctx)) return failure('cancelled-or-deadline');
      const key = fingerprint(JSON.stringify([method, parsed.url, opts.body || '', opts.responseType || 'json', Object.entries(opts.headers || {}).sort()]));
      if (!options.forceRefresh) {
        const found = cache.get(key);
        if (found) { stats.cacheHits++; return found; }
      }
      for (let c = ctx; c; c = c.parent) if (c.remaining <= 0) return failure('request-budget');
      for (let c = ctx; c; c = c.parent) c.remaining--;
      let job = inFlight.get(key);
      if (!job) {
        job = { key, waiters: new Set(), prune() {
          for (const w of this.waiters) if (dead(w.ctx)) { this.waiters.delete(w); stats.cancelled++; w.resolve(failure('cancelled-or-deadline')); }
        } };
        inFlight.set(key, job); jobs.add(job);
        // Begin on the next microtask so the first caller has registered its waiter.
        Promise.resolve().then(() => perform(job, parsed, method, opts)).then((r) => {
          for (const w of job.waiters) w.resolve(dead(w.ctx) ? failure('cancelled-or-deadline') : r);
        }).catch(() => { for (const w of job.waiters) w.resolve(failure('adapter-error')); }).finally(() => { job.waiters.clear(); jobs.delete(job); inFlight.delete(key); });
      } else stats.deduplicated++;
      return new Promise((resolve) => { job.waiters.add({ ctx, resolve }); });
    }
    function scoped(ctx) {
      const fn = (method, url, opts) => request(ctx, method, url, opts);
      fn.managed = true;
      fn.context = ctx;
      fn.isStopped = () => dead(ctx);
      return fn;
    }
    return { context, scoped, stats, cache, dead,
      close() { closed = true; for (const j of jobs) j.prune(); },
      hostStates: hosts,
    };
  }
  return { create, createCache, fingerprint, safeURL, httpURL };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ZMNetwork;
