"use strict";
const t = (k, s) => chrome.i18n.getMessage(k, s) || k;
const $ = (id) => document.getElementById(id);
const local = chrome.storage.local;

document.querySelectorAll("[data-i18n]").forEach((e) => { e.textContent = t(e.dataset.i18n); });
document.querySelectorAll("[data-i18n-placeholder]").forEach((e) => { e.placeholder = t(e.dataset.i18nPlaceholder); });
$("version").textContent = "v" + chrome.runtime.getManifest().version;

function fmtTime(ms) { return ms ? new Date(ms).toLocaleString() : "-"; }

// ---------- the page in the current tab (layouts are kept per page address) ----------
let tab = null;
async function currentTab() {
  if (tab) return tab;
  const id = Number(new URLSearchParams(location.search).get("tab")); // tests open the popup as a page
  try { tab = id ? await chrome.tabs.get(id) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; } catch (_e) { tab = null; }
  return tab;
}
function siteKeyOf(url) { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : ""; } catch (_e) { return ""; } }
async function siteKey() { const tb = await currentTab(); return tb && tb.url ? siteKeyOf(tb.url) : ""; }
async function getSite() { const k = await siteKey(); const { sites } = await local.get("sites"); return (k && sites && sites[k]) || {}; }
async function setSite(patch) {
  const k = await siteKey(); if (!k) return;
  const { sites } = await local.get("sites");
  const next = Object.assign({}, sites); next[k] = Object.assign({}, next[k], patch);
  await local.set({ sites: next });
}
// layout in use on this page: my own, else the organization layout when it applies here
async function layoutInUse() {
  const st = await getSite();
  if (st.customized && st.userLayout) return st.userLayout;
  const { orgConfig } = await local.get("orgConfig");
  const tb = await currentTab();
  return orgConfig && orgConfig.layout && tb && PCLayout.matchesSite(orgConfig.match, tb.url) ? orgConfig.layout : null;
}
async function renderPage() {
  const tb = await currentTab();
  const key = tb && tb.url ? siteKeyOf(tb.url) : "";
  $("pageAddr").textContent = key || t("pageUnsupported");
  const st = await getSite();
  $("pageOn").hidden = !key || !!st.on;
  $("pageOff").hidden = !key || !st.on;
  let info = "";
  if (key && st.on) {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tb.id }, func: () => [document.documentElement.getAttribute("data-pc-fw") || "", document.documentElement.getAttribute("data-pc-widgets") || ""] });
      if (result) info = t("pageDetected", [result[0] || t("noFramework"), result[1] || "0"]);
    } catch (_e) { info = t("pageReload"); }
  }
  $("pageStatus").textContent = info;
}
$("pageOn").addEventListener("click", async () => {
  const tb = await currentTab();
  const key = tb && siteKeyOf(tb.url);
  if (!key) return;
  // ask for access to this site only (must happen inside the click)
  const granted = await chrome.permissions.request({ origins: [new URL(key).origin + "/*"] }).catch(() => false);
  if (!granted) { $("pageStatus").textContent = t("pageNoPermission"); return; }
  const r = await chrome.runtime.sendMessage({ type: "enableSite", tabId: tb.id, url: tb.url });
  $("pageStatus").textContent = r && r.reload ? t("pageReload") : t("pageOnDone");
  setTimeout(render, 600);
});
$("pageOff").addEventListener("click", async () => {
  const tb = await currentTab();
  await chrome.runtime.sendMessage({ type: "disableSite", url: tb.url });
  render();
});

async function render() {
  const s = await local.get(["enabled", "editMode", "orgUrl", "orgConfig", "adminToken", "adminServer", "pkgConfig"]);
  const site = await getSite();
  renderPage();
  $("enabled").checked = s.enabled !== false;
  $("editMode").checked = !!s.editMode;
  $("editMode").disabled = s.enabled === false;
  // edit mode only after an administrator login
  const admin = !!(s.adminToken && s.adminServer);
  $("editModeRow").hidden = !admin;
  $("editHint").textContent = admin ? t("editHint") : t("editAdminOnly");
  if (!admin && s.editMode) await local.set({ editMode: false });
  let managedUrl = "";
  try { managedUrl = (await chrome.storage.managed.get("orgConfigUrl")).orgConfigUrl || ""; } catch (_e) { /* none */ }
  const urlInput = $("orgUrl");
  const pkgUrl = (s.pkgConfig && s.pkgConfig.orgConfigUrl) || "";
  if (document.activeElement !== urlInput) urlInput.value = s.orgUrl || managedUrl || pkgUrl;
  const org = s.orgConfig;
  const mine = site.customized && site.userLayout;
  const tb = await currentTab();
  const orgHere = !!(org && org.layout && tb && PCLayout.matchesSite(org.match, tb.url));
  $("source").textContent = mine ? t("sourceMine") : orgHere ? t("sourceOrg", [org.name || org.version || ""]) : t("sourceOriginal");
  $("resetMine").hidden = !mine;
  const pending = mine && orgHere && org.version && org.version !== (site.baseOrgVersion || "");
  $("orgPending").hidden = !pending;
  if (pending) $("orgPendingText").textContent = t("orgNewer", [org.version]);
  const st = $("orgStatus");
  st.classList.toggle("error", !!(org && org.error));
  if (!org) st.textContent = managedUrl && !s.orgUrl ? t("orgManaged") : pkgUrl && !s.orgUrl ? t("orgPackaged") : t("orgNone");
  else if (org.error) st.textContent = t("orgError", [org.error]);
  else st.textContent = t("orgLoaded", [org.version || "-", fmtTime(org.fetchedAt)]);
  renderInterval();
}

// ---------- how often the organization default is checked again ----------
async function renderInterval() {
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type: "orgMinutes" }); } catch (_e) { /* worker restarting */ }
  if (!r) return;
  const input = $("orgMinutes");
  const own = (await local.get("orgRefreshMinutes")).orgRefreshMinutes;
  if (document.activeElement !== input) input.value = own || "";
  input.placeholder = r.source === "own" ? "" : String(r.minutes);
  $("orgMinutesNote").textContent = r.source === "own" ? t("intervalOwn") : r.source === "org" ? t("intervalOrg", [String(r.minutes)]) : t("intervalDefault", [String(r.minutes)]);
}
$("orgMinutes").addEventListener("change", async (e) => {
  const v = String(e.target.value).trim();
  const n = Math.round(Number(v));
  if (!v || !(n >= 1)) await local.remove("orgRefreshMinutes");
  else await local.set({ orgRefreshMinutes: Math.min(1440, n) });
  e.target.blur();
  renderInterval();
});

$("enabled").addEventListener("change", async (e) => {
  await local.set(e.target.checked ? { enabled: true } : { enabled: false, editMode: false });
  render();
});
$("editMode").addEventListener("change", async (e) => { await local.set({ editMode: e.target.checked }); render(); });

$("saveOrg").addEventListener("click", async () => {
  const url = $("orgUrl").value.trim();
  const btn = $("saveOrg");
  if (url) {
    let u;
    try { u = new URL(url); } catch (_e) { $("orgStatus").textContent = t("orgBadUrl"); return; }
    if (!/^https?:$/.test(u.protocol)) { $("orgStatus").textContent = t("orgBadUrl"); return; }
    // Ask for access to that server only (must happen inside the click).
    const granted = await chrome.permissions.request({ origins: [u.origin + "/*"] }).catch(() => false);
    if (!granted) { $("orgStatus").textContent = t("orgNoPermission"); return; }
  }
  btn.disabled = true;
  await local.set({ orgUrl: url });
  await chrome.runtime.sendMessage({ type: "fetchOrg" });
  btn.disabled = false;
  render();
});

$("applyOrg").addEventListener("click", async () => {
  await setSite({ customized: false });
  render();
});
$("resetMine").addEventListener("click", async () => {
  if (!confirm(t("confirmResetMine"))) return;
  await setSite({ customized: false, userLayout: null });
  render();
});

// ---------- export the layout in use (the file can be hosted as the organization default) ----------
$("exportLayout").addEventListener("click", async () => {
  const src = await layoutInUse();
  if (!src) { $("exportStatus").textContent = t("exportNothing"); return; }
  const layout = PCLayout.validate(src).layout;
  layout.version = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" }));
  a.download = "portal-customizer.json";
  document.body.append(a);
  a.click();
  a.remove();
  $("exportStatus").textContent = t("exportDone");
});

// ---------- administrator: log in to the admin server and send layouts ----------
function serverOrigin(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : ""; } catch (_e) { return ""; } }
// The admin server is the server of the organization address (popup or policy), so it is not asked for;
// "Change" opens the address field. Saved login (optional) fills the form and logs in again when the login expires.
async function autoServer() {
  const s = await local.get(["orgUrl", "pkgConfig"]);
  if (serverOrigin(s.orgUrl || "")) return serverOrigin(s.orgUrl);
  let managed = "";
  try { managed = (await chrome.storage.managed.get("orgConfigUrl")).orgConfigUrl || ""; } catch (_e) { /* none */ }
  const pkg = s.pkgConfig || {};
  return serverOrigin(managed || "") || serverOrigin(pkg.orgConfigUrl || "") || serverOrigin(pkg.adminServer || "");
}
let serverEdit = false;
async function renderAdmin() {
  const s = await local.get(["adminServer", "adminToken", "adminUser", "adminSaved"]);
  const logged = !!(s.adminServer && s.adminToken);
  $("adminBox").hidden = !logged;
  $("adminToggle").hidden = logged;
  if (logged) { $("adminLoginBox").hidden = true; $("adminWho").textContent = t("adminWho", [s.adminUser || "", s.adminServer]); }
  const auto = await autoServer();
  const saved = s.adminSaved || null;
  if (!$("adminServer").value) $("adminServer").value = auto || (saved && saved.server) || s.adminServer || "";
  const fixed = !!auto && !serverEdit && serverOrigin($("adminServer").value) === auto;
  $("adminServerAuto").hidden = !fixed;
  $("adminServer").hidden = fixed;
  if (fixed) $("adminServerHost").textContent = t("adminServerAuto", [new URL(auto).host]);
  if (saved && !$("adminUser").value) { $("adminUser").value = saved.user || ""; $("adminPass").value = saved.pass || ""; }
  $("adminRemember").checked = !!saved;
}
$("adminServerChange").addEventListener("click", (e) => { e.preventDefault(); serverEdit = true; renderAdmin().then(() => $("adminServer").focus()); });
$("adminToggle").addEventListener("click", (e) => {
  e.preventDefault();
  $("adminLoginBox").hidden = !$("adminLoginBox").hidden;
  if (!$("adminLoginBox").hidden) renderAdmin().then(() => ($("adminUser").value ? $("adminPass") : $("adminUser")).focus());
});
async function login(origin, user, pass) {
  // the admin server answers extension requests with CORS headers: no extra browser permission needed
  const r = await fetch(origin + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, password: pass, label: "extension" }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
  await local.set({ adminServer: origin, adminToken: d.token, adminUser: d.admin.name || d.admin.user });
  return d.token;
}
// a saved login takes over when the server no longer accepts the token (expired)
async function relogin() {
  const { adminSaved: sv } = await local.get("adminSaved");
  if (!sv || !sv.server || !sv.user) return "";
  try { return await login(sv.server, sv.user, sv.pass || ""); } catch (_e) { return ""; }
}
$("adminLoginBtn").addEventListener("click", async () => {
  const origin = serverOrigin($("adminServer").value.trim());
  const st = $("adminLoginStatus");
  if (!origin) { st.textContent = t("orgBadUrl"); return; }
  st.textContent = "…";
  const user = $("adminUser").value.trim(), pass = $("adminPass").value;
  try {
    await login(origin, user, pass);
    if ($("adminRemember").checked) await local.set({ adminSaved: { server: origin, user, pass } });
    else { await local.remove("adminSaved"); $("adminPass").value = ""; }
    st.textContent = "";
    serverEdit = false;
  } catch (err) { st.textContent = t("adminLoginFailed", [String(err.message || err)]); }
  renderAdmin();
});
// Enter in the id or password field logs in
for (const id of ["adminUser", "adminPass", "adminServer"]) {
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("adminLoginBtn").click(); } });
}
$("adminRemember").addEventListener("change", async (e) => { if (!e.target.checked) await local.remove("adminSaved"); });
$("adminLogout").addEventListener("click", async (e) => {
  e.preventDefault();
  const s = await local.get(["adminServer", "adminToken"]);
  fetch(s.adminServer + "/api/logout", { method: "POST", headers: { Authorization: "Bearer " + s.adminToken } }).catch(() => {});
  await local.remove(["adminToken", "adminUser"]);
  await local.set({ editMode: false });
  renderAdmin();
});
$("openConsole").addEventListener("click", async (e) => { e.preventDefault(); const s = await local.get("adminServer"); chrome.tabs.create({ url: s.adminServer + "/" }); });
$("useServerOrg").addEventListener("click", async (e) => {
  e.preventDefault();
  const s = await local.get("adminServer");
  $("orgUrl").value = s.adminServer + "/portal-customizer.json";
  $("saveOrg").click();
});
$("sendBtn").addEventListener("click", async () => {
  const st = $("sendStatus");
  const s = await local.get(["adminServer", "adminToken"]);
  const src = await layoutInUse();
  if (!src) { st.textContent = t("exportNothing"); return; }
  const layout = PCLayout.validate(src).layout;
  const name = $("sendName").value.trim();
  $("sendBtn").disabled = true; st.textContent = "…";
  try {
    const post = (token) => fetch(s.adminServer + "/api/layouts", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ name, layout, source: "extension v" + chrome.runtime.getManifest().version }) });
    let r = await post(s.adminToken);
    if (r.status === 401) { const tk = await relogin(); if (tk) r = await post(tk); }
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { await local.remove(["adminToken"]); await local.set({ editMode: false }); renderAdmin(); throw new Error(t("adminExpired")); }
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    st.textContent = t("sendDone", [d.layout.name]);
    $("sendName").value = "";
  } catch (err) { st.textContent = t("sendFailed", [String(err.message || err)]); }
  $("sendBtn").disabled = false;
});
renderAdmin();
// drop a login the server no longer accepts (expired or removed admin), which also ends edit mode
(async () => {
  const s = await local.get(["adminServer", "adminToken"]);
  if (!s.adminServer || !s.adminToken) return;
  try {
    const r = await fetch(s.adminServer + "/api/me", { headers: { Authorization: "Bearer " + s.adminToken } });
    if (r.status === 401 && !(await relogin())) { await local.remove(["adminToken", "adminUser"]); await local.set({ editMode: false }); }
    if (r.status === 401) renderAdmin();
  } catch (_e) { /* server unreachable: keep the login */ }
})();

// ---------- update row ----------
function setRow(text, state) {
  $("updateText").textContent = text;
  $("update").classList.toggle("error", state === "error");
  $("updateBtn").disabled = state !== "newer";
}
async function showUpdate() {
  const current = chrome.runtime.getManifest().version;
  const { latestVersion, checkError, helperMissing } = await local.get(["latestVersion", "checkError", "helperMissing"]);
  if (PC.isNewer(latestVersion, current)) setRow(t("updateAvailable", [latestVersion]), "newer");
  else if (checkError && !latestVersion) setRow(t("updateCheckFailed"), "error");
  else setRow(t("upToDateVersion", [current]), "latest");
  if (helperMissing && PC.isNewer(latestVersion, current)) setRow(t("updateHelperMissing"), "newer");
  let src = null;
  try { src = await chrome.runtime.sendMessage({ type: "updateSource" }); } catch (_e) { /* worker restarting */ }
  if (src) {
    const sel = $("updateSource");
    if (document.activeElement !== sel) sel.value = src.chosen || "";
    $("updateSourceNote").textContent = src.source === "github" ? t("updateFromGithubNote")
      : src.server ? t("updateFromServerNote", [new URL(src.server).host]) : t("updateNoServer");
  }
  if (checkError && !PC.isNewer(latestVersion, current)) setRow(checkError, "error");
}
$("updateSource").addEventListener("change", async (e) => {
  if (e.target.value) await local.set({ updateSource: e.target.value });
  else await local.remove("updateSource");
  await local.remove(["latestVersion", "latestZipUrl", "checkError"]);
  await chrome.runtime.sendMessage({ type: "checkUpdate" });
  showUpdate();
});
$("updateBtn").addEventListener("click", async () => {
  const btn = $("updateBtn");
  btn.disabled = true; btn.textContent = t("updating");
  const r = await chrome.runtime.sendMessage({ type: "runUpdate" });
  btn.textContent = t("updateNow");
  await showUpdate();
  if (r && r.missing) setRow(t("updateHelperMissing"), "newer");
  else if (r && !r.ok) setRow(t("updateFailed", [String(r.message || "").slice(-160)]), "error");
});
$("checkNow").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ type: "checkUpdate" });
  await showUpdate();
});

chrome.storage.onChanged.addListener((_c, area) => { if (area === "local") { render(); showUpdate(); } });
render();
showUpdate().then(() => chrome.runtime.sendMessage({ type: "checkUpdate" })).then(showUpdate);

// ---------- this installation: id, name given by an administrator, guide ----------
async function renderPcInfo() {
  const s = await local.get(["clientId", "orgConfig"]);
  const name = (s.orgConfig && s.orgConfig.clientName) || "";
  const id = (s.clientId || "").slice(0, 8);
  $("pcInfoText").textContent = t("pcInfo", [id || "-"]) + (name ? " · " + t("pcInfoName", [name]) : "");
  if (document.activeElement !== $("pcName") && !$("pcName").value) $("pcName").value = name;
}
renderPcInfo();
$("openGuide").addEventListener("click", (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html?reason=manual") }); });
// administrators can name the PC they are sitting at (shown on the admin server's installations page)
$("pcNameBtn").addEventListener("click", async () => {
  const st = $("pcNameStatus");
  const s = await local.get(["adminServer", "adminToken", "clientId"]);
  if (!s.clientId) { st.textContent = t("pcNoId"); return; }
  st.textContent = "…";
  try {
    const r = await fetch(s.adminServer + "/api/clients/" + encodeURIComponent(s.clientId), { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.adminToken }, body: JSON.stringify({ name: $("pcName").value.trim() }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    st.textContent = t("pcNameDone", [d.client.name || "-"]);
    chrome.runtime.sendMessage({ type: "fetchOrg" }).then(renderPcInfo).catch(() => {});
  } catch (err) { st.textContent = t("sendFailed", [String(err.message || err)]); }
});
