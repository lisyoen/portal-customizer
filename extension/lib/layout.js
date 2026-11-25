// Layout model shared by the content script, background, popup and tests. Pure functions only.
(function (root) {
  "use strict";
  const SCHEMA = 1;
  const TYPES = ["native", "image", "video", "html", "links", "memo", "iframe", "carousel", "feed", "plugin"];
  const MIN_COL = 120, MAX_COL = 3000, MIN_PANEL = 40, MAX_PANEL = 4000;

  // Space in px (0-200) or null = use the default.
  const DEFAULT_PANEL_GAP = 16, DEFAULT_COL_GAP = 16, MAX_GAP = 200;
  function gapValue(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.min(MAX_GAP, Math.max(0, n)) * 2) / 2;
  }
  function panelGap(layout, panel) {
    if (panel && panel.gap != null) return panel.gap;
    if (layout.gaps && layout.gaps.panel != null) return layout.gaps.panel;
    return DEFAULT_PANEL_GAP;
  }
  function colGap(layout, col) {
    if (col && col.gap != null) return col.gap;
    if (layout.gaps && layout.gaps.col != null) return layout.gaps.col;
    return DEFAULT_COL_GAP;
  }
  function setGap(layout, target, value) {
    const l = clone(layout);
    const g = gapValue(value);
    if (target.panel) {
      const f = findPanel(l, target.panel);
      if (f) { if (g == null) delete f.panel.gap; else f.panel.gap = g; }
    } else if (target.col) {
      const c = l.columns.find((x) => x.id === target.col);
      if (c) { if (g == null) delete c.gap; else c.gap = g; }
    } else if (target.defaults) {
      const gaps = Object.assign({}, l.gaps);
      for (const k of ["panel", "col"]) if (k in target.defaults) { const v = gapValue(target.defaults[k]); if (v == null) delete gaps[k]; else gaps[k] = v; }
      if (Object.keys(gaps).length) l.gaps = gaps; else delete l.gaps;
      if (target.resetOverrides) l.columns.forEach((c) => { delete c.gap; c.panels.forEach((p) => delete p.gap); });
    }
    return l;
  }
  function uid(prefix) { return (prefix || "x") + Math.random().toString(36).slice(2, 9); }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

  // Stable identity of a page widget: the address of its only frame (path + sorted query),
  // else its component name and title.
  function keyFromSrc(src, base) {
    try {
      const u = new URL(src, base || "http://localhost/");
      const q = [...u.searchParams.keys()].sort().map((k) => k + "=" + u.searchParams.get(k)).join("&");
      return u.pathname + (q ? "?" + q : "");
    } catch (_e) {
      return String(src);
    }
  }
  function nativeKey(info) {
    if (info.src) return "src:" + keyFromSrc(info.src, info.base);
    const comp = String(info.comp || "").trim(), title = String(info.title || "").trim();
    if (comp) return "c:" + comp + (title ? "|" + title : "");
    return "title:" + title;
  }
  // Does an address match a site list? list: address prefixes (string or array); "*" in a prefix matches anything.
  function matchesSite(list, href) {
    const items = (Array.isArray(list) ? list : String(list || "").split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
    return items.some((m) => {
      if (!/^https?:\/\//i.test(m)) return false;
      const re = new RegExp("^" + m.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*"), "i");
      return re.test(href);
    });
  }

  function num(v, min, max) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || v === null || v === "" || v === undefined) return null;
    return Math.min(max, Math.max(min, n));
  }
  function safeUrl(v, allowData) {
    const s = String(v || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (allowData && /^data:image\/[a-z+.-]+;base64,/i.test(s)) return s;
    return "";
  }
  function str(v, max) { return String(v == null ? "" : v).slice(0, max || 200); }

  // Build a layout that mirrors the original page. catalog: [{width, flex, items:[{key,title,height}]}]
  // Spacing measured on the page (column.gap: space left of a column, item.gap: space above a widget) is kept:
  // the most common value becomes the layout default, the others stay on their column or panel.
  function fromCatalog(columns) {
    const mode = (vals) => {
      const n = new Map();
      vals.forEach((v) => n.set(v, (n.get(v) || 0) + 1));
      let best = null, bc = 0;
      n.forEach((c, v) => { if (c > bc) { best = v; bc = c; } });
      return best;
    };
    const colGaps = columns.slice(1).map((c) => gapValue(c.gap)).filter((v) => v != null);
    const panelGaps = columns.flatMap((c) => c.items.slice(1).map((p) => gapValue(p.gap))).filter((v) => v != null);
    const dc = mode(colGaps), dp = mode(panelGaps);
    const out = {
      schema: SCHEMA,
      version: "",
      columns: columns.map((c, ci) => {
        const col = {
          id: uid("c"),
          width: c.flex ? null : num(c.width, MIN_COL, MAX_COL) || 380,
          flex: c.flex ? 1 : null,
          panels: c.items.map((p, pi) => {
            // auto: the height is the page's own (until someone changes it), so it is not compared with the page
            const panel = { id: uid("p"), type: "native", key: p.key, title: str(p.title), height: num(p.height, MIN_PANEL, MAX_PANEL), auto: true };
            const g = pi ? gapValue(p.gap) : null;
            if (g != null && g !== dp) panel.gap = g;
            return panel;
          }),
        };
        const g = ci ? gapValue(c.gap) : null;
        if (g != null && g !== dc) col.gap = g;
        return col;
      }),
    };
    if (dc != null || dp != null) out.gaps = {};
    if (dc != null) out.gaps.col = dc;
    if (dp != null) out.gaps.panel = dp;
    return out;
  }

  function normPanel(p) {
    if (!p || typeof p !== "object" || !TYPES.includes(p.type)) return null;
    const out = { id: str(p.id || uid("p"), 40), type: p.type, title: str(p.title), height: num(p.height, MIN_PANEL, MAX_PANEL) };
    const g = gapValue(p.gap);
    if (g != null) out.gap = g;
    if (p.hidden) out.hidden = true;
    if (p.header === false) out.header = false;
    if (p.type === "native") {
      if (p.auto) out.auto = true;
      out.key = str(p.key, 500);
      if (!out.key) return null;
    } else if (p.type === "image") {
      out.src = safeUrl(p.src, true);
      out.href = safeUrl(p.href, false);
      out.fit = p.fit === "contain" ? "contain" : "cover";
      out.bg = /^#[0-9a-f]{3,8}$/i.test(String(p.bg || "")) ? p.bg : "";
    } else if (p.type === "links") {
      out.items = (Array.isArray(p.items) ? p.items : []).slice(0, 200)
        .map((i) => { const o = { title: str(i && i.title), url: safeUrl(i && i.url, false) }; const img = safeUrl(i && i.img, true); if (img) o.img = img; return o; })
        .filter((i) => i.url);
      out.newTab = p.newTab !== false;
      out.display = p.display === "grid" ? "grid" : "list";
    } else if (p.type === "memo") {
      out.text = str(p.text, 20000);
    } else if (p.type === "video") {
      out.src = safeUrl(p.src, false) || (/^data:video\/[a-z0-9.+-]+;base64,/i.test(String(p.src || "")) ? String(p.src) : "");
      out.poster = safeUrl(p.poster, true);
      out.href = safeUrl(p.href, false);
      out.autoplay = p.autoplay !== false; out.muted = p.muted !== false; out.loop = p.loop !== false; out.controls = !!p.controls;
    } else if (p.type === "html") {
      out.html = str(p.html, 100000);
    } else if (p.type === "carousel") {
      out.slides = (Array.isArray(p.slides) ? p.slides : []).slice(0, 30)
        .map((x) => ({ title: str(x && x.title), href: safeUrl(x && x.href, false), src: safeUrl(x && x.src, true) }))
        .filter((x) => x.src || x.title);
      out.interval = num(p.interval, 0, 600) || 0;
      out.fit = p.fit === "contain" ? "contain" : "cover";
      out.captions = p.captions !== false;
      out.layer = !!p.layer;
    } else if (p.type === "feed") {
      const seenTab = new Set();
      out.tabs = (Array.isArray(p.tabs) ? p.tabs : []).slice(0, 20).map((x) => {
        let tid = str((x && x.id) || uid("t"), 40);
        if (seenTab.has(tid)) tid = uid("t");
        seenTab.add(tid);
        return { id: tid, title: str(x && x.title, 60), src: safeUrl(x && x.src, false), site: safeUrl(x && x.site, false), write: safeUrl(x && x.write, false) };
      }).filter((x) => x.src || x.title);
      out.view = p.view === "list" ? "list" : "card";
      out.all = p.all !== false;
      out.first = str(p.first || "", 40);
      out.layer = p.layer !== false;
      out.refresh = num(p.refresh, 0, 1440) || 0;
      out.limit = (p.limit && num(p.limit, 1, 200)) || 30;
    } else if (p.type === "iframe") {
      out.url = safeUrl(p.url, false);
      out.refresh = num(p.refresh, 0, 1440) || 0;
      out.zoom = num(p.zoom, 25, 300) || 100;
      if (p.scroll === false) out.scroll = false;
    } else if (p.type === "plugin") {
      // a panel offered by an admin server plugin: drawn from the plugin's panel url (portal-customizer.json "plugins")
      out.plugin = /^[a-z0-9][a-z0-9-]{1,39}$/.test(String(p.plugin || "")) ? p.plugin : "";
      out.panel = /^[\w-]{1,40}$/.test(String(p.panel || "")) ? p.panel : "";
    }
    return out;
  }

  // Returns { ok, error, layout } with every field sanitized.
  // How often (minutes) browsers check the organization default again; set by the admin in the published file.
  function refreshMinutes(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(1440, n) : 0;
  }
  // Widget rule picked in edit mode: container selector (generated by the extension) + level below it.
  function widgetRule(v) {
    if (!v || typeof v !== "object" || typeof v.container !== "string" || !v.container.trim()) return null;
    const n = Math.round(Number(v.level));
    if (!(n >= 1)) return null;
    return { container: v.container.trim().slice(0, 300), level: Math.min(10, n) };
  }
  function validate(obj) {
    if (!obj || typeof obj !== "object") return { ok: false, error: "not an object" };
    const src = obj.layout && Array.isArray(obj.layout.columns) ? obj.layout : obj;
    if (!Array.isArray(src.columns) || !src.columns.length) return { ok: false, error: "columns missing" };
    if (src.schema && src.schema > SCHEMA) return { ok: false, error: "unsupported schema " + src.schema };
    const seen = new Set();
    const columns = src.columns.slice(0, 20).map((c) => {
      const flex = c && c.flex ? 1 : null;
      const panels = (c && Array.isArray(c.panels) ? c.panels : []).map(normPanel).filter(Boolean).map((p) => {
        if (seen.has(p.id)) p.id = uid("p");
        seen.add(p.id);
        return p;
      });
      const col = { id: str((c && c.id) || uid("c"), 40), width: flex ? null : num(c && c.width, MIN_COL, MAX_COL) || 380, flex, panels };
      const g = gapValue(c && c.gap);
      if (g != null) col.gap = g;
      return col;
    });
    const layout = { schema: SCHEMA, version: str(obj.version || src.version || "", 80), columns };
    const gaps = {};
    const gp = gapValue(src.gaps && src.gaps.panel), gc = gapValue(src.gaps && src.gaps.col);
    if (gp != null) gaps.panel = gp;
    if (gc != null) gaps.col = gc;
    if (Object.keys(gaps).length) layout.gaps = gaps;
    if (obj.name || src.name) layout.name = str(obj.name || src.name, 120);
    const rm = refreshMinutes(obj.refreshMinutes != null ? obj.refreshMinutes : src.refreshMinutes);
    if (rm) layout.refreshMinutes = rm;
    const site = widgetRule(src.site || obj.site);
    if (site) layout.site = site;
    return { ok: true, layout };
  }

  function findPanel(layout, id) {
    for (let ci = 0; ci < layout.columns.length; ci += 1) {
      const pi = layout.columns[ci].panels.findIndex((p) => p.id === id);
      if (pi >= 0) return { ci, pi, panel: layout.columns[ci].panels[pi] };
    }
    return null;
  }
  function movePanel(layout, id, toCol, toIndex) {
    const l = clone(layout);
    const f = findPanel(l, id);
    if (!f || !l.columns[toCol]) return l;
    const [p] = l.columns[f.ci].panels.splice(f.pi, 1);
    let idx = toIndex;
    if (f.ci === toCol && f.pi < toIndex) idx -= 1;
    const list = l.columns[toCol].panels;
    list.splice(Math.max(0, Math.min(list.length, idx)), 0, p);
    return l;
  }
  function moveColumn(layout, colId, toIndex) {
    const l = clone(layout);
    const from = l.columns.findIndex((c) => c.id === colId);
    if (from < 0) return l;
    const [c] = l.columns.splice(from, 1);
    let idx = toIndex;
    if (from < toIndex) idx -= 1;
    l.columns.splice(Math.max(0, Math.min(l.columns.length, idx)), 0, c);
    return l;
  }
  function addPanel(layout, colIndex, panel) {
    const l = clone(layout);
    const col = l.columns[Math.max(0, Math.min(l.columns.length - 1, colIndex))];
    col.panels.unshift(panel);
    return l;
  }
  function updatePanel(layout, id, patch) {
    const l = clone(layout);
    const f = findPanel(l, id);
    if (f) {
      const next = Object.assign({}, f.panel, patch);
      if ("height" in patch && patch.height !== f.panel.height) delete next.auto; // height set by hand
      l.columns[f.ci].panels[f.pi] = normPanel(next) || f.panel;
    }
    return l;
  }
  function removePanel(layout, id) {
    const l = clone(layout);
    const f = findPanel(l, id);
    if (f) l.columns[f.ci].panels.splice(f.pi, 1);
    return l;
  }
  function addColumn(layout, width) {
    const l = clone(layout);
    l.columns.push({ id: uid("c"), width: num(width, MIN_COL, MAX_COL) || 320, flex: null, panels: [] });
    return l;
  }
  function removeColumn(layout, colId) {
    const l = clone(layout);
    if (l.columns.length <= 1) return l;
    l.columns = l.columns.filter((c) => c.id !== colId);
    return l;
  }
  function setColumn(layout, colId, patch) {
    const l = clone(layout);
    const c = l.columns.find((x) => x.id === colId);
    if (c) {
      if ("flex" in patch && patch.flex) { c.flex = 1; c.width = null; }
      if (patch.width) { c.width = num(patch.width, MIN_COL, MAX_COL); c.flex = null; }
    }
    return l;
  }
  function usedNativeKeys(layout) {
    const s = new Set();
    if (layout) layout.columns.forEach((c) => c.panels.forEach((p) => { if (p.type === "native") s.add(p.key); }));
    return s;
  }
  function newPanel(type, title) {
    const base = { id: uid("p"), type, title: title || "", height: null };
    if (type === "image") return Object.assign(base, { height: 180, src: "", href: "", fit: "cover", header: false });
    if (type === "links") return Object.assign(base, { items: [], newTab: true });
    if (type === "memo") return Object.assign(base, { height: 200, text: "" });
    if (type === "iframe") return Object.assign(base, { height: 320, url: "", refresh: 0, zoom: 100 });
    if (type === "plugin") return Object.assign(base, { height: 360, plugin: "", panel: "" });
    if (type === "video") return Object.assign(base, { height: 240, src: "", poster: "", href: "", autoplay: true, muted: true, loop: true, controls: false });
    if (type === "html") return Object.assign(base, { height: 200, html: "" });
    if (type === "carousel") return Object.assign(base, { height: 240, slides: [], interval: 5, fit: "cover", captions: true, layer: false });
    if (type === "feed") return Object.assign(base, { height: 420, tabs: [], view: "card", all: true, first: "", layer: true, refresh: 10, limit: 30 });
    return base;
  }
  // Short content hash used as a version when a remote file has none.
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }
  // "Title | https://url" per line <-> items
  // "Title | https://url" or "Title | https://url | https://image" per line <-> items
  function parseLinks(text) {
    return String(text || "").split(/\r?\n/).map((line) => {
      const m = line.split("|").map((x) => x.trim());
      const urlIdx = m.findIndex((x) => /^https?:\/\//i.test(x));
      if (urlIdx < 0) return null;
      const url = m[urlIdx];
      const title = m.slice(0, urlIdx).join(" | ");
      const img = safeUrl(m[urlIdx + 1], true);
      const o = { title: title || url, url: safeUrl(url, false) };
      if (img) o.img = img;
      return o;
    }).filter((i) => i && i.url);
  }
  function formatLinks(items) { return (items || []).map((i) => (i.title && i.title !== i.url ? i.title + " | " : "") + i.url + (i.img && !i.img.startsWith("data:") ? " | " + i.img : "")).join("\n"); }
  // Items found in a board page: rows with a link. Pure part (works on plain objects) for tests.
  const DATE_RE = /(\d{2,4})[.\-/](\d{1,2})[.\-/](\d{1,2})|(\d{1,2}):(\d{2})/;
  function parseDate(text, now) {
    const m = DATE_RE.exec(String(text || ""));
    if (!m) return 0;
    const n = now || new Date();
    if (m[1]) {
      let y = Number(m[1]); if (y < 100) y += 2000;
      return new Date(y, Number(m[2]) - 1, Number(m[3])).getTime();
    }
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), Number(m[4]), Number(m[5])).getTime();
  }
  function cleanItems(raw, limit) {
    const seen = new Set();
    const out = [];
    for (const r of raw) {
      const text = String(r.text || "").replace(/\s+/g, " ").trim();
      if (text.length < 2 || /^[\d\s<>«»‹›….,|-]+$/.test(text) || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, href: r.href || "", row: String(r.row || "").replace(/\s+/g, " ").trim(), date: parseDate(r.row || r.text) });
      if (out.length >= (limit || 30)) break;
    }
    return out;
  }
  // ALL tab: take items from each source in turn so one busy board does not push the others out.
  function mergeRoundRobin(lists, limit) {
    const out = [];
    for (let i = 0; out.length < limit; i += 1) {
      let any = false;
      for (const l of lists) if (l[i]) { out.push(l[i]); any = true; if (out.length >= limit) break; }
      if (!any) break;
    }
    return out;
  }
  function sortItems(items, how) {
    const a = items.slice();
    if (how === "title") a.sort((x, y) => x.text.localeCompare(y.text, "ko"));
    else if (how === "date") a.sort((x, y) => (y.date || 0) - (x.date || 0));
    return a;
  }

  // Allow-list HTML for "html" panels: formatting, lists, tables, links and images only.
  const HTML_TAGS = new Set(["a", "b", "strong", "i", "em", "u", "s", "br", "p", "div", "span", "h1", "h2", "h3", "h4", "h5", "ul", "ol", "li", "img", "table", "thead", "tbody", "tr", "td", "th", "blockquote", "hr", "small", "sub", "sup", "code", "pre", "font", "center"]);
  const HTML_ATTRS = new Set(["href", "src", "alt", "title", "colspan", "rowspan", "target", "style", "width", "height", "align", "color", "size"]);
  function sanitizeHtml(html, doc) {
    const d = doc || (typeof DOMParser !== "undefined" ? new DOMParser().parseFromString("<body></body>", "text/html") : null);
    if (!d) return "";
    const src = new DOMParser().parseFromString(String(html || ""), "text/html");
    const out = d.createElement("div");
    const walk = (from, to) => {
      for (const n of from.childNodes) {
        if (n.nodeType === 3) { to.append(d.createTextNode(n.textContent)); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (!HTML_TAGS.has(tag)) { if (!["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math"].includes(tag)) walk(n, to); continue; }
        const e = d.createElement(tag);
        for (const a of n.attributes) {
          const name = a.name.toLowerCase(); let v = a.value;
          if (!HTML_ATTRS.has(name)) continue;
          if (name === "href" && !/^(https?:|mailto:)/i.test(v.trim())) continue;
          if (name === "src" && !safeUrl(v, true)) continue;
          if (name === "style" && /url\s*\(|expression|javascript:|@import|position\s*:\s*fixed/i.test(v)) continue;
          if (name === "target") v = "_blank";
          e.setAttribute(name, v);
        }
        if (tag === "a") e.setAttribute("rel", "noopener noreferrer");
        walk(n, e);
        to.append(e);
      }
    };
    walk(src.body, out);
    return out;
  }

  // Short signature of a layout's arrangement (columns, panels, gaps), to remember that it was already found
  // to match the page.
  function sig(layout) {
    const src = JSON.stringify({ c: (layout && layout.columns) || [], g: (layout && layout.gaps) || null });
    let h = 5381;
    for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ":" + src.length;
  }
  // True when a layout puts exactly the page's own widgets in the page's own order, sizes and spacing
  // (structure: columns as detected, with measured gaps): showing it would change nothing, so the page is left as is.
  function matchesPage(layout, structure) {
    if (!layout || !Array.isArray(layout.columns) || !structure || layout.columns.length !== structure.length) return false;
    return layout.columns.every((col, ci) => {
      const sc = structure[ci];
      if (!!col.flex !== !!sc.flex) return false;
      if (!col.flex && Math.abs((col.width || 0) - (sc.width || 0)) > 1) return false;
      if (ci && sc.gap != null && Math.abs(colGap(layout, col) - sc.gap) > 1) return false;
      if (col.panels.length !== sc.items.length) return false;
      return col.panels.every((p, pi) => {
        const it = sc.items[pi];
        if (p.type !== "native" || p.hidden || p.header === false || p.key !== it.key) return false;
        if (!p.auto && p.height && it.height && Math.abs(p.height - it.height) > 2) return false;
        return !pi || it.gap == null || Math.abs(panelGap(layout, p) - it.gap) <= 1;
      });
    });
  }
  const api = { sig, matchesPage, SCHEMA, TYPES, uid, clone, keyFromSrc, nativeKey, matchesSite, widgetRule, fromCatalog, validate, normPanel, findPanel, movePanel,
    moveColumn, addPanel, updatePanel, removePanel, addColumn, removeColumn, setColumn, usedNativeKeys, newPanel, hash,
    parseLinks, formatLinks, safeUrl, gapValue, panelGap, colGap, setGap, DEFAULT_PANEL_GAP, DEFAULT_COL_GAP, parseDate, cleanItems, mergeRoundRobin, sortItems, sanitizeHtml, refreshMinutes };
  root.PCLayout = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
