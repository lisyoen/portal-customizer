// Site connector bridge. Plugin panels are pages on the admin server shown in an iframe; they cannot use the
// portal's own session. A panel asks the extension with postMessage({ pc: "call", id, op, args }) to run one of its
// plugin's connectors (declared by the admin server in portal-customizer.json "plugins"), and the content script
// runs it here (its own plugin's connectors or another plugin's from the same admin server), inside the portal tab: a request to the portal's own origin with the user's session, or opening a
// portal page. Only iframes the extension created for that plugin (data-pc-plugin, origin of the panel url) are
// answered, only declared connectors run, only on pages their sites list names, and only against the page's origin.
// A connector with "confirm" asks the user first. See docs/plugins.md.
(() => {
  "use strict";
  if (globalThis.PCBridge) return;
  const MAX_RESPONSE = 5 * 1024 * 1024;

  const plugins = (org) => (org && Array.isArray(org.plugins) ? org.plugins : []);
  const siteOk = (sites, href) => (sites || []).some((s) => s === "*" || (s && href.startsWith(s)));

  function panelDefs(org, href) {
    const out = [];
    for (const p of plugins(org)) for (const d of p.panels || []) if (!d.sites || !d.sites.length || siteOk(d.sites, href)) out.push(Object.assign({ plugin: p.id, pluginName: p.name }, d));
    return out;
  }
  function panelDef(org, plugin, name) {
    const p = plugins(org).find((x) => x.id === plugin);
    return (p && (p.panels || []).find((d) => d.name === name)) || null;
  }
  function panelUrl(def, panel) {
    const u = new URL(def.url);
    u.searchParams.set("pc_site", location.origin);
    u.searchParams.set("pc_page", location.href.slice(0, 500));
    u.searchParams.set("pc_panel", panel.id);
    return u.href;
  }

  // ---------- templates: "{{args.x|url}}" in strings, { "$each": ... }, { "$mime": ... }, { "$b64": ... } ----------
  function b64utf8(s) { return btoa(unescape(encodeURIComponent(String(s)))); }
  function getPath(obj, path) {
    let cur = [obj], many = false;
    for (const seg of String(path).split(".").filter(Boolean)) {
      const arr = seg.endsWith("[]"); const key = arr ? seg.slice(0, -2) : seg;
      cur = cur.flatMap((v) => { const x = v == null ? undefined : (key ? v[key] : v); if (arr) { many = true; return Array.isArray(x) ? x : []; } return [x]; });
    }
    return many ? cur : cur[0];
  }
  const FILTERS = {
    url: (v) => encodeURIComponent(v == null ? "" : String(v)),
    json: (v) => JSON.stringify(v),
    b64: (v) => b64utf8(v == null ? "" : v),
    html: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    str: (v) => (v == null ? "" : String(v)),
    num: (v) => Number(v) || 0,
    join: (v) => (Array.isArray(v) ? v.join(";") : String(v == null ? "" : v)),
  };
  function evalExpr(expr, ctx) {
    const [path, ...filters] = expr.split("|").map((x) => x.trim());
    let v = getPath(ctx, path);
    for (const f of filters) { if (!FILTERS[f]) throw new Error("알 수 없는 필터: " + f); v = FILTERS[f](v); }
    return v;
  }
  function render(t, ctx) {
    if (typeof t === "string") {
      const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(t);
      if (whole) return evalExpr(whole[1], ctx);
      return t.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, e) => { const v = evalExpr(e, ctx); return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); });
    }
    if (Array.isArray(t)) return t.map((x) => render(x, ctx));
    if (t && typeof t === "object") {
      if ("$each" in t) {
        const list = render(t.$each, ctx);
        return (Array.isArray(list) ? list : []).map((item, index) => render(t.item, Object.assign({}, ctx, { item, index })));
      }
      if ("$b64" in t) return b64utf8(render(t.$b64, ctx));
      if ("$mime" in t) {
        // an HTML mail body as a MIME message (multipart/related, base64 text/html part)
        const m = render(t.$mime, ctx) || {};
        const boundary = "PC-" + Math.random().toString(36).slice(2, 12);
        return "MIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n\tboundary=\"" + boundary + "\"\r\n\r\n--" + boundary
          + "\r\nContent-Type: text/html;\r\n charset=\"utf-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64utf8(m.html || "") + "\r\n\r\n--" + boundary + "--";
      }
      const out = {};
      for (const [k, v] of Object.entries(t)) out[k] = render(v, ctx);
      return out;
    }
    return t;
  }
  function samePageOrigin(u) {
    const x = new URL(u, location.href);
    if (x.origin !== location.origin) throw new Error("연동은 이 화면의 사이트 주소로만 보낼 수 있습니다");
    return x.href;
  }

  async function run(org, pluginId, op, args) {
    // the panel's own plugin first, then the other plugins of the same admin server (e.g. a board plugin using a
    // portal integration plugin's connectors)
    const p = plugins(org).find((x) => x.id === pluginId);
    const c = p && ((p.connectors || []).find((x) => x.id === op) || plugins(org).flatMap((x) => x.connectors || []).find((x) => x.id === op));
    if (!c) throw new Error("없는 연동입니다: " + op);
    if (!siteOk(c.sites, location.href)) throw new Error("이 화면에서는 쓸 수 없는 연동입니다: " + op);
    const ctx = { args: args && typeof args === "object" ? args : {}, page: { origin: location.origin, href: location.href, title: document.title }, now: new Date().toISOString() };
    if (c.confirm && !window.confirm(String(render(c.confirm, ctx)))) throw Object.assign(new Error("사용자가 취소했습니다"), { code: "cancelled" });
    if (c.kind === "open") {
      const url = samePageOrigin(render(c.url, ctx));
      const w = window.open(url, "_blank");
      return { opened: !!w, url };
    }
    const r = c.request || {};
    const url = samePageOrigin(render(r.url, ctx));
    const headers = {};
    for (const [k, v] of Object.entries(r.headers || {})) headers[k] = String(render(v, ctx));
    let body;
    if (r.bodyType === "json") { body = JSON.stringify(render(r.body, ctx)); if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json;charset=UTF-8"; }
    else if (r.bodyType === "form") body = new URLSearchParams(render(r.body, ctx) || {});
    else if (r.bodyType === "text") body = String(render(r.body, ctx));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), r.timeoutMs || 30000);
    let res;
    try { res = await fetch(url, { method: r.method || "GET", headers, body, credentials: "include", signal: ctrl.signal, cache: "no-store" }); }
    catch (e) { throw new Error(e.name === "AbortError" ? "응답 시간이 지났습니다(결과를 확인한 뒤 다시 시도하세요)" : "요청 실패: " + e.message); }
    finally { clearTimeout(timer); }
    const text = await res.text();
    if (text.length > MAX_RESPONSE) throw new Error("응답이 너무 큽니다");
    let data = text;
    if (c.response && c.response.type !== "text") { try { data = JSON.parse(text); } catch (_e) { data = text; } }
    if (res.ok && c.response && c.response.pick && data && typeof data === "object") {
      const picked = {};
      for (const [k, path] of Object.entries(c.response.pick)) picked[k] = getPath(data, path);
      data = picked;
    }
    return { status: res.status, ok: res.ok, data };
  }

  async function org() {
    try { return (await chrome.storage.local.get("orgConfig")).orgConfig || null; } catch (_e) { return null; }
  }
  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || d.pc !== "call" || typeof d.op !== "string") return;
    const frame = [...document.querySelectorAll("iframe[data-pc-plugin]")].find((f) => f.contentWindow === e.source);
    if (!frame || e.origin !== frame.dataset.pcOrigin) return;
    const reply = (msg) => { try { e.source.postMessage(Object.assign({ pc: "result", id: d.id }, msg), e.origin); } catch (_e) { /* frame gone */ } };
    if (d.op === "pc.info") return reply({ ok: true, data: { site: location.origin, page: location.href, title: document.title, plugin: frame.dataset.pcPlugin } });
    try { reply({ ok: true, data: await run(await org(), frame.dataset.pcPlugin, d.op, d.args) }); }
    catch (err) { reply({ ok: false, error: String((err && err.message) || err), code: (err && err.code) || "" }); }
  });

  globalThis.PCBridge = { panelDefs, panelDef, panelUrl, render, getPath, run };
})();
