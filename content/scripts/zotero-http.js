// Browser-level adapter. JSON XHR.responseText is illegal, including after HTTP 200.
var ZMHTTP = (() => {
  function headers(xhr) {
    const out = {};
    for (const key of ['retry-after', 'content-type']) {
      try { const value = xhr.getResponseHeader(key); if (value) out[key] = value; } catch (_) {}
    }
    return out;
  }
  async function request(zotero, method, url, opts = {}) {
    const responseType = opts.responseType || 'json';
    try {
      const xhr = await zotero.HTTP.request(method, url, {
        headers: opts.headers || {}, body: opts.body, responseType,
        successCodes: false, timeout: opts.timeout || 8000,
        errorDelayMax: 0, noRetryOnThrottle: true, logBodyLength: 0,
        cancellerReceiver: (cancel) => { if (opts.registerAbort) opts.registerAbort(cancel); },
      });
      const data = xhr.response;
      // Do not even probe responseText in json mode. InvalidStateError used to discard
      // every successful JSON response and trigger each provider's multi-minute retry loop.
      const rawText = responseType === 'text' ? (typeof data === 'string' ? data : xhr.responseText || '') : '';
      if (responseType === 'json' && xhr.status === 200 && data == null) {
        return { status: 499, originalStatus: 200, data: null, text: '', reason: 'invalid-json', terminal: true };
      }
      return { status: xhr.status, data: responseType === 'text' ? rawText : data, text: rawText,
        headers: headers(xhr), responseURL: xhr.responseURL || url };
    } catch (e) {
      // Error messages can contain API keys/URLs; expose only a sanitized error category.
      const status = Number(e && (e.status || e.xmlhttp && e.xmlhttp.status)) || 0;
      return { status, data: null, text: '', headers: e && e.xmlhttp ? headers(e.xmlhttp) : {},
        reason: /timeout/i.test(String(e && e.name) + ' ' + String(e && e.message)) ? 'timeout' : 'network-error' };
    }
  }
  return { request };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ZMHTTP;
