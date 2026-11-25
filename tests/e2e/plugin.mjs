// End-to-end: an admin server plugin's panel (iframe on the admin server) asks the extension to run its connectors
// inside the portal tab — a request with the portal's own session cookie, and opening a portal page after the
// user confirms. Synthetic hosts only (*.test); the SDK is the server's public/sdk/pc-plugin.js.
//   NODE_PATH=/path/to/node_modules node tests/e2e/plugin.mjs
import { chromium } from "playwright";
import { readFileSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ext = mkdtempSync(path.join(tmpdir(), "pc-ext-"));
cpSync(path.resolve("extension"), ext, { recursive: true });
const mf = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
mf.host_permissions = ["http://*.test/*", "https://intranet.example.com/*"];
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(mf));

const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); };

const ORG = { version: "plug-1", name: "Plugin org", match: ["http://portal.test/home"],
  columns: [
    { id: "c1", width: 460, panels: [{ id: "pp1", type: "plugin", plugin: "hello", panel: "board", title: "Hello board", height: 260 }] },
    { id: "c2", flex: 1, panels: [{ id: "n1", type: "native", key: "title:Mail", title: "Mail" }] },
  ],
  plugins: [{ id: "hello", name: "Hello", version: "1.0.0", base: "http://admin.test/p/hello/",
    panels: [{ name: "board", title: "Hello board", url: "http://admin.test/p/hello/panel.html", height: 260, sites: [] }],
    connectors: [
      { id: "hello.me", kind: "fetch", sites: ["http://portal.test/"], title: "me",
        request: { method: "POST", url: "/api/me", headers: {}, bodyType: "json", body: { q: "{{args.q}}", to: { $each: "{{args.to}}", item: { email: "{{item}}" } } }, timeoutMs: 5000 },
        response: { type: "json", pick: { name: "user.name", echo: "echo" } } },
      { id: "hello.compose", kind: "open", sites: ["http://portal.test/"], title: "compose", url: "/compose?to={{args.to|join|url}}", confirm: "작성 창을 열까요?" },
      { id: "hello.away", kind: "fetch", sites: ["http://portal.test/"], title: "away", request: { method: "GET", url: "http://admin.test/steal", headers: {}, bodyType: "none", body: null, timeoutMs: 3000 }, response: { type: "json", pick: null } },
    ] }] };

const PANEL = `<!doctype html><meta charset="utf-8"><title>panel</title>
<script src="http://admin.test/sdk/pc-plugin.js"></script>
<p id="info"></p><p id="out">…</p><p id="away">…</p><button id="compose">compose</button><p id="out2"></p>
<script>
document.getElementById("info").textContent = PC.site + "|" + PC.panel + "|" + PC.inPortal;
PC.call("hello.me", { q: "안녕", to: ["a@b.test", "c@d.test"] }).then((r) => { document.getElementById("out").textContent = JSON.stringify(r); }, (e) => { document.getElementById("out").textContent = "ERR " + e.message; });
PC.call("hello.away", {}).then((r) => { document.getElementById("away").textContent = "OK " + JSON.stringify(r); }, (e) => { document.getElementById("away").textContent = "ERR " + e.message; });
document.getElementById("compose").onclick = () => PC.call("hello.compose", { to: ["a@b.test"] }).then((r) => { document.getElementById("out2").textContent = JSON.stringify(r); }, (e) => { document.getElementById("out2").textContent = "ERR " + e.message; });
</script>`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "pc-")), {
  headless: true, channel: "chromium", viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let meBody = null, meCookie = "", stolen = false;
await ctx.route("http://admin.test/**", (r) => {
  const u = new URL(r.request().url());
  if (u.pathname === "/sdk/pc-plugin.js") return r.fulfill({ contentType: "text/javascript", body: readFileSync("server/public/sdk/pc-plugin.js") });
  if (u.pathname === "/p/hello/panel.html") return r.fulfill({ contentType: "text/html", body: PANEL });
  if (u.pathname === "/steal") { stolen = true; return r.fulfill({ contentType: "application/json", body: "{}" }); }
  return r.fulfill({ status: 404, body: "none" });
});
await ctx.route("http://portal.test/**", async (r) => {
  const u = new URL(r.request().url());
  if (u.pathname === "/api/me") {
    meBody = r.request().postDataJSON(); meCookie = (await r.request().allHeaders()).cookie || "";
    return r.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { name: meCookie.includes("sess=abc") ? "홍길동" : "anonymous" }, echo: meBody.q }) });
  }
  if (u.pathname === "/compose") return r.fulfill({ contentType: "text/html", body: "<p>compose</p>" });
  if (u.pathname.startsWith("/fixtures/")) return r.fulfill({ contentType: "text/css", body: readFileSync("tests/e2e" + u.pathname) });
  return r.fulfill({ contentType: "text/html", body: readFileSync("tests/e2e/fixtures/plain.html") });
});
await ctx.route("https://intranet.example.com/**", (r) => r.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(ORG) }));
await ctx.addCookies([{ name: "sess", value: "abc", domain: "portal.test", path: "/" }]);

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
const id = sw.url().split("/")[2];
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${id}/popup/popup.html`);
await popup.evaluate(() => chrome.storage.local.set({ orgUrl: "https://intranet.example.com/portal-customizer.json" }));
const r = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "fetchOrg" }));
const { orgConfig } = await popup.evaluate(() => chrome.storage.local.get("orgConfig"));
check("org config keeps plugins", r.ok && orgConfig.plugins && orgConfig.plugins[0].id === "hello" && orgConfig.plugins[0].connectors.length === 3, JSON.stringify(r));
await popup.evaluate(() => chrome.runtime.sendMessage({ type: "syncScripts" }));

const page = await ctx.newPage();
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
await page.goto("http://portal.test/home");
await page.waitForSelector("#pc-root iframe.pc-plugin-frame", { timeout: 8000 }).catch(() => {});
const frameEl = await page.$("#pc-root iframe.pc-plugin-frame");
check("plugin panel iframe rendered", !!frameEl);
const attrs = frameEl ? await frameEl.evaluate((f) => ({ plugin: f.dataset.pcPlugin, origin: f.dataset.pcOrigin, src: f.src })) : {};
check("iframe marked with plugin and origin", attrs.plugin === "hello" && attrs.origin === "http://admin.test" && /pc_site=http%3A%2F%2Fportal\.test/.test(attrs.src), JSON.stringify(attrs));
const frame = page.frames().find((f) => f.url().startsWith("http://admin.test/p/hello/panel.html"));
check("panel frame loaded", !!frame);
if (frame) {
  await frame.waitForFunction(() => document.getElementById("out").textContent !== "…", null, { timeout: 8000 }).catch(() => {});
  const info = await frame.textContent("#info");
  check("SDK knows the portal origin and panel", info === "http://portal.test|pp1|true", info);
  const out = await frame.textContent("#out");
  let parsed = null; try { parsed = JSON.parse(out); } catch (_e) { /* */ }
  check("connector ran with the portal session and returned picked data", parsed && parsed.ok && parsed.status === 200 && parsed.data.name === "홍길동" && parsed.data.echo === "안녕", out);
  check("request body rendered from the template", meBody && meBody.q === "안녕" && meBody.to.length === 2 && meBody.to[1].email === "c@d.test" && meCookie.includes("sess=abc"), JSON.stringify(meBody) + " " + meCookie);
  await frame.waitForFunction(() => document.getElementById("away").textContent !== "…", null, { timeout: 5000 }).catch(() => {});
  const away = await frame.textContent("#away");
  check("request to another origin refused", away.startsWith("ERR") && !stolen, away);
  const popupWait = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await frame.click("#compose");
  const np = await popupWait;
  if (np) await np.waitForLoadState().catch(() => {});
  check("open connector asks first, then opens the portal page", dialogs.includes("작성 창을 열까요?") && np && np.url() === "http://portal.test/compose?to=a%40b.test", JSON.stringify(dialogs) + " " + (np && np.url()));
}
// a frame that is not a plugin panel gets no answer
const spoof = await page.evaluate(() => new Promise((resolve) => {
  const f = document.createElement("iframe");
  f.srcdoc = "<script>let got=false;addEventListener('message',(e)=>{if(e.data&&e.data.pc==='result')got=true;});parent.postMessage({pc:'call',id:'x',op:'hello.me',args:{q:'spoof'}},'*');setTimeout(()=>parent.postMessage({spoofDone:got},'*'),1500);<\/script>";
  addEventListener("message", (e) => { if (e.data && "spoofDone" in e.data) resolve(e.data.spoofDone); });
  document.body.append(f);
}));
check("non-plugin frames are ignored", spoof === false && meBody.q !== "spoof", String(spoof));

await ctx.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
