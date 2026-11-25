"use strict";
importScripts("lib/version.js", "lib/layout.js");

const NATIVE_HOST = "io.github.lisyoen.portal_customizer";
const UPDATE_ALARM = "pc-update-check";
const ORG_ALARM = "pc-org-check";
const CHECK_MINUTES = 1;
const ORG_DEFAULT_MINUTES = 60;
const t = (k, s) => chrome.i18n.getMessage(k, s) || k;

function currentVersion() { return chrome.runtime.getManifest().version; }

// ---------- settings that come with the package ----------
// config.json in the extension folder holds the connection settings of this installation (organization layout
// address, admin server, update source). It is empty in the GitHub release; the admin server writes its own
// address into it when it hands out the package (installation package and updates). The values are kept in
// storage (pkgConfig), so a later package without settings keeps them. Order: the user's own setting, then the
// browser policy, then the package settings.
function httpUrl(u) { try { const x = new URL(String(u || "")); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (_e) { return ""; } }
let pkgLoaded = null;
function loadPackagedConfig() {
  if (!pkgLoaded) pkgLoaded = (async () => {
    try {
      const c = await (await fetch(chrome.runtime.getURL("config.json"), { cache: "no-store" })).json();
      const clean = { orgConfigUrl: httpUrl(c.orgConfigUrl), adminServer: originOf(c.adminServer || ""),
        updateSource: c.updateSource === "server" || c.updateSource === "github" ? c.updateSource : "", siteName: String(c.siteName || "").slice(0, 60) };
      if (clean.orgConfigUrl || clean.adminServer) await chrome.storage.local.set({ pkgConfig: clean });
    } catch (_e) { /* no or broken config.json: keep what was stored */ }
  })();
  return pkgLoaded;
}
async function packagedConfig() {
  await loadPackagedConfig();
  return (await chrome.storage.local.get("pkgConfig")).pkgConfig || {};
}

// ---------- extension self-update (same flow as the updater helper expects) ----------
async function applyUpdateState(latest, extra) {
  const newer = PC.isNewer(latest, currentVersion());
  await chrome.storage.local.set(Object.assign({ latestVersion: latest || null, updateAvailable: newer }, extra || {}));
  if (newer) {
    await chrome.action.setBadgeText({ text: "NEW" });
    await chrome.action.setBadgeBackgroundColor({ color: "#E8364F" });
    await chrome.action.setTitle({ title: t("badgeTitleUpdate", [latest]) });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: t("extName") });
  }
  return { latest, current: currentVersion(), newer };
}

// Where updates come from (popup choice): the organization's admin server (it hosts the extension package
// uploaded on its 확장 배포 page; the server of the organization address, else the logged-in admin server) or the
// internet (GitHub releases; publish/latest.json on the main branch names the newest release package).
// Automatic: the admin server when one is known, else GitHub.
const GITHUB_REPO = "lisyoen/portal-customizer";
const GITHUB_LATEST = "https://raw.githubusercontent.com/" + GITHUB_REPO + "/main/publish/latest.json";
function originOf(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : ""; } catch (_e) { return ""; } }
async function updateSource() {
  const { adminServer, updateSource: own } = await chrome.storage.local.get(["adminServer", "updateSource"]);
  const pkg = await packagedConfig();
  const server = originOf((await orgUrl()).url) || originOf(adminServer || "") || originOf(pkg.adminServer || "");
  const chosen = own === "github" || own === "server" ? own : pkg.updateSource;
  const pick = chosen === "github" || chosen === "server" ? chosen : "";
  const source = pick || (server ? "server" : "github");
  if (source === "github") return { source, chosen: pick, server, latestUrl: GITHUB_LATEST };
  return { source, chosen: pick, server, latestUrl: server ? server + "/ext/latest.json" : "" };
}

async function checkForUpdate() {
  const src = await updateSource();
  try {
    if (!src.latestUrl) throw new Error(t("updateNoServer"));
    const res = await fetch(src.latestUrl + "?t=" + Date.now(), { cache: "no-store" });
    if (res.status === 404) throw new Error(t(src.source === "github" ? "updateNoGithub" : "updateNoPackage"));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const remote = await res.json();
    if (!/^\d+\.\d+\.\d+$/.test(String(remote.version || ""))) throw new Error("bad version");
    return await applyUpdateState(remote.version, { checkedAt: Date.now(), checkError: null, updateFrom: src.source, latestZipUrl: remote.zipUrl ? new URL(remote.zipUrl, src.latestUrl).href : "" });
  } catch (err) {
    const { latestVersion } = await chrome.storage.local.get("latestVersion");
    const r = await applyUpdateState(latestVersion);
    await chrome.storage.local.set({ checkError: String((err && err.message) || err), updateFrom: src.source });
    return Object.assign(r, { error: String((err && err.message) || err) });
  }
}

function notify(message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: t("extName"), message });
}

function nativeUpdate(version, zipUrl) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "update", version: version || "", zipUrl: zipUrl || "" }, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, missing: true, message: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, message: "no response" });
    });
  });
}

async function runUpdate() {
  await chrome.action.setBadgeText({ text: "..." });
  const { latestVersion, latestZipUrl } = await chrome.storage.local.get(["latestVersion", "latestZipUrl"]);
  // always hand the helper the admin server's package address, so it never falls back to GitHub
  if (!latestZipUrl) { await applyUpdateState(latestVersion); return { ok: false, message: t("updateNoPackage") }; }
  const r = await nativeUpdate(latestVersion, latestZipUrl);
  if (r.missing) {
    await chrome.storage.local.set({ helperMissing: true });
    await applyUpdateState(latestVersion);
    return r;
  }
  await chrome.storage.local.set({ helperMissing: false });
  if (!r.ok) { await applyUpdateState(latestVersion); return r; }
  if (r.upToDate && !(r.mode === "zip" && PC.isNewer(r.after, currentVersion()))) { await checkForUpdate(); return r; }
  await chrome.storage.local.set({ justUpdatedFrom: currentVersion() });
  setTimeout(() => chrome.runtime.reload(), 300);
  return Object.assign(r, { reloading: true });
}

// ---------- organization default layout ----------
async function orgUrl() {
  const { orgUrl: own } = await chrome.storage.local.get("orgUrl");
  if (own) return { url: own, managed: false };
  try {
    const m = await chrome.storage.managed.get("orgConfigUrl");
    if (m && m.orgConfigUrl) return { url: m.orgConfigUrl, managed: true };
  } catch (_e) { /* no policy */ }
  const pkg = await packagedConfig();
  if (pkg.orgConfigUrl) return { url: pkg.orgConfigUrl, managed: false, packaged: true };
  return { url: "", managed: false };
}

// Plugins of the admin server (portal-customizer.json "plugins"): their panels (pages on the admin server) and
// connectors (declarative requests the content script runs inside the portal tab, content/bridge.js).
function pluginList(list) {
  if (!Array.isArray(list)) return [];
  const http = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (_e) { return ""; } };
  const out = [];
  for (const p of list.slice(0, 30)) {
    if (!p || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(String(p.id || "")) || !http(p.base)) continue;
    const panels = (Array.isArray(p.panels) ? p.panels : []).filter((x) => x && /^[\w-]{1,40}$/.test(String(x.name || "")) && http(x.url)).slice(0, 30)
      .map((x) => ({ name: x.name, title: String(x.title || x.name).slice(0, 60), url: http(x.url), height: Math.min(4000, Math.max(80, Number(x.height) || 360)),
        sites: Array.isArray(x.sites) ? x.sites.map(String).slice(0, 20) : [] }));
    const connectors = (Array.isArray(p.connectors) ? p.connectors : []).filter((c) => c && /^[\w.-]{1,60}$/.test(String(c.id || "")) && Array.isArray(c.sites)).slice(0, 200);
    if (JSON.stringify(connectors).length > 400000) continue;
    out.push({ id: p.id, name: String(p.name || p.id).slice(0, 80), version: String(p.version || "").slice(0, 20), base: http(p.base), panels, connectors });
  }
  return out;
}

async function fetchOrg() {
  const { url, managed } = await orgUrl();
  const { orgConfig: prev } = await chrome.storage.local.get("orgConfig");
  if (!url) {
    if (prev) await chrome.storage.local.remove("orgConfig");
    return { ok: true, empty: true };
  }
  try {
    const clientId = await ensureClientId();
    // anonymous install id and version: lets the admin server count users (no personal data)
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "_kc=" + Date.now(), { cache: "no-store", headers: { "X-PC-Client": clientId, "X-PC-Version": currentVersion() } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const r = PCLayout.validate(JSON.parse(text));
    if (!r.ok) throw new Error(r.error);
    const version = r.layout.version || PCLayout.hash(text);
    const raw = JSON.parse(text);
    const orgConfig = { url, managed, version, name: r.layout.name || "", layout: r.layout, match: siteList(raw.match), site: siteRuleOf(raw.site) || r.layout.site || null, fetchedAt: Date.now(), error: null,
      notice: String(raw.notice || "").slice(0, 2000), clientName: String((raw.client && raw.client.name) || "").slice(0, 60), plugins: pluginList(raw.plugins) };
    // Avoid storage churn (and page re-renders) when nothing changed.
    if (!prev || prev.version !== version || prev.url !== url || prev.error || (prev.layout && prev.layout.refreshMinutes) !== r.layout.refreshMinutes
      || JSON.stringify(prev.match) !== JSON.stringify(orgConfig.match) || JSON.stringify(prev.site) !== JSON.stringify(orgConfig.site)
      || (prev.notice || "") !== orgConfig.notice || (prev.clientName || "") !== orgConfig.clientName
      || JSON.stringify(prev.plugins || []) !== JSON.stringify(orgConfig.plugins)) await chrome.storage.local.set({ orgConfig });
    else await chrome.storage.local.set({ orgCheckedAt: Date.now() });
    await scheduleOrg();
    return { ok: true, version };
  } catch (err) {
    const message = String((err && err.message) || err);
    const orgConfig = Object.assign({}, prev && prev.url === url ? prev : { url, managed, layout: null, version: "" }, { error: message, fetchedAt: Date.now() });
    await chrome.storage.local.set({ orgConfig });
    return { ok: false, error: message };
  }
}

// Pages the organization layout applies to (address prefixes) and the widget rule saved with the layout
// (container + level, picked by an administrator in edit mode).
function siteList(v) {
  const items = Array.isArray(v) ? v : String(v || "").split(/[\s,]+/);
  return items.map((x) => String(x).trim()).filter((x) => /^https?:\/\//i.test(x)).slice(0, 50);
}
function siteRuleOf(v) { return PCLayout.widgetRule(v); }

// ---------- where the content scripts run ----------
// Only on pages the user turned on (popup "Customize this page") and pages named by the organization layout,
// and only where the user granted access to that site.
const CONTENT_JS = ["lib/layout.js", "lib/detect.js", "content/media.js", "content/bridge.js", "content/content.js"];
const CONTENT_CSS = ["content/content.css"];
function originPattern(href) {
  const m = /^(https?):\/\/([^/?#]+)/i.exec(String(href || ""));
  return m ? m[1].toLowerCase() + "://" + m[2].replace(/:\d+$/, "").toLowerCase() + "/*" : "";
}
async function wantedPatterns() {
  const { sites, orgConfig } = await chrome.storage.local.get(["sites", "orgConfig"]);
  const pats = new Set();
  for (const [k, v] of Object.entries(sites || {})) if (v && v.on) pats.add(originPattern(k));
  for (const m of (orgConfig && orgConfig.match) || []) pats.add(originPattern(m));
  pats.delete("");
  const granted = [];
  for (const p of pats) { try { if (await chrome.permissions.contains({ origins: [p] })) granted.push(p); } catch (_e) { /* bad pattern */ } }
  return granted;
}
let syncing = Promise.resolve();
function syncScripts() {
  syncing = syncing.then(async () => {
    const matches = await wantedPatterns();
    const ids = (await chrome.scripting.getRegisteredContentScripts()).map((x) => x.id).filter((id) => id.startsWith("pc-"));
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
    if (!matches.length) return [];
    await chrome.scripting.registerContentScripts([
      // early: hides the widget area of a page with a saved layout until the layout is mounted (no flash of the original)
      { id: "pc-early", matches, js: ["lib/layout.js", "content/early.js"], runAt: "document_start", persistAcrossSessions: true },
      { id: "pc-probe", matches, js: ["content/probe.js"], world: "MAIN", runAt: "document_end", persistAcrossSessions: true },
      { id: "pc-content", matches, js: CONTENT_JS, css: CONTENT_CSS, runAt: "document_end", persistAcrossSessions: true },
    ]);
    return matches;
  }).catch((e) => { console.warn("syncScripts", e); return []; });
  return syncing;
}
// Turn a page on (after the popup got the site permission) and start at once without a reload.
async function enableSite(tabId, url) {
  const key = (() => { try { const u = new URL(url); return u.origin + u.pathname; } catch (_e) { return ""; } })();
  if (!key) return { ok: false };
  const { sites } = await chrome.storage.local.get("sites");
  const next = Object.assign({}, sites);
  next[key] = Object.assign({}, next[key], { on: true });
  await chrome.storage.local.set({ sites: next });
  await syncScripts();
  try {
    const [{ result: loaded } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!window.__portalCustomizerLoaded });
    if (!loaded) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content/probe.js"], world: "MAIN" });
      await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS });
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS });
    }
  } catch (e) { return { ok: true, reload: true, error: String(e && e.message || e) }; }
  return { ok: true };
}
async function disableSite(url) {
  const key = (() => { try { const u = new URL(url); return u.origin + u.pathname; } catch (_e) { return ""; } })();
  const { sites } = await chrome.storage.local.get("sites");
  const next = Object.assign({}, sites);
  if (next[key]) next[key] = Object.assign({}, next[key], { on: false });
  await chrome.storage.local.set({ sites: next, editMode: false });
  await syncScripts();
  return { ok: true };
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("sites" in changes || "orgConfig" in changes)) {
    const a = changes.sites, o = changes.orgConfig;
    const onKeys = (v) => JSON.stringify(Object.entries(v || {}).filter(([, x]) => x && x.on).map(([k]) => originPattern(k)).sort());
    if ((a && onKeys(a.oldValue) !== onKeys(a.newValue)) || (o && JSON.stringify((o.oldValue || {}).match) !== JSON.stringify((o.newValue || {}).match))) syncScripts();
  }
});
chrome.permissions.onAdded.addListener(() => syncScripts());
chrome.permissions.onRemoved.addListener(() => syncScripts());

// Organization check interval: the user's own value in the popup, else the one the admin put in
// portal-customizer.json (refreshMinutes), else 60 minutes.
async function orgMinutes() {
  const { orgRefreshMinutes, orgConfig } = await chrome.storage.local.get(["orgRefreshMinutes", "orgConfig"]);
  const own = PCLayout.refreshMinutes(orgRefreshMinutes);
  if (own) return { minutes: own, source: "own" };
  const org = PCLayout.refreshMinutes(orgConfig && orgConfig.layout && orgConfig.layout.refreshMinutes);
  if (org) return { minutes: org, source: "org" };
  return { minutes: ORG_DEFAULT_MINUTES, source: "default" };
}
async function scheduleOrg() {
  const { minutes } = await orgMinutes();
  const a = await chrome.alarms.get(ORG_ALARM);
  if (!a || a.periodInMinutes !== minutes) await chrome.alarms.create(ORG_ALARM, { periodInMinutes: minutes });
  return minutes;
}
function schedule() {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: CHECK_MINUTES });
  scheduleOrg();
}

// anonymous id of this installation: lets the admin server count installations and name each PC
async function ensureClientId() {
  let { clientId } = await chrome.storage.local.get("clientId");
  if (!clientId) { clientId = crypto.randomUUID(); await chrome.storage.local.set({ clientId }); }
  return clientId;
}
// Guide page after install and after an update (at most once a week): how to close Edge's developer mode
// warning without turning the extension off, and how to turn it back on.
const WELCOME_EVERY = 7 * 864e5;
async function openWelcome(reason) {
  const { welcomeShownAt } = await chrome.storage.local.get("welcomeShownAt");
  if (reason === "update" && welcomeShownAt && Date.now() - welcomeShownAt < WELCOME_EVERY) return;
  await chrome.storage.local.set({ welcomeShownAt: Date.now() });
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html?reason=" + reason) });
}

loadPackagedConfig();
chrome.runtime.onInstalled.addListener(async (details) => {
  schedule();
  await loadPackagedConfig();
  await ensureClientId();
  if (details.reason === "install" || details.reason === "update") openWelcome(details.reason).catch(() => {});
  if (details.reason === "install") await chrome.storage.local.set({ enabled: true, editMode: false, sites: {} });
  await syncScripts();
  const { justUpdatedFrom } = await chrome.storage.local.get("justUpdatedFrom");
  if (justUpdatedFrom && justUpdatedFrom !== currentVersion()) notify(t("updatedTo", [currentVersion()]));
  await chrome.storage.local.remove("justUpdatedFrom");
  await checkForUpdate();
  await fetchOrg();
});

chrome.runtime.onStartup.addListener(async () => { schedule(); await syncScripts(); await checkForUpdate(); await fetchOrg(); });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPDATE_ALARM) checkForUpdate();
  if (a.name === ORG_ALARM) fetchOrg();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "checkUpdate") { checkForUpdate().then(sendResponse); return true; }
  if (msg.type === "updateSource") { updateSource().then(sendResponse); return true; }
  if (msg.type === "runUpdate") { runUpdate().then(sendResponse); return true; }
  if (msg.type === "fetchOrg") { fetchOrg().then(sendResponse); return true; }
  if (msg.type === "enableSite") { enableSite(msg.tabId, msg.url).then(sendResponse); return true; }
  if (msg.type === "disableSite") { disableSite(msg.url).then(sendResponse); return true; }
  if (msg.type === "syncScripts") { syncScripts().then(sendResponse); return true; }
  if (msg.type === "orgMinutes") { scheduleOrg().then(() => orgMinutes()).then(sendResponse); return true; }
  return false;
});
