/**
 * arxiv_marker_ccf2026 bootstrap for Zotero 9 and 10.
 *
 * Runtime scripts share one classic-script scope. Load order is intentional:
 * generated data -> CCF matcher -> resolver -> network/discovery/pipeline -> Zotero UI.
 */

var chromeHandle;

function install() {}

async function startup({ id, version, rootURI }, reason) {
  await Zotero.initializationPromise;

  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"].getService(
    Components.interfaces.amIAddonManagerStartup
  );
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(
    manifestURI,
    [["content", "arxivmarkerccf2026", rootURI + "content/"]]
  );

  const timers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  let urlConstructor = typeof URL !== "undefined" ? URL : Zotero.getMainWindow?.()?.URL;
  if (!urlConstructor) {
    Components.utils.importGlobalProperties(["URL"]);
    urlConstructor = URL;
  }
  const ctx = {
    rootURI,
    Zotero,
    Services,
    PathUtils,
    URL: urlConstructor,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  };
  ctx._globalThis = ctx;

  for (const script of [
    "zm-data.js",
    "ccf.js",
    "resolver.js",
    "network.js",
    "discovery.js",
    "pipeline.js",
    "zotero-http.js",
    "arxiv_marker_ccf2026.js",
  ]) {
    Services.scriptloader.loadSubScript(`${rootURI}content/scripts/${script}`, ctx, "UTF-8");
  }

  Zotero.ArxivMarkerCCF2026.rootURI = rootURI;
  Zotero.ArxivMarkerCCF2026.id = id;
  Zotero.ArxivMarkerCCF2026.version = version;
  await Zotero.ArxivMarkerCCF2026.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.ArxivMarkerCCF2026?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.ArxivMarkerCCF2026?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    Zotero.ArxivMarkerCCF2026?.cancelResolution();
    return;
  }
  await Zotero.ArxivMarkerCCF2026?.hooks.onShutdown();
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
