// Admin flow against a real admin server: log in from the popup, send a layout, publish it, the page shows it.
// Also renders video and HTML panels. NODE_PATH=/path/to/node_modules node tests/e2e/admin.mjs
import { chromium } from "playwright";
import { readFileSync, mkdtempSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

// test copy of the extension with site access granted up front (the popup asks the user in real use)
const ext = mkdtempSync(path.join(tmpdir(), "pc-ext-"));
cpSync(path.resolve("extension"), ext, { recursive: true });
const mf = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
mf.host_permissions = ["http://*.test/*"];
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(mf));
const PAGE = "http://plain.portal.test/home";
const data = mkdtempSync(path.join(tmpdir(), "kcadm-"));
const port = 21000 + Math.floor(Math.random() * 20000);
const server = `http://127.0.0.1:${port}`;
execFileSync(process.execPath, ["server/cli.js", "admin", "boss"], { env: { ...process.env, PC_DATA: data, PC_PASSWORD: "boss-pass-123" } });
const srv = spawn(process.execPath, ["server/server.js"], { env: { ...process.env, PC_DATA: data, PORT: String(port), PC_NO_AUTO_UPDATE: "1" }, stdio: "inherit" });
for (let i = 0; i < 50; i += 1) { try { await fetch(server + "/api/health"); break; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); } }

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "kca-")), { headless: true, channel: "chromium", viewport: { width: 1500, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
await ctx.route("http://*.test/**", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname.startsWith("/fixtures/")) return r.fulfill({ contentType: "text/css", body: readFileSync("tests/e2e" + u.pathname) });
  return r.fulfill({ contentType: "text/html", body: readFileSync("tests/e2e/fixtures/plain.html") });
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
const id = sw.url().split("/")[2];
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${id}/popup/popup.html`);
const store = (o) => popup.evaluate((x) => chrome.storage.local.set(x), o);
async function setSite(patch) {
  const { sites } = await popup.evaluate(() => chrome.storage.local.get("sites"));
  const next = Object.assign({}, sites); next[PAGE] = Object.assign({}, next[PAGE], patch);
  await store({ sites: next });
}

// a layout of my own with video + html panels
const mine = { schema: 1, columns: [{ id: "c1", width: 500, panels: [
  { id: "v1", type: "video", title: "Clip", height: 200, src: server + "/media/none.mp4", autoplay: true, muted: true, loop: true },
  { id: "h1", type: "html", title: "Notice", height: 150, html: "<b>Hello</b> <a href='https://example.com' onclick='x()'>link</a><script>window.bad=1</script><img src='javascript:x'>" }] },
  { id: "c2", flex: 1, panels: [{ id: "pp", type: "native", key: "title:Mail", title: "Mail" }] }], site: { container: "main.main > div.grid", level: 2 } };
await setSite({ on: true, userLayout: mine, customized: true });
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "syncScripts" }));
const page = await ctx.newPage();
await page.goto(PAGE);
await page.waitForSelector("#pc-root");
await page.waitForTimeout(400);
check("video panel renders a muted looping video", await page.evaluate(() => { const v = document.querySelector(".pc-video"); return !!v && v.muted && v.loop && !v.controls; }));
const html = await page.evaluate(() => document.querySelector(".pc-html").innerHTML);
check("html panel is sanitized", html.includes("<b>Hello</b>") && !html.includes("onclick") && !html.includes("script") && !html.includes("javascript") && html.includes('rel="noopener noreferrer"'), html);

// admin login from the popup (opened for the portal tab)
const tabId = await popup.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, PAGE);
await popup.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
await popup.bringToFront();
// the organization address names the admin server: it is not asked for
await store({ orgUrl: server + "/portal-customizer.json" });
await popup.reload();
await popup.waitForTimeout(300);
await popup.click("#adminToggle");
await popup.waitForTimeout(200);
check("admin server comes from the organization address", !(await popup.locator("#adminServer").isVisible()) && (await popup.locator("#adminServerAuto").innerText()).includes("127.0.0.1:" + port), await popup.locator("#adminServerAuto").innerText());
await popup.fill("#adminUser", "boss");
await popup.fill("#adminPass", "wrong-pass");
await popup.click("#adminLoginBtn");
await popup.waitForTimeout(500);
check("wrong password is refused", /로그인 실패|Login failed/.test(await popup.locator("#adminLoginStatus").innerText()));
await popup.fill("#adminPass", "boss-pass-123");
await popup.check("#adminRemember");
await popup.press("#adminPass", "Enter");
await popup.waitForSelector("#adminBox:not([hidden])", { timeout: 5000 });
check("Enter in the password field logs in", await popup.locator("#sendBtn").isVisible());
const savedLogin = (await popup.evaluate(() => chrome.storage.local.get("adminSaved"))).adminSaved;
check("save login keeps the server and account", savedLogin && savedLogin.server === server && savedLogin.user === "boss" && savedLogin.pass === "boss-pass-123", JSON.stringify(savedLogin && { s: savedLogin.server, u: savedLogin.user }));
// an expired login is renewed with the saved account
await store({ adminToken: "expired-token" });
await popup.reload();
await popup.waitForTimeout(800);
const renewed = (await popup.evaluate(() => chrome.storage.local.get("adminToken"))).adminToken;
check("expired login is renewed with the saved account", renewed && renewed !== "expired-token" && await popup.locator("#sendBtn").isVisible(), String(renewed).slice(0, 8));
await popup.fill("#sendName", "Spring layout");
await popup.click("#sendBtn");
await popup.waitForTimeout(800);
check("send to server", /Spring layout/.test(await popup.locator("#sendStatus").innerText()), await popup.locator("#sendStatus").innerText());
const token = (await popup.evaluate(() => chrome.storage.local.get("adminToken"))).adminToken;
const list = await (await fetch(server + "/api/layouts", { headers: { Authorization: "Bearer " + token } })).json();
check("server has the layout as default", list.layouts.length === 1 && list.layouts[0].name === "Spring layout" && list.layouts[0].isDefault);
const pub = await (await fetch(server + "/portal-customizer.json")).json();
check("published json has the video and html panels", pub.columns[0].panels.map((p) => p.type).join() === "video,html");

// the admin names the pages the layout applies to
const putS = await fetch(server + "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ siteMatch: "http://plain.portal.test/home\nhttps://*.example.com/", siteRule: { pause: ".modal-open" } }) });
const pubS = await (await fetch(server + "/portal-customizer.json")).json();
check("published json carries the pages and the widget rule sent with the layout (no server selectors)", putS.ok && pubS.match.length === 2 && pubS.match[0] === PAGE && pubS.site && pubS.site.level === 2 && pubS.site.container === "main.main > div.grid" && !("pause" in pubS.site), JSON.stringify([pubS.match, pubS.site]));
const badS = await fetch(server + "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ siteMatch: "ftp://x" }) });
check("page addresses must be http(s)", badS.status === 400);
// staff side: use the server as organization default
await setSite({ customized: false });
await store({ orgUrl: server + "/portal-customizer.json" });
const fr = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "fetchOrg" }));
check("extension loads the published layout", fr && fr.ok, JSON.stringify(fr));
// check interval: the admin's value from portal-customizer.json (server default 5), overridden by the popup value
let iv = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "orgMinutes" }));
let al = await popup.evaluate(() => chrome.alarms.get("pc-org-check"));
check("org check interval comes from portal-customizer.json", iv.source === "org" && iv.minutes === 5 && al && al.periodInMinutes === 5, JSON.stringify([iv, al && al.periodInMinutes]));
await popup.reload();
await popup.waitForSelector("#orgMinutes");
await popup.waitForFunction(() => !!document.getElementById("orgMinutes").placeholder, null, { timeout: 5000 }).catch(() => {});
const ph = await popup.getAttribute("#orgMinutes", "placeholder");
await popup.fill("#orgMinutes", "2");
await popup.press("#orgMinutes", "Enter");
await popup.locator("#orgMinutes").evaluate((e) => e.dispatchEvent(new Event("change")));
await popup.waitForTimeout(300);
iv = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "orgMinutes" }));
al = await popup.evaluate(() => chrome.alarms.get("pc-org-check"));
check("popup interval overrides the organization value", ph === "5" && iv.source === "own" && iv.minutes === 2 && al.periodInMinutes === 2, JSON.stringify([ph, iv, al && al.periodInMinutes]));
await popup.fill("#orgMinutes", "");
await popup.locator("#orgMinutes").evaluate((e) => e.dispatchEvent(new Event("change")));
await popup.waitForTimeout(300);
iv = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "orgMinutes" }));
check("clearing the popup value follows the organization again", iv.source === "org" && iv.minutes === 5, JSON.stringify(iv));
const stats = await (await fetch(server + "/api/stats?days=1", { headers: { Authorization: "Bearer " + token } })).json();
check("server counts the extension as a user", stats.users === 1, JSON.stringify(stats.versions));
await page.bringToFront();
await page.waitForTimeout(500);
check("page shows the organization layout", (await page.locator(".pc-video").count()) === 1);

// admin console loads
const con = await ctx.newPage();
await con.goto(server + "/");
await con.fill("input[type=text]", "boss");
await con.fill("input[type=password]", "boss-pass-123");
await con.click("button.primary");
await con.waitForSelector("text=Spring layout", { timeout: 5000 });
check("admin console lists the layout", true);
// copy the distribution address on a plain-http page (no Clipboard API): execCommand fallback
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server });
await con.evaluate(() => { Object.defineProperty(window, "isSecureContext", { get: () => false, configurable: true }); });
await con.click("#copyPub");
await con.waitForTimeout(300);
const copied = await con.evaluate(() => navigator.clipboard.readText());
check("copy button works without the Clipboard API (http)", /^http:\/\/[^/]+\/portal-customizer\.json$/.test(copied), copied);
await con.click("a:has-text('Spring layout')");
await con.waitForSelector(".col-card");
check("layout editor shows columns and panels", (await con.locator(".col-card").count()) === 2 && (await con.locator(".panel-card").count()) === 3);
await con.click(".panel-card:has-text('Notice') button:has-text('설정')");
await con.fill(".panel-card textarea", "<i>Changed</i>");
await con.click("#saveBtn");
await con.waitForTimeout(500);
const pub2 = await (await fetch(server + "/portal-customizer.json")).json();
check("editing a panel in the console updates the published layout", pub2.columns[0].panels[1].html === "<i>Changed</i>" && pub2.version !== pub.version);

// edit mode toolbar "organization default" loads the same layout the popup applies, fetched again
// (the cached copy still has the old panel text: the server was edited after the last fetch)
await setSite({ userLayout: { schema: 1, columns: [{ id: "x1", flex: 1, panels: [{ id: "m1", type: "memo", title: "Mine", text: "mine" }] }] }, customized: true });
await page.bringToFront();
await page.waitForTimeout(400);
check("own layout is shown before", (await page.locator(".pc-video").count()) === 0);
await store({ editMode: true });
await page.waitForSelector("#pc-toolbar [data-org]:not([hidden])", { timeout: 3000 }).catch(() => {});
const orgBtn = await page.locator("#pc-toolbar [data-org]").isVisible();
if (orgBtn) { page.once("dialog", (d) => d.accept()); await page.click("#pc-toolbar [data-org]"); }
await page.waitForTimeout(400);
check("edit mode org-default button loads the server layout", orgBtn && (await page.locator(".pc-video").count()) === 1 && (await page.locator(".pc-html").innerHTML()).includes("Changed"));
await page.click("#pc-toolbar .pc-primary");
await page.waitForTimeout(400);
check("saved layout keeps the server layout", (await page.locator(".pc-video").count()) === 1);
await con.goto(server + "/#/contents");
await con.waitForSelector("h1:has-text('콘텐츠')");
check("CMS page opens", true);
await con.goto(server + "/#/stats");
await con.waitForSelector(".bars");
check("stats page opens", true);
check("version and release link under the title", /v\d+\.\d+\.\d+/.test(await con.locator("#verBox").innerText()) && (await con.locator("#verBox a").first().getAttribute("href")).includes("github.com/lisyoen/portal-customizer/releases"), await con.locator("#verBox").innerText());
await con.goto(server + "/#/settings");
await con.waitForSelector("text=업데이트");
check("settings page opens with the check interval in minutes (default 1)", (await con.locator("input[type=number][max='10080']").inputValue()) === "1");
// the title goes home (layout list); the name from settings is shown there, on the login page and in the tab
await con.click("#brand");
await con.waitForTimeout(400);
check("clicking the title opens the layout list", (await con.evaluate(() => location.hash)) === "#/layouts" && (await con.locator("h1").first().innerText()).includes("배치"));
await con.goto(server + "/#/settings");
await con.waitForSelector("text=업데이트");
await con.locator(".field:has-text('이름') input").fill("사내 포털 꾸미기");
await con.locator("button.primary:has-text('저장')").first().click();
await con.waitForTimeout(600);
check("site name shows as the title and tab title", (await con.locator("#brand").innerText()).includes("사내 포털 꾸미기") && (await con.title()) === "사내 포털 꾸미기 관리", await con.title());
await con.reload();
await con.waitForSelector("#brand");
check("site name kept after reload", (await con.locator("#brand").innerText()).includes("사내 포털 꾸미기") && (await con.title()) === "사내 포털 꾸미기 관리");
await con.click("nav.side a[href='#/extension']");
await con.waitForSelector("h1:has-text('확장 배포')");
check("extension distribution page opens", (await con.locator("text=배포 중인 확장 패키지가 없습니다").count()) === 1 && (await con.locator("code").first().innerText()).endsWith("/ext/latest.json"));
// installation package for new users: the server hands out the extension with its own settings in config.json
{
  const zip = path.join(data, "e2e-pkg.zip");
  execFileSync("bash", ["scripts/build-zip.sh", zip]);
  const tk = (await popup.evaluate(() => chrome.storage.local.get("adminToken"))).adminToken;
  const up = await fetch(server + "/api/extension?publish=1", { method: "PUT", headers: { Authorization: "Bearer " + tk }, body: readFileSync(zip) });
  await con.reload();
  await con.waitForSelector("h1:has-text('확장 배포')");
  check("distribution page offers the installation package", up.ok && (await con.locator("a.button:has-text('설치본 받기')").count()) === 1 && (await con.locator("code", { hasText: "/ext/install.zip" }).count()) === 1);
  await fetch(server + "/api/settings", { method: "PUT", headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" }, body: JSON.stringify({ welcomeNotice: "문의: 내선 1234" }) });
  const inst = await fetch(server + "/ext/install.zip");
  const dir = mkdtempSync(path.join(tmpdir(), "pc-inst-"));
  writeFileSync(path.join(dir, "install.zip"), Buffer.from(await inst.arrayBuffer()));
  execFileSync("unzip", ["-q", "install.zip", "-d", "ext"], { cwd: dir });
  const ctx2 = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "pc-new-")), { headless: true, channel: "chromium",
    args: [`--disable-extensions-except=${path.join(dir, "ext")}`, `--load-extension=${path.join(dir, "ext")}`] });
  const sw2 = ctx2.serviceWorkers()[0] || await ctx2.waitForEvent("serviceworker");
  const id2 = sw2.url().split("/")[2];
  const p2 = await ctx2.newPage();
  await p2.goto(`chrome-extension://${id2}/popup/popup.html`);
  let pkg = null;
  for (let i = 0; i < 30 && !pkg; i += 1) { await p2.waitForTimeout(200); pkg = (await p2.evaluate(() => chrome.storage.local.get("pkgConfig"))).pkgConfig; }
  check("installed package knows the organization address and admin server", pkg && pkg.orgConfigUrl === server + "/portal-customizer.json" && pkg.adminServer === server && pkg.updateSource === "server", JSON.stringify(pkg));
  await p2.reload();
  await p2.waitForFunction((u) => document.getElementById("orgUrl").value === u, server + "/portal-customizer.json", { timeout: 5000 }).catch(() => {});
  check("popup shows the packaged organization address", (await p2.inputValue("#orgUrl")) === server + "/portal-customizer.json", await p2.inputValue("#orgUrl"));
  await p2.click("#adminToggle");
  await p2.waitForSelector("#adminServerAuto:not([hidden])", { timeout: 5000 }).catch(() => {});
  check("admin login uses the packaged server", !(await p2.locator("#adminServer").isVisible()) && (await p2.locator("#adminServerAuto").innerText()).includes("127.0.0.1:" + port));
  const src2 = await p2.evaluate(() => chrome.runtime.sendMessage({ type: "updateSource" }));
  const org2 = await p2.evaluate(() => chrome.runtime.sendMessage({ type: "fetchOrg" })).catch(() => null);
  check("updates come from the packaged server", src2.source === "server" && src2.latestUrl === server + "/ext/latest.json", JSON.stringify(src2));
  const oc = (await p2.evaluate(() => chrome.storage.local.get("orgConfig"))).orgConfig;
  check("organization layout is fetched from the packaged address", oc && oc.url === server + "/portal-customizer.json", JSON.stringify(oc && { url: oc.url, err: oc.error }) + JSON.stringify(org2));
  // guide page right after install, with the administrator's notice and this PC's installation id
  const guide = ctx2.pages().find((pg) => pg.url().includes("/welcome/welcome.html"));
  if (guide) await guide.waitForFunction(() => !document.getElementById("adminSec").hidden, null, { timeout: 5000 }).catch(() => {});
  const gtext = guide ? await guide.locator("main").innerText() : "";
  const cid = (await p2.evaluate(() => chrome.storage.local.get("clientId"))).clientId || "";
  check("guide page opens after install: close the warning with X, how to turn it back on, admin notice, install id", !!guide && /X/.test(gtext) && /edge:\/\/extensions/.test(gtext) && gtext.includes("문의: 내선 1234") && cid && gtext.includes(cid.slice(0, 8)), gtext.slice(0, 200));
  // the installation shows up on the admin server; an administrator names it from that PC's popup
  await p2.reload();
  await p2.waitForFunction((id) => document.getElementById("pcInfoText").textContent.includes(id), cid.slice(0, 8), { timeout: 5000 }).catch(() => {});
  check("popup shows this PC's installation id", (await p2.locator("#pcInfoText").innerText()).includes(cid.slice(0, 8)));
  const listed = await (await fetch(server + "/api/clients", { headers: { Authorization: "Bearer " + tk } })).json();
  check("admin server lists the installation with its browser", listed.clients.some((c) => c.id === cid && c.browser && c.lastSeen), JSON.stringify(listed.clients.map((c) => c.id.slice(0, 8))));
  await p2.evaluate((o) => chrome.storage.local.set(o), { adminServer: server, adminToken: tk, adminUser: "boss" });
  await p2.reload();
  await p2.waitForSelector("#adminBox:not([hidden])", { timeout: 5000 }).catch(() => {});
  await p2.fill("#pcName", "7층 회의실 A");
  await p2.click("#pcNameBtn");
  await p2.waitForFunction(() => /회의실/.test(document.getElementById("pcInfoText").textContent), null, { timeout: 5000 }).catch(() => {});
  const named = await (await fetch(server + "/api/clients", { headers: { Authorization: "Bearer " + tk } })).json();
  check("administrator names the PC from its popup", named.clients.some((c) => c.id === cid && c.name === "7층 회의실 A") && /7층 회의실 A/.test(await p2.locator("#pcInfoText").innerText()), await p2.locator("#pcInfoText").innerText());
  await ctx2.close();
  rmSync(dir, { recursive: true, force: true });
  // installations page: the named PC, edit name / person in charge / watched
  await con.click("nav.side a[href='#/clients']");
  await con.waitForSelector("h1:has-text('설치 PC')");
  check("installations page lists the named PC", (await con.locator("td b", { hasText: "7층 회의실 A" }).count()) === 1);
  await con.locator("tr", { hasText: "7층 회의실 A" }).locator("button:has-text('이름·담당자')").click();
  await con.locator(".modal .field:has-text('담당자') input").fill("홍길동");
  await con.locator(".modal label:has-text('관리 대상') input").check();
  await con.locator(".modal button.primary:has-text('저장')").click();
  await con.waitForTimeout(500);
  const after = await (await fetch(server + "/api/clients", { headers: { Authorization: "Bearer " + tk } })).json();
  check("person in charge and watched flag saved", after.clients.some((c) => c.id === cid && c.owner === "홍길동" && c.watch), JSON.stringify(after.clients.find((c) => c.id === cid)));
}
await con.click("nav.side a[href='#/manual']");
await con.waitForSelector(".doc h3");
check("manual page renders the repository manual", (await con.locator(".doc h3").count()) >= 10 && (await con.locator(".doc table, .doc pre").count()) >= 1);
await con.click("nav.side a[href='#/license']");
await con.waitForSelector(".doc table");
await con.click("text=LICENSE 전문 보기");
await con.waitForTimeout(300);
check("license page shows the guide and the full LICENSE", (await con.locator(".doc").innerText()).includes("BSL 1.1") && (await con.locator("pre.license-text").innerText()).startsWith("Business Source License 1.1"));

// the server updated while the page stayed open -> the page reloads to get the new menus
await con.route("**/api/update", async (r) => { const res = await r.fetch(); const j = await res.json(); j.current = "9.9.9"; await r.fulfill({ response: res, json: j }); });
await con.evaluate(() => { window.__pcOld = 1; });
await Promise.all([con.waitForEvent("load", { timeout: 5000 }), con.evaluate(() => refreshUpdate())]).catch(() => {});
await con.unroute("**/api/update");
await con.waitForTimeout(500);
check("page reloads itself when the server version changes", await con.evaluate(() => window.__pcOld === undefined));

await ctx.close();
const exited = new Promise((r) => srv.once("exit", r));
srv.kill();
await exited;
try { rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_e) { /* temp folder */ }
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
