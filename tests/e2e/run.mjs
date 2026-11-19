// End-to-end test: loads the unpacked extension in Chromium and drives synthetic dashboards built with
// Vue 3, Vue 2, React 18 and plain HTML (tests/e2e/fixtures).
// Requires Playwright, vue@3, vue2 (npm:vue@2), react@18, react-dom@18 (not project dependencies):
//   NODE_PATH=/path/to/node_modules node tests/e2e/run.mjs
// Site access is granted up front by a test copy of the manifest (the popup asks the user in real use).
import { chromium } from "playwright";
import { readFileSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const NM = (process.env.NODE_PATH || "").split(":")[0];
const ext = mkdtempSync(path.join(tmpdir(), "pc-ext-"));
cpSync(path.resolve("extension"), ext, { recursive: true });
const mf = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
mf.host_permissions = ["http://*.test/*", "https://intranet.example.com/*"];
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(mf));

const LIBS = { "/lib/vue3.js": "vue/dist/vue.global.prod.js", "/lib/vue2.js": "vue2/dist/vue.min.js", "/lib/react.js": "react/umd/react.production.min.js", "/lib/react-dom.js": "react-dom/umd/react-dom.production.min.js" };
const PAGES = { vue3: "vue3.html", vue2: "vue2.html", react: "react.html", plain: "plain.html", org: "plain.html" };
const TITLES = ["Notice", "Mail", "Calendar", "News", "Weather", "Links"];

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "pc-")), {
  headless: true, channel: "chromium", viewport: { width: 1600, height: 1000 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route("http://*.test/**", (r) => {
  const u = new URL(r.request().url());
  if (LIBS[u.pathname]) return r.fulfill({ contentType: "text/javascript", body: readFileSync(path.join(NM, LIBS[u.pathname])) });
  if (u.pathname.startsWith("/fixtures/")) return r.fulfill({ contentType: "text/css", body: readFileSync("tests/e2e" + u.pathname) });
  const page = PAGES[u.hostname.split(".")[0]];
  return r.fulfill({ contentType: "text/html", body: page ? readFileSync("tests/e2e/fixtures/" + page) : "<p>none</p>" });
});
const ORG = { version: "org-1", name: "Test org", match: ["http://org.portal.test/home"], columns: [
  { id: "oc1", width: 320, panels: [{ id: "om1", type: "memo", title: "Org memo", text: "from org", height: 150 }, { id: "on1", type: "native", key: "title:Mail", title: "Mail" }] },
  { id: "oc2", flex: 1, panels: [{ id: "on2", type: "native", key: "title:Calendar", title: "Calendar" }] },
] };
await ctx.route("https://intranet.example.com/**", (r) => r.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(ORG) }));
await ctx.route("https://intranet.example.com/ext/latest.json*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ version: "0.0.2", zipUrl: "https://intranet.example.com/ext/portal-customizer-v0.0.2.zip" }) }));

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
const id = sw.url().split("/")[2];
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); };
check("extension id is fixed", id === "cfbjnlfoibngobcpbepnpcmkefdippce", id);

const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${id}/popup/popup.html`);
const store = (obj) => popup.evaluate((o) => chrome.storage.local.set(o), obj);
const read = (keys) => popup.evaluate((k) => chrome.storage.local.get(k), keys);
const sync = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: "syncScripts" }));
async function setSite(key, patch) {
  const { sites } = await read("sites");
  const next = Object.assign({}, sites); next[key] = Object.assign({}, next[key], patch);
  await store({ sites: next });
}
const getSite = async (key) => ((await read("sites")).sites || {})[key] || {};

// geometry helpers (page side)
const cardRect = (page, title) => page.evaluate((tt) => {
  const h = [...document.querySelectorAll(".card h3")].find((x) => x.textContent === tt && !x.closest("#pc-root"));
  if (!h) return null;
  const r = h.closest(".card").getBoundingClientRect(); const cs = getComputedStyle(h.closest(".card"));
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: cs.visibility };
}, title);
const slotRect = (page, title) => page.evaluate((tt) => {
  const p = [...document.querySelectorAll("#pc-root .pc-panel")].find((x) => x.querySelector(".pc-native-ph") && (x.dataset.title === tt || (x.querySelector(".pc-title") || {}).textContent === tt));
  const ph = p && p.querySelector(".pc-native-ph");
  if (!ph) return null;
  const r = ph.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, title);
async function alignedAll(page, titles) {
  const bad = [];
  for (const tt of titles) {
    const c = await cardRect(page, tt), s = await slotRect(page, tt);
    if (!c || !s || Math.abs(c.x - s.x) > 2 || Math.abs(c.y - s.y) > 2 || Math.abs(c.w - s.w) > 2) bad.push({ tt, c, s });
  }
  return bad;
}
const panelTitles = (page) => page.$$eval("#pc-root .pc-panel .pc-title", (xs) => xs.map((x) => x.textContent));

// edit mode needs an administrator login (popup)
await store({ adminServer: "http://127.0.0.1:9", adminToken: "test-token", adminUser: "tester" });

const EXPECT_FW = { vue3: "vue3", vue2: "vue2", react: "react", plain: "" };
for (const fw of ["vue3", "vue2", "react", "plain"]) {
  const url = `http://${fw}.portal.test/home`;
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(600);
  check(`[${fw}] page not turned on: untouched`, (await page.locator("#pc-root").count()) === 0 && !(await page.evaluate(() => document.documentElement.hasAttribute("data-pc-widgets"))));

  await setSite(url, { on: true });
  await sync();
  await page.reload();
  await page.waitForFunction(() => document.documentElement.getAttribute("data-pc-widgets") === "6", null, { timeout: 8000 }).catch(() => {});
  const fwAttr = await page.evaluate(() => document.documentElement.getAttribute("data-pc-fw"));
  const widgets = await page.evaluate(() => document.documentElement.getAttribute("data-pc-widgets"));
  check(`[${fw}] finds 6 widgets`, widgets === "6", String(widgets));
  check(`[${fw}] names the framework`, EXPECT_FW[fw] ? (fwAttr || "").split(",").includes(EXPECT_FW[fw]) : !fwAttr, String(fwAttr));
  if (fw !== "plain") check(`[${fw}] marks component roots`, (await page.locator(".card[data-pc-c]").count()) === 6, String(await page.locator(".card[data-pc-c]").count()));

  // first edit: the widget level picker opens over the original page
  await store({ editMode: true });
  await page.waitForSelector("#pc-pickbar", { timeout: 5000 }).catch(() => {});
  const pickState = () => page.evaluate(() => document.documentElement.getAttribute("data-pc-pick"));
  await page.waitForTimeout(200);
  check(`[${fw}] picker opens on the first edit with the widgets found`, (await page.locator("#pc-pickbar").count()) === 1 && (await pickState()) === "2:6" && (await page.locator("#pc-pick .pc-pick-w").count()) === 6, String(await pickState()));
  await page.click("#pc-pick-bigger"); await page.waitForTimeout(150);
  check(`[${fw}] bigger: the columns become the widgets`, (await pickState()) === "1:3", String(await pickState()));
  await page.click("#pc-pick-smaller"); await page.waitForTimeout(150);
  check(`[${fw}] smaller: back to the cards`, (await pickState()) === "2:6", String(await pickState()));
  if (fw === "vue3") {
    await page.click("#pc-pick-bigger"); await page.waitForTimeout(100);
    await page.click("#pc-pick-sample");
    const body = page.locator(".card .body").filter({ hasText: "News body" });
    await body.hover(); await page.waitForTimeout(100);
    check("[vue3] sample mode outlines the element under the pointer", (await page.locator("#pc-pick .pc-pick-hover").count()) === 1);
    await body.click(); await page.waitForTimeout(150);
    check("[vue3] clicking one card picks all cards at its level", (await pickState()) === "2:6", String(await pickState()));
  }
  await page.click("#pc-pick-apply");
  await page.waitForSelector("#pc-root.pc-edit", { timeout: 5000 }).catch(() => {});
  const rule = (await getSite(url)).rule;
  const ruleOk = rule && rule.level === 2 && await page.evaluate((sel) => { const e = document.querySelector(sel); return !!e && e.classList.contains("grid"); }, rule.container);
  check(`[${fw}] applying keeps a generated rule for this page`, ruleOk, JSON.stringify(rule));
  const cols = await page.locator("#pc-root .pc-col").count(), panels = await page.locator("#pc-root .pc-panel").count();
  check(`[${fw}] edit mode mirrors the page: 3 columns, 6 widgets`, cols === 3 && panels === 6, `${cols} cols ${panels} panels`);
  const titles = await panelTitles(page);
  check(`[${fw}] widget titles come from the page`, TITLES.every((x) => titles.includes(x)), JSON.stringify(titles));
  check(`[${fw}] side menu and header stay`, await page.locator(".side").isVisible() && await page.locator(".top").isVisible());
  await page.click("#pc-toolbar .pc-primary");
  await page.waitForTimeout(500);
  const saved = await getSite(url);
  check(`[${fw}] save keeps the layout for this page`, saved.customized && saved.userLayout && saved.userLayout.columns.length === 3, JSON.stringify(saved).slice(0, 120));
  check(`[${fw}] the saved layout carries the widget rule`, saved.userLayout.site && saved.userLayout.site.level === 2 && saved.userLayout.site.container === rule.container, JSON.stringify(saved.userLayout.site));
  check(`[${fw}] view mode after save`, (await page.locator("#pc-root").count()) === 1 && (await page.locator("#pc-root.pc-edit").count()) === 0);
  let bad = await alignedAll(page, TITLES);
  check(`[${fw}] every widget sits on its slot`, !bad.length, JSON.stringify(bad));

  // move Mail to the top of the third column, hide Weather, add a memo
  const l = JSON.parse(JSON.stringify(saved.userLayout));
  let mail = null;
  for (const c of l.columns) { const i = c.panels.findIndex((p) => p.title === "Mail"); if (i >= 0) mail = c.panels.splice(i, 1)[0]; }
  l.columns[2].panels.unshift(mail);
  for (const c of l.columns) for (const p of c.panels) if (p.title === "Weather") p.hidden = true;
  l.columns[1].panels.push({ id: "memo1", type: "memo", title: "My memo", text: "hello", height: 120 });
  await setSite(url, { userLayout: l });
  await page.waitForTimeout(700);
  const m = await cardRect(page, "Mail"), lk = await cardRect(page, "Links"), w = await cardRect(page, "Weather");
  check(`[${fw}] moved widget follows the layout`, m && lk && Math.abs(m.x - lk.x) <= 2 && m.y < lk.y, JSON.stringify({ m, lk }));
  check(`[${fw}] hidden widget is not shown`, w && w.vis === "hidden", JSON.stringify(w));
  check(`[${fw}] custom memo panel shown`, await page.locator("#pc-root .pc-type-memo").isVisible());
  bad = await alignedAll(page, TITLES.filter((x) => x !== "Weather"));
  check(`[${fw}] widgets aligned after the change`, !bad.length, JSON.stringify(bad));
  const clicked = await page.evaluate(() => { const a = document.getElementById("link1"); return a ? (a.click(), true) : null; });
  if (clicked !== null) check(`[${fw}] widget content still works`, clicked);

  if (fw === "vue3" || fw === "react") {
    await page.evaluate(() => window.recreateMail());
    await page.waitForTimeout(900);
    bad = await alignedAll(page, ["Mail", "Links"]);
    const m2 = await cardRect(page, "Mail");
    check(`[${fw}] re-created widget is found again and placed`, !bad.length && m2 && Math.abs(m2.x - lk.x) <= 2, JSON.stringify({ bad, m2 }));
  }
  if (fw === "vue3") {
    await page.goto(url + "?late=1");
    await page.waitForTimeout(3500);
    bad = await alignedAll(page, ["Mail", "Links", "Calendar"]);
    check("[vue3] widgets rendered late still get placed", (await page.locator("#pc-root").count()) === 1 && !bad.length, JSON.stringify(bad));
    // popup reports the page
    const tabId = await popup.evaluate(async (u) => (await chrome.tabs.query({ url: u + "*" }))[0].id, url);
    const pp = await ctx.newPage();
    await pp.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
    await pp.waitForTimeout(800);
    const addr = await pp.locator("#pageAddr").innerText(), st = await pp.locator("#pageStatus").innerText();
    check("[vue3] popup shows this page and what was found", addr === url && /vue3/.test(st) && /6/.test(st), JSON.stringify({ addr, st }));
    check("[vue3] popup offers to stop customizing", await pp.locator("#pageOff").isVisible() && await pp.locator("#pageOn").isHidden());
    await pp.close();
    // the toolbar reopens the picker; cancelling keeps the layout
    await store({ editMode: true });
    await page.waitForSelector("#pc-unit-btn", { timeout: 5000 }).catch(() => {});
    await page.click("#pc-unit-btn");
    await page.waitForSelector("#pc-pickbar", { timeout: 3000 }).catch(() => {});
    check("[vue3] toolbar ▣ reopens the picker at the saved level", (await pickState()) === "2:6", String(await pickState()));
    await page.click("#pc-pick-cancel");
    await page.waitForSelector("#pc-root.pc-edit", { timeout: 5000 }).catch(() => {});
    check("[vue3] cancel returns to the editor", (await page.locator("#pc-pickbar").count()) === 0 && (await page.locator("#pc-root .pc-panel").count()) >= 6);
    await store({ editMode: false });
    await page.waitForTimeout(500);
    // narrow window: still aligned
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(500);
    bad = await alignedAll(page, ["Mail", "Links", "Calendar"]);
    check("[vue3] window resize keeps widgets aligned", !bad.length, JSON.stringify(bad));
  }
  await store({ editMode: false });
  await page.close();
}

// reload of a customized page: the layout comes at once and the original arrangement is never shown
{
  const url = "http://vue3.portal.test/home";
  const page = await ctx.newPage();
  // from the first script on, sample every frame: is the page's widget grid visible while no layout is mounted?
  await page.addInitScript(() => {
    window.__pcFlash = 0; window.__pcMountedAt = 0; window.__pcGridAt = 0;
    const t0 = performance.now();
    const look = () => {
      const g = document.querySelector(".grid");
      const on = document.documentElement.classList.contains("pc-active");
      if (g && !window.__pcGridAt) window.__pcGridAt = performance.now() - t0;
      if (on && !window.__pcMountedAt) window.__pcMountedAt = performance.now() - t0;
      if (g && !on && g.getBoundingClientRect().height > 0 && getComputedStyle(g).visibility !== "hidden") window.__pcFlash++;
      if (performance.now() - t0 < 6000) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.goto(url); // first visit after the layout was saved: learns where the widget area is
  await page.waitForTimeout(800);
  check("the widget area is remembered for the next load", !!(await read("cloak:" + url))["cloak:" + url]);
  await page.reload();
  await page.waitForTimeout(1500);
  let r = await page.evaluate(() => ({ flash: window.__pcFlash, mounted: Math.round(window.__pcMountedAt), grid: Math.round(window.__pcGridAt) }));
  check("reload: original arrangement never shown", r.flash === 0 && r.mounted > 0, JSON.stringify(r));
  check("reload: layout mounted right after the widgets render", r.mounted > 0 && r.mounted - r.grid < 500, JSON.stringify(r));

  // a saved widget that is no longer on the page must not hold the layout back (it used to wait ~6 s)
  const st = await getSite(url);
  const l = JSON.parse(JSON.stringify(st.userLayout));
  l.columns[0].panels.push({ id: "gone1", type: "native", key: "title:Gone", title: "Gone" });
  await setSite(url, { userLayout: l });
  await page.reload();
  await page.waitForTimeout(2500);
  r = await page.evaluate(() => ({ flash: window.__pcFlash, mounted: Math.round(window.__pcMountedAt), grid: Math.round(window.__pcGridAt) }));
  check("reload with a widget missing from the page: no long wait", r.flash === 0 && r.mounted > 0 && r.mounted - r.grid < 1500, JSON.stringify(r));

  // a widget that arrives after the layout is mounted still gets its slot
  await page.goto(url + "?lateone=1");
  await page.waitForTimeout(1200);
  const early = await page.evaluate(() => ({ on: document.documentElement.classList.contains("pc-active"), flash: window.__pcFlash }));
  await page.waitForTimeout(2500);
  const bad = await alignedAll(page, ["Links", "Mail", "Calendar"]);
  check("late widget: layout shown before it arrives, then placed", early.on && early.flash === 0 && !bad.length, JSON.stringify({ early, bad }));
  l.columns[0].panels = l.columns[0].panels.filter((p) => p.id !== "gone1");
  await setSite(url, { userLayout: l });

  // turned off: nothing hidden
  await setSite(url, { on: false });
  await page.reload();
  await page.waitForTimeout(800);
  const c = await cardRect(page, "Mail");
  check("page turned off: no hiding on load", (await page.locator("#pc-cloak").count()) === 0 && c && c.vis === "visible", JSON.stringify(c));
  await setSite(url, { on: true });
  await page.close();
}

// turning a page off restores it
{
  const url = "http://plain.portal.test/home";
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(800);
  await setSite(url, { on: false });
  await page.waitForTimeout(500);
  const c = await cardRect(page, "Mail");
  check("turning the page off restores the original", (await page.locator("#pc-root").count()) === 0 && c && c.vis === "visible" && !(await page.evaluate(() => document.querySelector("[data-pc-container]"))), JSON.stringify(c));
  await page.close();
}

// organization layout applies to the pages its match list names, without turning them on
{
  await store({ orgUrl: "https://intranet.example.com/portal-customizer.json" });
  const r = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "fetchOrg" }));
  const { orgConfig } = await read("orgConfig");
  check("org layout keeps its match list", r.ok && orgConfig.match[0] === "http://org.portal.test/home", JSON.stringify(r));
  await sync();
  const page = await ctx.newPage();
  await page.goto("http://org.portal.test/home");
  await page.waitForSelector("#pc-root .pc-type-memo", { timeout: 8000 }).catch(() => {});
  check("org layout shown on a matching page", (await page.locator("#pc-root .pc-type-memo").count()) === 1 && (await page.locator("#pc-root .pc-type-memo textarea").inputValue()) === "from org");
  const bad = await alignedAll(page, ["Mail", "Calendar"]);
  const n = await cardRect(page, "Notice");
  check("org layout places its widgets and leaves the others out", !bad.length && n && n.vis === "hidden", JSON.stringify({ bad, n }));
  const other = await ctx.newPage();
  await other.goto("http://org.portal.test/other");
  await other.waitForTimeout(1000);
  check("org layout not applied to other pages", (await other.locator("#pc-root").count()) === 0);
  await page.close(); await other.close();
}

// edit mode is for administrators only
{
  await store({ adminToken: "" });
  await popup.reload();
  await popup.waitForTimeout(300);
  check("popup hides edit mode without an admin login", await popup.locator("#editModeRow").isHidden());
  const page = await ctx.newPage();
  await page.goto("http://vue3.portal.test/home");
  await page.waitForTimeout(800);
  await store({ editMode: true });
  await page.waitForTimeout(600);
  check("page does not enter edit mode without an admin login", (await page.locator("#pc-toolbar").count()) === 0);
  await page.close();
}

// updates come from the admin server of the organization address
{
  const us = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "updateSource" }));
  check("updates come from the admin server", us.source === "server" && us.latestUrl === "https://intranet.example.com/ext/latest.json", JSON.stringify(us));
}

await ctx.close();
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
