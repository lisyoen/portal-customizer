// Portal Customizer widget detection (content script world).
// Finds the main multi-column area of a portal page and the widgets (panels, cards, rows) in it.
// Framework component roots marked by the probe (data-pc-c) are preferred as widgets; pages without a known
// framework fall back to the plain DOM box structure. A widget rule picked by the user in edit mode
// ({container: generated selector, level: depth of the widgets below it}) replaces the automatic choice.
(function (root) {
  "use strict";
  const MIN_W = 100, MIN_H = 40, COL_TOL = 24, MAX_SCAN = 15000;

  // ---------- pure geometry (unit tested) ----------
  // boxes: [{left, top, width, height}] -> columns: [[index...]] left to right, each top to bottom.
  // A box joins the column whose left edge is within COL_TOL, or that it overlaps by more than half its width.
  function groupColumns(boxes, tol) {
    const t = tol == null ? COL_TOL : tol;
    const order = boxes.map((b, i) => i).sort((a, b) => boxes[a].left - boxes[b].left || boxes[a].top - boxes[b].top);
    const cols = [];
    for (const i of order) {
      const b = boxes[i];
      let col = cols.find((c) => Math.abs(c.left - b.left) <= t);
      if (!col) col = cols.find((c) => Math.min(c.right, b.left + b.width) - Math.max(c.left, b.left) > b.width / 2 && b.left >= c.left);
      if (!col) { col = { left: b.left, right: b.left + b.width, items: [] }; cols.push(col); }
      col.items.push(i);
      col.right = Math.max(col.right, b.left + b.width);
    }
    cols.sort((a, b) => a.left - b.left);
    return cols.map((c) => c.items.sort((a, b) => boxes[a].top - boxes[b].top));
  }
  // Score of a candidate container: favours big areas holding many widgets in two or more columns,
  // with the widgets covering most of the area and being framework components.
  function scoreOf(c) {
    if (c.widgets < 2 || c.columns < 2) return 0;
    return Math.min(1, c.areaFrac) * Math.min(c.widgets, 16) * (0.5 + c.compFrac) * Math.min(1, c.coverage + 0.2);
  }

  // ---------- DOM ----------
  function rectOf(e) { return e.getBoundingClientRect(); }
  function isBox(e) {
    if (!e || e.nodeType !== 1 || e.id === "pc-root" || /^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT|BR|HR)$/.test(e.tagName)) return false;
    const r = rectOf(e);
    if (r.width < MIN_W || r.height < MIN_H) return false;
    const cs = getComputedStyle(e);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.position !== "fixed" && Number(cs.opacity) > 0;
  }
  function boxKids(p) { return [...p.children].filter(isBox); }
  // a wrapper with one box child that fills it is the same box: go down to the child
  function unwrap(e) {
    let cur = e;
    for (let i = 0; i < 6; i++) {
      const k = boxKids(cur);
      if (k.length !== 1) break;
      const a = rectOf(cur), b = rectOf(k[0]);
      if (b.width * b.height < a.width * a.height * 0.9 || cur.hasAttribute("data-pc-c")) break;
      cur = k[0];
    }
    return cur;
  }
  // a column: two or more boxes stacked on top of each other with roughly the same left edge
  function stacked(kids) {
    if (kids.length < 2) return false;
    const rs = kids.map(rectOf);
    const left = rs[0].left;
    return rs.every((r) => Math.abs(r.left - left) <= COL_TOL) && rs.every((r, i) => i === 0 || r.top >= rs[i - 1].bottom - 4);
  }
  // a pure layout box: no background, border, shadow or text of its own (a column, not a card)
  function plainBox(e) {
    const cs = getComputedStyle(e);
    const clear = (c) => c === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
    if (!clear(cs.backgroundColor) || cs.backgroundImage !== "none" || cs.boxShadow !== "none") return false;
    if (["Top", "Right", "Bottom", "Left"].some((s) => parseFloat(cs["border" + s + "Width"]) > 0)) return false;
    for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return false;
    return true;
  }
  // widgets under a container: its box children; a column (plain box with boxes stacked in it) expands into them
  function widgetsOf(container) {
    const out = [];
    for (const kid of boxKids(container)) {
      const k = unwrap(kid);
      const inner = boxKids(k);
      if (stacked(inner) && plainBox(k)) inner.forEach((x) => out.push(unwrap(x)));
      else out.push(k);
    }
    return out;
  }
  function describe(container, vw, vh) {
    const ws = widgetsOf(container);
    const rs = ws.map(rectOf);
    const cr = rectOf(container);
    const area = Math.max(1, cr.width * cr.height);
    const covered = rs.reduce((s, r) => s + r.width * r.height, 0);
    return {
      node: container, list: ws, rects: rs,
      widgets: ws.length,
      columns: groupColumns(rs.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }))).length,
      areaFrac: (cr.width * Math.min(cr.height, vh * 2)) / Math.max(1, vw * vh),
      coverage: covered / area,
      compFrac: ws.length ? ws.filter((w) => w.hasAttribute("data-pc-c")).length / ws.length : 0,
    };
  }

  // ---------- widget level (rule picked by the user) ----------
  // Boxes exactly n levels below the container.
  function atLevel(container, n) {
    let cur = [container];
    for (let i = 0; i < n; i++) { const next = []; for (const e of cur) for (const k of e.children) if (k.id !== "pc-root") next.push(k); cur = next; if (cur.length > 4000) break; }
    return cur.filter(isBox);
  }
  function depthOf(container, el) { let d = 0; for (let e = el; e && e !== container; e = e.parentElement) d++; return d; }
  // most common depth of the widgets below the container (the level the automatic choice used)
  function levelOf(container, list) {
    const count = new Map();
    for (const w of list) { const d = depthOf(container, w); count.set(d, (count.get(d) || 0) + 1); }
    let best = 1, n = -1; for (const [d, c] of count) if (c > n) { best = d; n = c; }
    return best;
  }
  function describeLevel(container, level, vw, vh) {
    const ws = atLevel(container, level);
    const rs = ws.map(rectOf);
    const cr = rectOf(container);
    const area = Math.max(1, cr.width * cr.height);
    return { node: container, list: ws, rects: rs, level, widgets: ws.length,
      columns: groupColumns(rs.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }))).length,
      areaFrac: (cr.width * Math.min(cr.height, vh * 2)) / Math.max(1, vw * vh),
      coverage: rs.reduce((x, r) => x + r.width * r.height, 0) / area,
      compFrac: ws.length ? ws.filter((w) => w.hasAttribute("data-pc-c")).length / ws.length : 0 };
  }
  // The user clicked one widget: find the container (an ancestor) and level that give the best widget set
  // containing it, scored like the automatic choice (two columns are not required here).
  function ruleFromSample(el) {
    const vw = innerWidth, vh = innerHeight;
    let best = null, bestScore = 0;
    let a = el.parentElement, d = 1;
    while (a && a !== document.documentElement && d <= 10) {
      const x = describeLevel(a, d, vw, vh);
      if (x.list.includes(el) && x.widgets >= 2) {
        // the same widgets seen from a bigger ancestor: keep the nearest container
        const same = best && best.list.length === x.list.length && x.list.every((w) => best.list.includes(w));
        const s = Math.min(1, x.areaFrac) * Math.min(x.widgets, 16) * (0.5 + x.compFrac) * Math.min(1, x.coverage + 0.2);
        if (!same && s > bestScore * 1.0001) { best = x; bestScore = s; }
      }
      a = a.parentElement; d++;
    }
    return best ? { container: best.node, level: best.level, count: best.widgets } : null;
  }
  // A selector that finds this element again: a stable id, else a short path of tags and stable classes.
  function cssPath(el) {
    const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v);
    const stableId = (id) => id && !/\d{3,}|^\d|[:]/.test(id);
    const stableClass = (c) => !/^(pc-|svelte-|css-|sc-|jsx-|ng-|v-)/.test(c) && !/[0-9a-f]{6,}|\d{2,}|__[a-z0-9]{5,}$/i.test(c)
      && !/^(active|on|open|selected|hover|focus|show|hide|hidden|is-|has-)/.test(c);
    const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (_e) { return false; } };
    if (stableId(el.id) && unique("#" + esc(el.id))) return "#" + esc(el.id);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e !== el && stableId(e.id) && unique("#" + esc(e.id))) { parts.unshift("#" + esc(e.id)); break; }
      let part = e.tagName.toLowerCase();
      const cls = [...e.classList].filter(stableClass).slice(0, 2);
      if (cls.length) part += "." + cls.map(esc).join(".");
      const p = e.parentElement;
      if (p && [...p.children].filter((x) => { try { return x.matches(part); } catch (_e) { return false; } }).length > 1) part += ":nth-child(" + ([...p.children].indexOf(e) + 1) + ")";
      parts.unshift(part);
      if (e === document.body || unique(parts.join(" > "))) break;
    }
    return parts.join(" > ");
  }

  function titleOf(node, rule) {
    const pick = (e) => (e && (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)) || "";
    const top = rectOf(node).top;
    for (const sel of ["h1,h2,h3,h4,h5,h6", "[role=heading]", "[class*='title' i]", "[class*='header' i]", "[class*='head' i]", "legend,caption,strong,b"]) {
      for (const e of node.querySelectorAll(sel)) {
        const r = rectOf(e);
        if (r.height > 0 && r.top - top < 80 && pick(e)) return { text: pick(e), el: e };
      }
    }
    const lab = node.getAttribute("aria-label") || node.getAttribute("title");
    if (lab) return { text: lab.trim().slice(0, 60), el: null };
    const f = node.querySelector("iframe[title]");
    if (f && f.title) return { text: f.title.trim().slice(0, 60), el: null };
    return { text: "", el: null };
  }

  function findContainer(doc, rule) {
    if (rule && rule.container) {
      let c = null;
      try { c = doc.querySelector(rule.container); } catch (_e) { c = null; }
      if (!c) return null;
      if (rule.level) return describeLevel(c, rule.level, innerWidth, innerHeight);
      return describe(c, innerWidth, innerHeight);
    }
    const vw = innerWidth, vh = innerHeight;
    let best = null, bestScore = 0, seen = 0;
    const walk = (e) => {
      if (seen++ > MAX_SCAN || e.id === "pc-root") return;
      const kids = e.children;
      if (kids.length >= 2 && isBox(e)) {
        const d = describe(e, vw, vh);
        const s = scoreOf(d);
        if (s > bestScore * 1.0001) { best = d; bestScore = s; }
      }
      for (const k of kids) walk(k);
    };
    if (doc.body) walk(doc.body);
    return best;
  }

  // Result: { container, columns:[{width, flex, items:[{node, title, titleEl, comp, src}]}], framework, mode }
  function detect(doc, rule) {
    const d = findContainer(doc, rule);
    if (!d) return null;
    const list = d.list, rects = d.rects;
    if (!list.length) return null;
    const groups = groupColumns(rects.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height })));
    const widths = groups.map((g) => Math.round(Math.max(...g.map((i) => rects[i].width))));
    const widest = widths.indexOf(Math.max(...widths));
    const columns = groups.map((g, ci) => {
      return {
        width: widths[ci],
        items: g.map((i) => {
          const node = list[i];
          const tt = titleOf(node, rule);
          const frames = node.querySelectorAll("iframe");
          return { node, title: tt.text, titleEl: tt.el, comp: node.getAttribute("data-pc-c") || "", src: frames.length === 1 ? frames[0].src : "", height: Math.round(rects[i].height) };
        }),
      };
    });
    columns.forEach((c, i) => { c.flex = i === widest; });
    const fw = doc.documentElement.getAttribute("data-pc-fw") || "";
    return { container: d.node, columns, framework: fw, mode: rule && rule.container ? "rule" : d.compFrac > 0 ? "framework" : "dom", level: d.level || levelOf(d.node, list) };
  }

  const api = { groupColumns, scoreOf, detect, titleOf, atLevel, levelOf, ruleFromSample, cssPath, describeLevel, isBox };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PCDetect = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
