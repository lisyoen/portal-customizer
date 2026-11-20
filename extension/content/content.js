// Portal Customizer content script: rebuilds a portal page's main area from a saved layout.
// The widgets of the page (found by PCDetect: framework components, else plain boxes) are never moved out of
// the page's own DOM (the framework owns them); their container is hidden and the widgets used by the layout
// are positioned over their slot every animation frame.
(() => {
  "use strict";
  if (window.__portalCustomizerLoaded) return;
  window.__portalCustomizerLoaded = true;

  const L = globalThis.PCLayout;
  const t = (k, subs) => { try { return chrome.i18n.getMessage(k, subs) || k; } catch (_e) { return k; } };
  const D = globalThis.PCDetect;
  const SITE = location.origin + location.pathname; // layouts are kept per page address
  const KEYS = ["enabled", "editMode", "sites", "orgConfig", "adminToken"];

  const S = { enabled: true, editMode: false, sites: {}, orgConfig: null, adminToken: "" };
  function site() { return (S.sites && S.sites[SITE]) || {}; }
  // the organization layout applies to the pages its "match" list names (address prefixes)
  function orgApplies() { return !!(S.orgConfig && S.orgConfig.layout && L.matchesSite(S.orgConfig.match, location.href)); }
  // Widget rule (container + level) picked in edit mode: this page's own pick, else the one saved with the
  // layout in use (sent to the admin server with it), else the organization's.
  function siteRule() {
    const lay = effectiveLayout();
    return site().rule || (lay && lay.site) || (orgApplies() && S.orgConfig.site) || null;
  }
  function active() { return S.enabled && (site().on || orgApplies()); }
  // Edit mode is for administrators only: without an admin login (popup) the page never enters it.
  // One console line per state change, so "nothing happens" can be told apart from "not running here".
  function say(msg) { if (say.last === msg) return; say.last = msg; try { console.info("[Portal Customizer " + chrome.runtime.getManifest().version + "] " + msg); } catch (_e) { /* extension reloaded */ } }
  function gateEdit() { if (!S.adminToken && S.editMode) { say("edit mode needs an administrator login"); S.editMode = false; draft = null; } }
  let catalog = new Map();       // key -> { key, title, titleEl, comp, node, height }
  let lastStructure = null;      // columns found by the last detection (the page as it was)
  let detected = null;           // { container, framework, mode }
  const naturalHeight = new Map(); // key -> first measured height
  let mounted = null;            // { container, root }
  let draft = null;              // layout being edited
  let slots = new Map();         // panelId -> { key, ph, body }
  const touched = new Map();     // element -> original style attribute
  let rafId = 0;
  let settleTimer = 0;
  let keptTops = new Map();       // column scroll positions kept across a remount
  let asIs = "";                 // signature of the layout last found to match the page (nothing drawn)
  // Saved widgets that have not appeared yet: wait while the page keeps adding widgets (up to WAIT_MAX ms, and
  // only while the found set changed in the last WAIT_STILL ms), then mount with what is there. Widgets that show
  // up later (until LATE_MS after load) trigger a new mount; the whole remount runs in one task, so nothing flashes.
  const WAIT_MAX = 4000, WAIT_STILL = 800, LATE_MS = 20000;
  const loadedAt = Date.now();
  let waitStart = 0, waitSig = "", waitChange = 0, waitTimer = 0;
  let missingKeys = [];          // saved widgets not on the page at the last mount
  let forceFresh = false;
  // Custom panels rendered in view mode are kept between re-renders when unchanged, so a carousel position,
  // a feed tab or a search text survive the page re-creating its widgets. Each keeps its own timers.
  let panelCache = new Map();    // panelId -> { sig, node, ctx:{timers, cleanups} }
  let usedCache = null;
  function disposeCtx(ctx) { ctx.timers.forEach(clearInterval); ctx.cleanups.forEach((f) => f()); }
  function clearTimers() { panelCache.forEach((c) => disposeCtx(c.ctx)); panelCache = new Map(); }
  const M = globalThis.PCMedia;
  let contextAlive = true;

  // ---------- helpers ----------
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children || [])) if (c != null) e.append(c);
    return e;
  }
  function toast(msg) {
    const n = el("div", { class: "pc-toast", text: msg });
    document.body.append(n);
    setTimeout(() => n.remove(), 2600);
  }
  function remember(e) { if (!touched.has(e)) touched.set(e, e.getAttribute("style")); }
  function setStyle(e, prop, value) {
    if (e.style.getPropertyValue(prop) !== value || e.style.getPropertyPriority(prop) !== "important") {
      remember(e);
      e.style.setProperty(prop, value, "important");
    }
  }
  function restoreStyles() {
    for (const [e, s] of touched) { if (s == null) e.removeAttribute("style"); else e.setAttribute("style", s); }
    touched.clear();
    document.querySelectorAll(".pc-proxied").forEach((n) => n.classList.remove("pc-proxied", "pc-part"));
    document.querySelectorAll("[data-pc-container],[data-pc-pass]").forEach((n) => { n.removeAttribute("data-pc-container"); n.removeAttribute("data-pc-pass"); });
  }
  function effectiveLayout() {
    const st = site();
    if (st.customized && st.userLayout) return st.userLayout;
    if (orgApplies()) return S.orgConfig.layout;
    return null;
  }
  // The early script hides the widget area until the layout is mounted; drop that when nothing will be drawn.
  function uncloak() { const c = document.getElementById("pc-cloak"); if (c) c.remove(); }
  // remember where the widget area was, so the early script can hide it on the next load
  function rememberCloak(container) {
    const r = siteRule();
    const sel = (r && r.container) || (D.cssPath ? D.cssPath(container) : "");
    const k = "cloak:" + SITE;
    if (!sel || rememberCloak.last === sel) return;
    rememberCloak.last = sel;
    try { chrome.storage.local.get(k).then((o) => { if (o[k] !== sel) storageSet({ [k]: sel }); }).catch(() => {}); } catch (_e) { contextAlive = false; }
  }
  // remember that this page's layout matches the page, so the early script does not hide it on the next load
  function rememberAsIs(v) {
    const k = "asis:" + SITE;
    if (rememberAsIs.last === v) return;
    rememberAsIs.last = v;
    try { chrome.storage.local.get(k).then((o) => { if ((o[k] || "") !== v) { if (v) storageSet({ [k]: v }); else chrome.storage.local.remove(k); } }).catch(() => {}); } catch (_e) { contextAlive = false; }
  }
  // elements n levels below the container (no layout checks: the container is hidden while mounted)
  function levelCount(container, n) {
    let cur = [container];
    for (let i = 0; i < n && cur.length < 4000; i++) cur = cur.flatMap((e) => [...e.children].filter((k) => k.id !== "pc-root"));
    return cur.length;
  }
  function keepWaiting() {
    const now = Date.now();
    if (!waitStart) { waitStart = now; waitChange = now; waitSig = ""; }
    const sig = [...catalog.keys()].join("|");
    if (sig !== waitSig) { waitSig = sig; waitChange = now; }
    return now - waitStart < WAIT_MAX && now - waitChange < WAIT_STILL;
  }
  function storageSet(obj) {
    try { return chrome.storage.local.set(obj); } catch (_e) { contextAlive = false; return Promise.resolve(); }
  }

  // ---------- the page's own look around the widgets ----------
  // Measured while the page is in its own shape (scan): the container's margin, padding, border and background,
  // each column element's background and borders, and the widget-free parts above the first widget (menus, tabs,
  // spacing) of the container and of each column. #pc-root and its columns copy the look; the parts are shown over
  // their place like the widgets, so a layout made from the page looks like the page.
  let look = null;
  function measureLook(r) {
    const cont = r.container, cr = cont.getBoundingClientRect(), cs = getComputedStyle(cont);
    const px = (v) => parseFloat(v) || 0;
    const groups = r.columns.map((c) => c.items.map((it) => it.node));
    const all = groups.flat();
    const holds = (e) => all.some((w) => e === w || e.contains(w));
    // the element of each column: the biggest wrapper below the container holding its widgets and no others
    const colEls = groups.map((g, gi) => {
      if (!g.length) return null;
      const others = groups.filter((_, j) => j !== gi).flat();
      let a = g[0].parentElement;
      while (a && a !== cont && !g.every((w) => a.contains(w))) a = a.parentElement;
      if (!a || a === cont || !cont.contains(a) || others.some((w) => a.contains(w))) return null;
      while (a.parentElement && a.parentElement !== cont && !others.some((w) => a.parentElement.contains(w))) a = a.parentElement;
      return a;
    });
    const skip = new Set(colEls.filter(Boolean));
    const firstTops = groups.map((g) => Math.min(...g.map((w) => w.getBoundingClientRect().top)));
    const shown = (e) => { const st = getComputedStyle(e); return st.display !== "none" && st.visibility !== "hidden" && st.position !== "fixed" && Number(st.opacity) > 0; };
    const parts = [];
    const collect = (from, limit, col, ref) => {
      const walk = (e) => {
        for (const k of e.children) {
          if (skip.has(k) || (k.id || "").startsWith("pc-") || /^(SCRIPT|STYLE|TEMPLATE|LINK|META)$/.test(k.tagName)) continue;
          if (holds(k)) { walk(k); continue; }
          const kr = k.getBoundingClientRect();
          if (kr.width < 1 || kr.height < 1 || kr.top >= limit || kr.bottom > limit + 1 || !shown(k)) continue;
          parts.push({ node: k, col, x: kr.left - ref.left, y: kr.top - ref.top, w: kr.width, h: kr.height, stretch: kr.width > ref.width * 0.6 ? ref.width - kr.width : null });
        }
      };
      walk(from);
    };
    const colTops = groups.map((g, i) => (colEls[i] ? colEls[i].getBoundingClientRect().top : firstTops[i]));
    const minTop = Math.min(...colTops);
    collect(cont, minTop, null, cr);
    // #pc-root starts where the highest column starts; each column then keeps its own distance from there to its
    // first widget (column margins and paddings of the page), so the widgets land where they were
    const innerTop0 = cr.top + px(cs.borderTopWidth) + px(cs.paddingTop);
    const base = Math.max(innerTop0, minTop);
    const innerLeft = cr.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const firstLeft = groups[0] && groups[0].length ? Math.min(...groups[0].map((w) => w.getBoundingClientRect().left)) : innerLeft;
    const borderOf = (st, side) => {
      const w = px(st["border" + side + "Width"]), style = st["border" + side + "Style"];
      return w && style !== "none" && style !== "hidden" ? { w, style, color: st["border" + side + "Color"] } : null;
    };
    // a column scrolls on its own when an element between its widgets and the container scrolls vertically
    const scrolls = groups.map((g) => {
      if (!g.length) return false;
      for (let e = g[0].parentElement; e && e !== cont; e = e.parentElement) if (/auto|scroll/.test(getComputedStyle(e).overflowY)) return true;
      return false;
    });
    const cols = colEls.map((c, i) => {
      const padTop = Math.max(0, Math.round(firstTops[i] - base));
      if (!c) return { padTop, shadow: "", bg: "", scroll: scrolls[i] };
      const cr2 = c.getBoundingClientRect(), st = getComputedStyle(c);
      // parts are placed from the top-left of our column: the first widget's left edge, the root's inner top
      const wl = Math.min(...groups[i].map((w) => w.getBoundingClientRect().left));
      collect(c, firstTops[i], i, { left: wl, top: base, width: cr2.width });
      // borders become outer shadows so they do not take space from the widgets
      const sh = [];
      [["Left", -1, 0], ["Right", 1, 0], ["Top", 0, -1], ["Bottom", 0, 1]].forEach(([side, dx, dy]) => {
        const b = borderOf(st, side);
        if (b) sh.push(`${dx * b.w}px ${dy * b.w}px 0 0 ${b.color}`);
      });
      return { padTop, shadow: sh.join(", "), bg: st.backgroundColor, scroll: scrolls[i] };
    });
    const innerTop = cr.top + px(cs.borderTopWidth) + px(cs.paddingTop);
    const borders = {};
    for (const side of ["Top", "Right", "Bottom", "Left"]) { const b = borderOf(cs, side); borders[side] = b ? `${b.w}px ${b.style} ${b.color}` : ""; }
    return {
      root: { margin: cs.margin, padding: cs.padding, padTop: px(cs.paddingTop) + Math.max(0, Math.round(minTop - innerTop)),
        padLeft: px(cs.paddingLeft) + Math.max(0, Math.round((firstLeft - innerLeft) * 2) / 2),
        borders, bg: cs.backgroundColor, bgImage: cs.backgroundImage, radius: cs.borderRadius },
      cols, parts,
    };
  }
  function applyRootLook(root) {
    const lk = look && look.root;
    if (!lk) return;
    root.style.margin = lk.margin;
    root.style.padding = lk.padding;
    root.style.paddingTop = lk.padTop + "px";
    if (lk.padLeft != null) root.style.paddingLeft = lk.padLeft + "px";
    for (const side of ["Top", "Right", "Bottom", "Left"]) if (lk.borders[side]) root.style["border" + side] = lk.borders[side];
    if (!/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(lk.bg)) root.style.backgroundColor = lk.bg;
    if (lk.bgImage && lk.bgImage !== "none") root.style.backgroundImage = lk.bgImage;
    if (lk.radius && lk.radius !== "0px") root.style.borderRadius = lk.radius;
  }
  function applyColumnLook(c, index) {
    const lk = look && look.cols && look.cols[index];
    if (!lk) return;
    if (lk.padTop) c.style.paddingTop = lk.padTop + "px";
    if (lk.shadow) c.style.boxShadow = lk.shadow;
    const bg = !!lk.bg && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(lk.bg);
    if (bg) c.style.backgroundColor = lk.bg;
    if (lk.shadow || bg) c.style.alignSelf = "stretch";
  }
  // the widget-free parts follow their anchor (#pc-root or their column) every frame
  function placeParts(base) {
    if (!look || !look.parts.length) return;
    const cols = [...mounted.root.querySelectorAll(":scope > .pc-col")];
    const rootR = mounted.root.getBoundingClientRect();
    for (const p of look.parts) {
      if (!p.node.isConnected) continue;
      const anchor = p.col == null ? mounted.root : cols[p.col];
      if (!anchor) { if (p.node.classList.contains("pc-proxied")) resetNode(p.node); continue; }
      const ar = p.col == null ? rootR : anchor.getBoundingClientRect();
      if (!p.node.classList.contains("pc-proxied")) { p.node.classList.add("pc-proxied", "pc-part"); passThrough(p.node); }
      setStyle(p.node, "left", Math.round(ar.left + p.x - base.left) + "px");
      setStyle(p.node, "top", Math.round(ar.top + p.y - base.top) + "px");
      setStyle(p.node, "width", Math.round(p.stretch != null ? Math.max(0, ar.width - p.stretch) : p.w) + "px");
      setStyle(p.node, "height", Math.round(p.h) + "px");
      setStyle(p.node, "clip-path", "none");
    }
  }

  // ---------- catalog of the page's widgets ----------
  // Detection needs the page in its own shape, so it only runs while nothing is mounted.
  function probe() { try { document.dispatchEvent(new CustomEvent("pc:probe")); } catch (_e) { /* ignore */ } }
  function scan() {
    probe();
    // detection skips hidden boxes: lift the early hiding for the (synchronous, so never painted) detection
    const cloak = document.getElementById("pc-cloak");
    if (cloak && cloak.sheet) cloak.sheet.disabled = true;
    let r = null;
    try { r = D.detect(document, siteRule()); } finally { if (cloak && cloak.sheet) cloak.sheet.disabled = false; }
    const map = new Map();
    if (!r) { catalog = map; detected = null; lastStructure = []; return null; }
    // the page's own spacing: space left of each column (from the previous column's widgets) and above each widget
    const rectOf = (n) => n.getBoundingClientRect();
    let prevRight = null;
    const ruleSig = JSON.stringify(siteRule() || r.level || null);
    const gapsOf = r.columns.map((c) => {
      const rs = c.items.map((it) => rectOf(it.node));
      if (!rs.length) return { col: null, items: [] };
      const left = Math.min(...rs.map((x) => x.left));
      const col = prevRight == null ? null : Math.max(0, left - prevRight);
      prevRight = Math.max(...rs.map((x) => x.right));
      return { col, items: rs.map((x, i) => (i ? Math.max(0, x.top - rs[i - 1].bottom) : null)) };
    });
    const columns = r.columns.map((c, ci) => ({
      width: c.width, flex: c.flex, gap: gapsOf[ci].col,
      items: c.items.map((it, n) => {
        let key = L.nativeKey({ src: it.src, comp: it.comp, title: it.title, base: location.href });
        let k = key, i = 2;
        while (map.has(k)) k = key + "~" + (i++);
        key = k;
        // first height seen per widget unit: a widget at another level can share the key (same frame address)
        const hk = ruleSig + "|" + key;
        if (!naturalHeight.has(hk)) naturalHeight.set(hk, it.height || 200);
        const info = { key, title: it.title || it.comp || t("widget") + " " + (n + 1), titleEl: it.titleEl, comp: it.comp, node: it.node, height: naturalHeight.get(hk), src: it.src, gap: gapsOf[ci].items[n] };
        map.set(key, info);
        return info;
      }),
    }));
    catalog = map;
    // level/count: how many boxes sit at the widget level, to notice cheaply when the page adds a widget later
    detected = { container: r.container, framework: r.framework, mode: r.mode, level: r.level, count: r.level ? levelCount(r.container, r.level) : 0 };
    lastStructure = columns;
    try { look = measureLook(r); } catch (e) { look = null; console.warn("portal-customizer look", e); }
    try { document.documentElement.setAttribute("data-pc-widgets", String(map.size)); } catch (_e) { /* ignore */ }
    return columns;
  }
  function update() {
    if (!contextAlive) return;
    if (picker) { uncloak(); return; } // choosing the widget level: the page stays as it is
    if (!active()) { say(!S.enabled ? "off (Portal Customizer turned off)" : "off on this page"); uncloak(); unmount(); return; }
    if (S.editMode) say("edit mode: rule=" + (siteRule() ? JSON.stringify(siteRule()) : "none") + " layout=" + (effectiveLayout() ? (site().customized ? "mine" : "organization") : "none"));
    // first edit of a page without a widget rule or layout: let the user confirm the widget level first
    // first edit of a page whose widget unit was never confirmed (also when an organization layout already
    // applies, e.g. one made before the widget unit existed): let the user confirm it first
    if (S.editMode && !draft && !siteRule() && !pickerShown) { pickerShown = true; uncloak(); openPicker(); return; }
    let layout = null;
    if (S.editMode) layout = draft || effectiveLayout();
    else layout = effectiveLayout();
    if (!layout && !S.editMode) {
      // nothing to draw yet: still look at the page so the popup can tell what was found
      uncloak();
      unmount();
      if (!catalog.size || [...catalog.values()].some((i) => !i.node.isConnected)) scan();
      return;
    }
    // the layout was found to match the page: keep the page as it is while its widgets stay
    if (!S.editMode && asIs && !mounted && !forceFresh && asIs === L.sig(layout) && catalog.size && [...catalog.values()].every((i) => i.node.isConnected)) { uncloak(); return; }
    const fresh = forceFresh || !mounted || !mounted.root.isConnected || !mounted.container.isConnected || [...catalog.values()].some((i) => !i.node.isConnected);
    forceFresh = false;
    if (fresh) {
      const hadMount = !!mounted;
      unmount();
      const structure = scan();
      if (!structure || !detected) {
        // edit mode must never silently do nothing: no widgets found → the picker (choose a sample widget)
        say("no widgets found" + (siteRule() ? " with the widget unit " + JSON.stringify(siteRule()) : ""));
        if (S.editMode && !draft) {
          if (!pickerShown) { pickerShown = true; uncloak(); openPicker(); }
          else if (!update.told) { update.told = true; toast(t("editNoWidgets")); }
        }
        return;
      }
      // widgets of a saved layout may appear a little after the page loads: wait while more keep coming
      const want = layout ? [...L.usedNativeKeys(layout)] : [];
      const missing = want.filter((k) => !catalog.has(k));
      if (missing.length && !hadMount && keepWaiting()) {
        clearTimeout(waitTimer);
        waitTimer = setTimeout(update, 200);
        return;
      }
      missingKeys = missing;
      // a layout that is the page's own arrangement is not drawn at all: the page stays untouched (no moving)
      if (!S.editMode && layout && !missing.length && L.matchesPage(layout, structure)) {
        asIs = L.sig(layout);
        rememberAsIs(asIs);
        uncloak();
        say("layout matches the page: left as is (" + catalog.size + " widgets)");
        document.documentElement.setAttribute("data-pc-asis", "1");
        return;
      }
      if (asIs) { asIs = ""; rememberAsIs(""); }
      document.documentElement.removeAttribute("data-pc-asis");
      // only the page's own widgets: the first look may have come before the page settled (styles, fonts, data),
      // so look again a few times shortly after load; a match then gives the page back untouched
      // (only for a layout with the page's widgets in the page's order and no height set by hand)
      const sameWidgets = layout && layout.columns.length === structure.length && layout.columns.every((c, ci) => c.panels.length === structure[ci].items.length
        && c.panels.every((p, pi) => p.type === "native" && !p.hidden && p.header !== false && p.auto && p.key === structure[ci].items[pi].key));
      if (!S.editMode && sameWidgets && Date.now() - loadedAt < 6000) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => { if (mounted && !S.editMode && !draft) { forceFresh = true; update(); } }, 1200);
      }
      if (S.editMode && !draft) { draft = L.clone(freshDraft || !layout ? L.fromCatalog(structure) : layout); freshDraft = false; }
      if (S.editMode) layout = draft;
      const container = detected.container;
      const root = el("div", { id: "pc-root" });
      root.style.minHeight = Math.max(200, Math.round(container.getBoundingClientRect().height)) + "px";
      applyRootLook(root);
      container.parentElement.insertBefore(root, container);
      container.setAttribute("data-pc-container", detected.mode);
      mounted = { container, root, scroll: scrollMode(root) };
      lockScroll();
      if (mounted.scroll) { root.classList.add("pc-scroll-cols"); root.style.minHeight = ""; fitHeight(); }
      say("layout shown: " + catalog.size + " widgets (" + detected.mode + (detected.framework ? ", " + detected.framework : "") + ")" + (missingKeys.length ? ", not on this page: " + missingKeys.length : "") + (S.editMode ? ", editing" : ""));
      document.documentElement.classList.add("pc-active");
      rememberCloak(container);
      attachEditHandlers(root);
    } else if (S.editMode && !draft) {
      draft = L.clone(layout || L.fromCatalog(lastStructure));
      layout = draft;
    }
    render(layout);
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function unmount() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    locked = [];
    if (mounted) { keptTops = new Map([...mounted.root.querySelectorAll(".pc-col-body")].map((b) => [b.dataset.colBody, b.scrollTop])); mounted.root.remove(); }
    mounted = null;
    slots = new Map();
    clearTimers();
    restoreStyles();
    document.documentElement.classList.remove("pc-active", "pc-editing");
    removeToolbar();
  }

  // Our title bars follow the look of the page's own widget titles.
  function copyHeaderLook(root) {
    const first = [...catalog.values()].find((i) => i.titleEl && i.titleEl.isConnected);
    const title = first && first.titleEl;
    const head = title && (title.parentElement && title.parentElement !== first.node ? title.parentElement : title);
    if (!head) return;
    const hs = getComputedStyle(head), ts = getComputedStyle(title || head);
    const set = (k, v) => { if (v) root.style.setProperty(k, v); };
    set("--pc-head-bg", hs.backgroundColor);
    set("--pc-head-pad", hs.padding);
    set("--pc-head-border", hs.borderBottomWidth !== "0px" ? `${hs.borderBottomWidth} ${hs.borderBottomStyle} ${hs.borderBottomColor}` : "");
    set("--pc-head-color", ts.color);
    set("--pc-head-size", ts.fontSize);
    set("--pc-head-weight", ts.fontWeight);
    set("--pc-head-lh", ts.height && ts.height !== "auto" ? ts.height : "");
  }

  // Removing a focused input while rendering fires blur handlers that may ask for another render:
  // never render inside a render, run it right after instead.
  let rendering = false, renderAgain = null;
  function render(layout) {
    if (rendering) { renderAgain = layout; return; }
    rendering = true;
    try { renderNow(layout); } finally { rendering = false; }
    if (renderAgain) { const next = renderAgain; renderAgain = null; render(S.editMode && draft ? draft : next); }
  }
  function renderNow(layout) {
    const root = mounted.root;
    copyHeaderLook(root);
    const editing = S.editMode && S.enabled;
    root.classList.toggle("pc-edit", editing);
    document.documentElement.classList.toggle("pc-editing", editing);
    slots = new Map();
    if (editing) clearTimers();
    usedCache = new Map();
    // columns that scroll keep their position when the layout is drawn again
    const bodies = [...root.querySelectorAll(".pc-col-body")];
    const tops = bodies.length ? new Map(bodies.map((b) => [b.dataset.colBody, b.scrollTop])) : keptTops;
    keptTops = new Map();
    const cols = layout.columns.map((col, i) => renderColumn(col, editing, layout, i));
    root.replaceChildren(...cols);
    if (tops.size) root.querySelectorAll(".pc-col-body").forEach((b) => { const v = tops.get(b.dataset.colBody); if (v) b.scrollTop = v; });
    panelCache.forEach((c, id) => { if (!usedCache.has(id)) disposeCtx(c.ctx); });
    panelCache = usedCache;
    usedCache = null;
    // widgets no longer used: drop their proxy styles
    const used = new Set([...slots.values()].map((s) => s.key));
    for (const info of catalog.values()) if (!used.has(info.key) && info.node.classList.contains("pc-proxied")) resetNode(info.node);
    if (editing) showToolbar(); else removeToolbar();
  }

  function renderColumn(col, editing, layout, index) {
    const c = el("div", { class: "pc-col" + (col.flex ? " pc-flex" : ""), "data-col": col.id });
    if (!col.flex) c.style.width = col.width + "px";
    applyColumnLook(c, index);
    // space between columns (left of this column)
    const cg = L.colGap(layout, col);
    c.style.marginLeft = (index === 0 ? 0 : cg) + "px";
    if (editing && index > 0) c.append(gapHandle({ col: col.id }, cg, col.gap != null, "x"));
    if (editing) {
      c.append(el("div", { class: "pc-col-head", draggable: "true", "data-drag-col": col.id, title: t("dragColumn") }, [
        el("span", { text: "⠿" }),
        el("span", { class: "pc-grow", text: col.flex ? t("fillWidth") : col.width + "px" }),
        el("button", { class: "pc-btn-icon", title: t("toggleFill"), text: "↔", onclick: () => edit(L.setColumn(draft, col.id, col.flex ? { width: 380 } : { flex: 1 })) }),
        el("button", { class: "pc-btn-icon", title: t("deleteColumn"), text: "✕", onclick: () => {
          if (draft.columns.length <= 1) return toast(t("lastColumn"));
          if (!col.panels.length || confirm(t("confirmDeleteColumn"))) edit(L.removeColumn(draft, col.id));
        } }),
      ]));
    }
    const body = el("div", { class: "pc-col-body", "data-col-body": col.id });
    if (mounted && mounted.scroll) {
      // the scrollbar sits in the space right of the column (like the page's own), except for the last column
      const last = index === layout.columns.length - 1;
      if (!last && scrollbarWidth()) { body.style.marginRight = -scrollbarWidth() + "px"; body.style.scrollbarGutter = "stable"; }
    }
    let first = true;
    for (const p of col.panels) {
      if (p.hidden && !editing) continue;
      const node = renderPanel(p, editing);
      if (!node) continue;
      const g = first ? 0 : L.panelGap(layout, p);
      node.style.marginTop = g + "px";
      node.querySelectorAll(":scope > .pc-gap, :scope > .pc-panel-head > .pc-gapctl").forEach((h) => h.remove());
      if (editing && !first) panelGapControls(node, p, g);
      body.append(node);
      first = false;
    }
    c.append(body);
    if (editing) c.append(el("div", { class: "pc-col-resize", "data-resize-col": col.id, title: t("resizeColumn") }));
    return c;
  }

  // Handle in the space before a panel (y) or a column (x): drag to change, click the number to type it,
  // double-click to go back to the default.
  // Space above a panel: a number box in the panel's title bar (type, arrows, mouse wheel) and a strip in the
  // gap that can be dragged. Changes apply at once without rebuilding the page.
  function panelGapControls(node, p, value) {
    const target = { panel: p.id };
    const strip = el("div", { class: "pc-gap pc-gap-y", "data-gap": JSON.stringify(target), title: t("gapHint"), style: { top: -value + "px", height: value + "px" } });
    const inp = el("input", { type: "number", class: "pc-gapctl-input", min: 0, max: 200, step: 1, value: String(value), title: t("gapAbove") });
    const ctl = el("label", { class: "pc-gapctl" + (p.gap != null ? " pc-custom" : ""), title: t("gapAbove") }, [el("span", { class: "pc-gapctl-icon", text: "↕" }), inp,
      el("button", { type: "button", class: "pc-btn-icon pc-gapctl-reset", title: t("gapReset"), text: "↺", onclick: (e) => { e.preventDefault(); edit(L.setGap(draft, target, null)); } })]);
    const apply = (v, keep) => {
      v = Math.max(0, Math.min(200, Math.round(Number(v) || 0)));
      node.style.marginTop = v + "px";
      strip.style.top = -v + "px";
      strip.style.height = v + "px";
      if (!keep) inp.value = String(v);
      draft = L.setGap(draft, target, v);
      ctl.classList.add("pc-custom");
    };
    inp.addEventListener("input", () => { if (inp.value !== "") apply(inp.value, true); });
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
    inp.addEventListener("pointerdown", (e) => e.stopPropagation());
    inp.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });
    inp.addEventListener("wheel", (e) => { e.preventDefault(); apply((Number(inp.value) || 0) + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    strip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const start = e.clientY, base = Number(inp.value) || 0;
      const move = (ev) => apply(base + ev.clientY - start);
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    strip.addEventListener("dblclick", (e) => { e.stopPropagation(); edit(L.setGap(draft, target, null)); });
    node.append(strip);
    const title = node.querySelector(":scope > .pc-panel-head > .pc-title");
    if (title) title.after(ctl);
  }

  function gapHandle(target, value, custom, axis) {
    const label = el("button", { type: "button", class: "pc-gap-pill" + (custom ? " pc-custom" : ""), title: t("gapHint"), text: String(value) });
    const h = el("div", { class: "pc-gap pc-gap-" + axis, "data-gap": JSON.stringify(target), style: axis === "y" ? { top: -value + "px", height: value + "px" } : { left: -value + "px", width: value + "px" } }, label);
    let clickTimer = 0;
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      if (h.dataset.dragged) { delete h.dataset.dragged; return; }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => openInput(), 250); // wait: a double-click resets instead
    });
    const openInput = () => {
      if (!label.isConnected) return;
      const inp = el("input", { type: "number", class: "pc-gap-input", min: 0, max: 200, step: 1, value: String(value) });
      let closed = false;
      const done = (apply) => {
        if (closed || !inp.isConnected) return;
        closed = true;
        if (apply) edit(L.setGap(draft, target, inp.value === "" ? null : inp.value)); else inp.replaceWith(label);
      };
      inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") done(true); if (ev.key === "Escape") done(false); });
      inp.addEventListener("blur", () => done(true));
      label.replaceWith(inp);
      inp.focus();
      inp.select();
    };
    label.addEventListener("dblclick", (e) => { e.stopPropagation(); clearTimeout(clickTimer); edit(L.setGap(draft, target, null)); });
    h.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "INPUT" || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const start = axis === "y" ? e.clientY : e.clientX;
      const node = axis === "y" ? h.parentElement : h.parentElement; // panel or column
      let v = value;
      const move = (ev) => {
        const d = (axis === "y" ? ev.clientY : ev.clientX) - start;
        if (Math.abs(d) > 2) h.dataset.dragged = "1";
        v = Math.max(0, Math.min(200, Math.round(value + d)));
        if (axis === "y") { node.style.marginTop = v + "px"; h.style.top = -v + "px"; h.style.height = v + "px"; }
        else { node.style.marginLeft = v + "px"; h.style.left = -v + "px"; h.style.width = v + "px"; }
        label.textContent = String(v);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (h.dataset.dragged) { edit(L.setGap(draft, target, v)); }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    return h;
  }

  function openGapSettings() {
    const pg = draft.gaps && draft.gaps.panel != null ? draft.gaps.panel : "";
    const cg = draft.gaps && draft.gaps.col != null ? draft.gaps.col : "";
    const reset = el("input", { type: "checkbox", name: "reset" });
    const form = el("form", { class: "pc-modal" }, [el("h3", { text: t("gapSettings") }),
      el("label", { text: t("gapPanelDefault") }), el("input", { type: "number", name: "panel", min: 0, max: 200, value: String(pg), placeholder: String(L.DEFAULT_PANEL_GAP) }),
      el("label", { text: t("gapColDefault") }), el("input", { type: "number", name: "col", min: 0, max: 200, step: 0.5, value: String(cg), placeholder: String(L.DEFAULT_COL_GAP) }),
      el("label", { class: "pc-row" }, [reset, document.createTextNode(" " + t("gapResetOverrides"))]),
      el("div", { class: "pc-hint", text: t("gapHint") }),
      el("div", { class: "pc-actions" }, [el("button", { type: "button", text: t("cancel"), onclick: () => back.remove() }), el("button", { type: "submit", class: "pc-primary", text: t("apply") })])]);
    const back = el("div", { class: "pc-modal-back" }, form);
    back.addEventListener("pointerdown", (e) => { if (e.target === back) back.remove(); });
    form.addEventListener("keydown", (e) => { if (e.key === "Escape") back.remove(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      back.remove();
      edit(L.setGap(draft, { defaults: { panel: form.elements.panel.value, col: form.elements.col.value }, resetOverrides: reset.checked }, null));
    });
    document.body.append(back);
    form.elements.panel.focus();
  }

  function renderPanel(p, editing) {
    if (p.type !== "native" && !editing) {
      const sig = JSON.stringify(p);
      const c = panelCache.get(p.id);
      if (c && c.sig === sig) { usedCache.set(p.id, c); return c.node; }
      const ctx = { timers: [], cleanups: [] };
      const node = buildPanel(p, editing, ctx);
      usedCache.set(p.id, { sig, node, ctx });
      return node;
    }
    return buildPanel(p, editing, { timers: [], cleanups: [] });
  }

  function buildPanel(p, editing, ctx) {
    const timers = ctx.timers;
    const native = p.type === "native";
    const info = native ? catalog.get(p.key) : null;
    if (native && !info && !editing) return null;
    const box = el("div", { class: "pc-panel pc-type-" + p.type + (native ? " pc-native" : "") + (p.hidden ? " pc-hidden-panel" : ""), "data-panel": p.id, "data-title": p.title || (info && info.title) || "", "data-key": native ? p.key : null });
    const h = p.height || (native && info ? info.height : null);
    if (h) box.style.height = h + "px"; else box.classList.add("pc-fill");
    const showHead = editing || (!native && p.header !== false);
    let iframeEl = null;
    if (showHead) {
      const head = el("div", { class: "pc-panel-head", draggable: editing ? "true" : null, "data-drag-panel": editing ? p.id : null }, [
        el("span", { class: "pc-title", text: p.title || (info && info.title) || t("type_" + p.type) }),
      ]);
      if (editing && p.header === false) head.append(el("span", { class: "pc-badge", text: t("titleHidden") }));
      if (editing) {
        head.append(
          el("button", { class: "pc-btn-icon", title: t("panelSettings"), text: "⚙", onclick: () => openSettings(p.id) }),
          el("button", { class: "pc-btn-icon", title: p.hidden ? t("showPanel") : t("hidePanel"), text: p.hidden ? "◌" : "◉", onclick: () => edit(L.updatePanel(draft, p.id, { hidden: !p.hidden })) }),
          el("button", { class: "pc-btn-icon", title: t("deletePanel"), text: "✕", onclick: () => edit(L.removePanel(draft, p.id)) }),
        );
      } else if (p.type === "iframe" && p.url) {
        head.append(el("button", { class: "pc-btn-icon pc-refresh", type: "button", title: t("refresh"), text: "↻", onclick: () => { if (iframeEl) iframeEl.src = p.url; } }));
      }
      box.append(head);
    }
    const body = el("div", { class: "pc-panel-body" });
    if (native) {
      if (info) {
        const ph = el("div", { class: "pc-native-ph" });
        body.append(ph);
        if (!p.hidden) slots.set(p.id, { key: p.key, ph, body, hideHeader: p.header === false });
      } else {
        body.append(el("div", { class: "pc-missing", text: t("missingWidget", [p.title || p.key]) }));
      }
    } else if (p.type === "image") {
      if (p.bg) body.style.background = p.bg;
      if (p.src) {
        const img = el("img", { src: p.src, alt: p.title || "", style: { objectFit: p.fit || "cover" } });
        body.append(p.href ? el("a", { class: "pc-image", href: p.href, target: "_blank", rel: "noopener" }, img) : el("div", { class: "pc-image" }, img));
      } else body.append(el("div", { class: "pc-empty", text: t("emptyImage") }));
    } else if (p.type === "links") {
      if (p.items && p.items.length && p.display === "grid") {
        // link banners
        body.append(el("div", { class: "pc-banners" }, p.items.map((i) => el("a", { class: "pc-banner", href: i.url, target: p.newTab === false ? null : "_blank", rel: "noopener", title: i.url },
          i.img ? el("img", { src: i.img, alt: i.title || "" }) : el("span", { class: "pc-banner-text", text: i.title || i.url })))));
      } else if (p.items && p.items.length) {
        body.append(el("ul", { class: "pc-links" }, p.items.map((i) => el("li", {}, el("a", { href: i.url, target: p.newTab === false ? null : "_blank", rel: "noopener", title: i.url, text: i.title || i.url })))));
      } else body.append(el("div", { class: "pc-empty", text: t("emptyLinks") }));
    } else if (p.type === "video") {
      if (p.src) {
        const v = el("video", { class: "pc-video", src: p.src, poster: p.poster || null, playsinline: true, preload: "metadata" });
        v.muted = p.muted !== false; v.loop = p.loop !== false; v.controls = !!p.controls; v.autoplay = p.autoplay !== false && !editing;
        if (p.href && !p.controls) { v.style.cursor = "pointer"; v.addEventListener("click", () => window.open(p.href, "_blank", "noopener")); }
        body.append(v);
      } else body.append(el("div", { class: "pc-empty", text: t("emptyVideo") }));
    } else if (p.type === "html") {
      const box = L.sanitizeHtml(p.html);
      if (box && box.childNodes.length) { box.className = "pc-html"; body.append(box); } else body.append(el("div", { class: "pc-empty", text: t("emptyHtml") }));
    } else if (p.type === "carousel") {
      M.renderCarousel(p, body, { timers, editing });
    } else if (p.type === "feed") {
      M.renderFeed(p, body, { timers, cleanups: ctx.cleanups, editing });
    } else if (p.type === "memo") {
      const ta = el("textarea", { class: "pc-memo", placeholder: t("memoPlaceholder"), spellcheck: "false" });
      ta.value = p.text || "";
      chrome.storage.local.get("memo:" + p.id).then((r) => { if (r["memo:" + p.id] != null) ta.value = r["memo:" + p.id]; }).catch(() => {});
      let timer = 0;
      ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => storageSet({ ["memo:" + p.id]: ta.value }), 500); });
      body.append(ta);
    } else if (p.type === "iframe") {
      if (p.url) {
        iframeEl = el("iframe", { class: "pc-iframe", src: p.url, loading: "lazy", title: p.title || "", scrolling: p.scroll === false ? "no" : null });
        const z = (p.zoom || 100) / 100;
        if (z !== 1) {
          // Scale the page inside the panel (e.g. fit a wide board into a narrow column).
          Object.assign(iframeEl.style, { width: 100 / z + "%", height: 100 / z + "%", transform: `scale(${z})`, transformOrigin: "0 0" });
          body.style.overflow = "hidden";
        }
        body.append(iframeEl);
        if (p.refresh > 0 && !editing) {
          const fr = iframeEl;
          timers.push(setInterval(() => { if (fr.isConnected) fr.src = p.url; }, p.refresh * 60000));
        }
      } else body.append(el("div", { class: "pc-empty", text: t("emptyIframe") }));
    }
    box.append(body);
    if (editing) box.append(el("div", { class: "pc-panel-resize", "data-resize-panel": p.id, title: t("resizePanel") }));
    return box;
  }

  // ---------- positioning the page's widgets ----------
  function resetNode(node) {
    node.classList.remove("pc-proxied", "pc-part");
    for (const e of [node, ...node.querySelectorAll("*")]) {
      if (touched.has(e)) {
        const s = touched.get(e);
        if (s == null) e.removeAttribute("style"); else e.setAttribute("style", s);
        touched.delete(e);
      }
    }
  }
  function restoreEl(e) {
    if (!touched.has(e)) return;
    const s = touched.get(e);
    if (s == null) e.removeAttribute("style"); else e.setAttribute("style", s);
    touched.delete(e);
  }
  // the widget's own title can be hidden (panel option "show title" off)
  function sizeInner(info, hideHeader) {
    const h = info.titleEl;
    if (!h || !info.node.contains(h)) return;
    if (hideHeader) setStyle(h, "display", "none"); else restoreEl(h);
  }
  // Elements between the container and a widget must not become the widget's positioning box.
  function passThrough(node) {
    for (let e = node.parentElement; e && e !== mounted.container; e = e.parentElement) if (!e.hasAttribute("data-pc-pass")) e.setAttribute("data-pc-pass", "");
  }
  function fitBeside() { /* reserved: automatic avoidance of panels floating over the layout */ }

  // ---------- areas the user cannot scroll stay where they are ----------
  // The page's widgets now sit over our slots; when one of them takes focus (a click in a frame, a link, a script)
  // the browser scrolls its ancestors to show it, including boxes with overflow hidden that the user cannot
  // scroll back (the whole page then slides up under the menu). While the layout is shown, those ancestors keep
  // the scroll position they had when it was drawn.
  let locked = [];
  function lockScroll() {
    locked = [];
    if (!mounted) return;
    for (let e = mounted.root.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (/hidden|clip/.test(st.overflowY) || /hidden|clip/.test(st.overflowX)) locked.push({ el: e, top: e.scrollTop, left: e.scrollLeft });
    }
  }
  function keepLocked(only) {
    for (const l of locked) {
      if (only && l.el !== only) continue;
      if (l.el.scrollTop !== l.top) l.el.scrollTop = l.top;
      if (l.el.scrollLeft !== l.left) l.el.scrollLeft = l.left;
    }
  }
  document.addEventListener("scroll", (e) => { if (mounted && locked.length && e.target && e.target.nodeType === 1) keepLocked(e.target); }, true);

  // ---------- columns that scroll on their own ----------
  // Pages built as an app shell (no page scroll, each column scrolls, e.g. overflow:hidden above the widget area)
  // would cut a long layout off. Then each of our columns scrolls by itself, in the height left on screen, and the
  // mouse wheel over a page widget scrolls the column it sits in.
  let clipAnc = null;
  function scrollMode(root) {
    clipAnc = null;
    for (let e = root.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if (oy !== "visible") { clipAnc = e; break; }
    }
    const pageCols = !!(look && look.cols && look.cols.some((c) => c && c.scroll));
    const shell = !!clipAnc && /hidden|clip/.test(getComputedStyle(clipAnc).overflowY);
    return pageCols || shell;
  }
  function fitHeight() {
    if (!mounted || !mounted.scroll) return;
    const r = mounted.root.getBoundingClientRect();
    let bottom = window.innerHeight;
    if (clipAnc && clipAnc.isConnected) bottom = Math.min(bottom, clipAnc.getBoundingClientRect().bottom);
    const h = Math.max(160, Math.floor(bottom - r.top)) + "px";
    if (mounted.root.style.height !== h) mounted.root.style.height = h;
  }
  let sbw = -1;
  function scrollbarWidth() {
    if (sbw >= 0) return sbw;
    const d = el("div", { style: { position: "absolute", top: "-200px", width: "100px", height: "100px", overflow: "scroll", visibility: "hidden" } });
    document.body.append(d);
    sbw = d.offsetWidth - d.clientWidth;
    d.remove();
    return sbw;
  }
  const nodeBody = new WeakMap(); // page widget -> the column body it is shown in
  function wheelOn(e) {
    if (!mounted || !mounted.scroll || S.editMode || e.ctrlKey || !e.deltaY) return;
    const t = e.target;
    let body = null;
    for (const [, s] of slots) {
      const info = catalog.get(s.key);
      if (info && info.node.contains(t)) { body = nodeBody.get(info.node); break; }
    }
    if (!body) return;
    // let a scrollable area inside the widget scroll first
    for (let x = t; x && x !== body; x = x.parentElement) {
      if (x.nodeType !== 1) continue;
      const oy = getComputedStyle(x).overflowY;
      if (/auto|scroll/.test(oy) && x.scrollHeight > x.clientHeight + 1) {
        if ((e.deltaY < 0 && x.scrollTop > 0) || (e.deltaY > 0 && x.scrollTop + x.clientHeight < x.scrollHeight - 1)) return;
      }
      if (x.classList && x.classList.contains("pc-proxied")) break;
    }
    const before = body.scrollTop;
    body.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * body.clientHeight : e.deltaY;
    if (body.scrollTop !== before) e.preventDefault();
  }
  document.addEventListener("wheel", wheelOn, { capture: true, passive: false });
  window.addEventListener("resize", () => fitHeight());
  // frames of the same site inside a widget: forward their wheel too (other sites' frames cannot be reached)
  const hooked = new WeakSet(), framesSeen = new WeakSet();
  function hookFrames(node, body) {
    for (const f of node.tagName === "IFRAME" ? [node] : node.querySelectorAll("iframe")) {
      // a frame gets a new document when it (re)loads
      if (!framesSeen.has(f)) { framesSeen.add(f); f.addEventListener("load", () => hookFrames(f, nodeBody.get(node) || body)); }
      let doc = null;
      try { doc = f.contentDocument; } catch (_e) { doc = null; }
      if (!doc || hooked.has(doc)) continue;
      hooked.add(doc);
      doc.addEventListener("wheel", (e) => {
        if (!mounted || !mounted.scroll || S.editMode || e.ctrlKey || !e.deltaY) return;
        const b = nodeBody.get(node) || body;
        const se = doc.scrollingElement || doc.documentElement;
        const view = doc.defaultView;
        // a frame marked scrolling="no", or whose page hides overflow, does not scroll by itself
        const rootScrolls = (f.getAttribute("scrolling") || "").toLowerCase() !== "no" && ![doc.documentElement, doc.body].some((x) => x && /hidden|clip/.test(view.getComputedStyle(x).overflowY));
        for (let x = e.target; x && x.nodeType === 1; x = x.parentElement) {
          const sc = x === se ? rootScrolls : x !== doc.body && /auto|scroll/.test(view.getComputedStyle(x).overflowY);
          if (sc && x.scrollHeight > x.clientHeight + 1 && ((e.deltaY < 0 && x.scrollTop > 0) || (e.deltaY > 0 && x.scrollTop + x.clientHeight < x.scrollHeight - 1))) return;
        }
        const before = b.scrollTop;
        b.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        if (b.scrollTop !== before) e.preventDefault();
      }, { passive: false });
    }
  }
  function tick() {
    rafId = 0;
    if (!mounted || !contextAlive) return;
    if (!mounted.root.isConnected || !mounted.container.isConnected) { update(); return; }
    fitBeside();
    keepLocked();
    fitHeight();
    const cb = mounted.container.getBoundingClientRect();
    const base = { left: cb.left + mounted.container.clientLeft, top: cb.top + mounted.container.clientTop };
    let stale = false;
    for (const [, s] of slots) {
      const info = catalog.get(s.key);
      if (!info || !info.node.isConnected) { stale = true; continue; }
      const node = info.node;
      const r = s.ph.getBoundingClientRect();
      const col = s.body.closest(".pc-col-body");
      const clipR = col ? col.getBoundingClientRect() : r;
      if (col && mounted.scroll && nodeBody.get(node) !== col) { nodeBody.set(node, col); hookFrames(node, col); }
      const rootR = mounted.root.getBoundingClientRect();
      const top = Math.max(0, Math.max(clipR.top, rootR.top) - r.top);
      const bottom = Math.max(0, r.bottom - Math.min(clipR.bottom, rootR.bottom));
      const left = Math.max(0, rootR.left - r.left);
      const right = Math.max(0, r.right - rootR.right);
      if (!node.classList.contains("pc-proxied")) { node.classList.add("pc-proxied"); passThrough(node); }
      setStyle(node, "left", (r.left - base.left) + "px");
      setStyle(node, "top", (r.top - base.top) + "px");
      setStyle(node, "width", (r.width) + "px");
      setStyle(node, "height", (r.height) + "px");
      setStyle(node, "clip-path", top || bottom || left || right ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : "none");
      sizeInner(info, s.hideHeader);
    }
    placeParts(base);
    if (stale) { update(); return; }
    rafId = requestAnimationFrame(tick);
  }

  // ---------- editing ----------
  function edit(next) { draft = next; render(draft); }

  let drag = null;
  let dropLine = null;
  function clearDrop() { if (dropLine) dropLine.remove(); dropLine = null; }
  function showDrop(rect, vertical) {
    if (!dropLine) { dropLine = el("div", { class: "pc-drop-line" }); document.body.append(dropLine); }
    Object.assign(dropLine.style, vertical
      ? { position: "fixed", left: rect.x - 2 + "px", top: rect.top + "px", width: "4px", height: rect.height + "px" }
      : { position: "fixed", left: rect.left + "px", top: rect.y - 2 + "px", width: rect.width + "px", height: "4px" });
  }
  function panelTarget(e) {
    const cols = [...mounted.root.querySelectorAll(".pc-col")];
    let col = e.target.closest && e.target.closest(".pc-col");
    if (!col) col = cols.reduce((best, c) => { const r = c.getBoundingClientRect(); const d = Math.abs((r.left + r.right) / 2 - e.clientX); return !best || d < best.d ? { c, d } : best; }, null)?.c;
    if (!col) return null;
    const ci = draft.columns.findIndex((c) => c.id === col.dataset.col);
    const body = col.querySelector(".pc-col-body");
    const items = [...body.querySelectorAll(":scope > .pc-panel")];
    let index = draft.columns[ci].panels.length;
    let y = null;
    for (const it of items) {
      const r = it.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        index = draft.columns[ci].panels.findIndex((p) => p.id === it.dataset.panel);
        y = r.top - 12;
        break;
      }
    }
    const br = body.getBoundingClientRect();
    if (y == null) { const last = items[items.length - 1]; y = last ? last.getBoundingClientRect().bottom + 12 : br.top + 4; }
    return { ci, index, rect: { left: br.left, width: br.width, y } };
  }
  function columnTarget(e) {
    const cols = [...mounted.root.querySelectorAll(".pc-col")];
    let index = cols.length;
    let x = null;
    for (let i = 0; i < cols.length; i += 1) {
      const r = cols[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { index = i; x = r.left - 12; break; }
    }
    const rr = mounted.root.getBoundingClientRect();
    if (x == null) x = cols.length ? cols[cols.length - 1].getBoundingClientRect().right + 12 : rr.left;
    return { index, rect: { x, top: rr.top + 8, height: rr.height - 16 } };
  }

  function attachEditHandlers(root) {
    root.addEventListener("dragstart", (e) => {
      if (!S.editMode) return;
      const ph = e.target.closest && e.target.closest("[data-drag-panel]");
      const ch = e.target.closest && e.target.closest("[data-drag-col]");
      if (ph) drag = { kind: "panel", id: ph.dataset.dragPanel, node: ph.closest(".pc-panel") };
      else if (ch) drag = { kind: "col", id: ch.dataset.dragCol, node: ch.closest(".pc-col") };
      else return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", drag.id);
      setTimeout(() => drag && drag.node && drag.node.classList.add("pc-dragging"), 0);
    });
    root.addEventListener("dragover", (e) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (drag.kind === "panel") { const tgt = panelTarget(e); if (tgt) showDrop(tgt.rect, false); }
      else showDrop(columnTarget(e).rect, true);
    });
    root.addEventListener("drop", (e) => {
      if (!drag) return;
      e.preventDefault();
      if (drag.kind === "panel") { const tgt = panelTarget(e); if (tgt) draft = L.movePanel(draft, drag.id, tgt.ci, tgt.index); }
      else draft = L.moveColumn(draft, drag.id, columnTarget(e).index);
      drag = null;
      clearDrop();
      render(draft);
    });
    root.addEventListener("dragend", () => { if (drag && drag.node) drag.node.classList.remove("pc-dragging"); drag = null; clearDrop(); });

    root.addEventListener("pointerdown", (e) => {
      const rc = e.target.closest && e.target.closest("[data-resize-col]");
      const rp = e.target.closest && e.target.closest("[data-resize-panel]");
      if (!rc && !rp) return;
      e.preventDefault();
      const target = rc ? rc.closest(".pc-col") : rp.closest(".pc-panel");
      const start = rc ? e.clientX : e.clientY;
      const startSize = rc ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;
      const label = rc ? target.querySelector(".pc-col-head .pc-grow") : null;
      if (rc) target.classList.remove("pc-flex"); else target.classList.remove("pc-fill");
      let size = startSize;
      const move = (ev) => {
        size = Math.max(rc ? 120 : 40, Math.round(startSize + (rc ? ev.clientX : ev.clientY) - start));
        if (rc) { target.style.width = size + "px"; if (label) label.textContent = size + "px"; } else target.style.height = size + "px";
      };
      const upHandler = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", upHandler);
        if (rc) draft = L.setColumn(draft, rc.dataset.resizeCol, { width: size });
        else draft = L.updatePanel(draft, rp.dataset.resizePanel, { height: size });
        render(draft);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", upHandler);
    });
    root.addEventListener("dblclick", (e) => {
      const rp = e.target.closest && e.target.closest("[data-resize-panel]");
      if (rp) edit(L.updatePanel(draft, rp.dataset.resizePanel, { height: null }));
    });
  }

  // ---------- toolbar ----------
  let toolbar = null;
  function removeToolbar() { if (toolbar) toolbar.remove(); toolbar = null; closeMenu(); }
  function showToolbar() {
    if (toolbar && toolbar.isConnected) { refreshToolbar(); return; }
    toolbar = el("div", { id: "pc-toolbar" }, [
      el("b", { text: t("editingTitle") }),
      el("button", { text: "+ " + t("addPanel"), onclick: (e) => openAddMenu(e.currentTarget) }),
      el("button", { text: "+ " + t("addColumn"), onclick: () => edit(L.addColumn(draft, 320)) }),
      el("button", { text: "↕ " + t("gapButton"), onclick: openGapSettings }),
      el("button", { id: "pc-unit-btn", text: "▣ " + t("widgetUnit"), onclick: () => openPicker() }),
      el("span", { class: "pc-sep" }),
      el("button", { text: t("export"), onclick: exportLayout }),
      el("button", { text: t("import"), onclick: importLayout }),
      el("button", { "data-org": "1", text: t("useOrgDefault"), onclick: (e) => loadOrgDefault(e.currentTarget) }),
      el("button", { text: t("useOriginal"), onclick: () => { if (confirm(t("confirmOriginal"))) edit(L.fromCatalog(lastStructure || [])); } }),
      el("span", { class: "pc-sep" }),
      el("button", { text: t("cancel"), onclick: cancelEdit }),
      el("button", { class: "pc-primary", text: t("save"), onclick: saveEdit }),
    ]);
    document.body.append(toolbar);
    refreshToolbar();
  }
  function refreshToolbar() {
    const b = toolbar && toolbar.querySelector("[data-org]");
    if (b) b.hidden = !(S.orgConfig && (S.orgConfig.layout || S.orgConfig.url));
  }
  // Same as the popup's "Load": fetch the organization default again (it may have changed on the server
  // since the last hourly check), then put it into the editor.
  async function loadOrgDefault(btn) {
    btn.disabled = true;
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: "fetchOrg" }); } catch (_e) { contextAlive = false; }
    let org = S.orgConfig;
    try { org = (await chrome.storage.local.get("orgConfig")).orgConfig || org; } catch (_e) { /* extension reloaded */ }
    btn.disabled = false;
    if (org) S.orgConfig = org;
    if (r && r.ok === false) toast(t("orgError", [r.error]));
    if (!org || !org.layout) return;
    if (!S.editMode || !draft) return;
    edit(L.clone(org.layout));
    toast(t("orgLoadedToEditor", [org.name || org.version || ""]));
  }
  let menu = null;
  function closeMenu() { if (menu) menu.remove(); menu = null; }
  function openAddMenu(anchor) {
    if (menu) { closeMenu(); return; }
    const r = anchor.getBoundingClientRect();
    const used = L.usedNativeKeys(draft);
    const add = (panel) => { closeMenu(); draft = L.addPanel(draft, 0, panel); render(draft); if (panel.type !== "native") openSettings(panel.id); };
    menu = el("div", { class: "pc-menu", style: { left: r.left + "px", top: r.bottom + 6 + "px" } }, [
      el("div", { class: "pc-menu-label", text: t("customPanels") }),
      ...["feed", "carousel", "image", "video", "html", "links", "memo", "iframe"].map((type) => el("button", { text: t("type_" + type), onclick: () => add(L.newPanel(type, type === "image" ? "" : t("type_" + type))) })),
      el("div", { class: "pc-menu-label", text: t("originalWidgets") }),
      ...[...catalog.values()].map((info) => el("button", {
        text: info.title + (used.has(info.key) ? " ✓" : ""), disabled: used.has(info.key),
        onclick: () => add({ id: L.uid("p"), type: "native", key: info.key, title: info.title, height: info.height }),
      })),
    ]);
    document.body.append(menu);
    setTimeout(() => document.addEventListener("pointerdown", function off(ev) { if (menu && !menu.contains(ev.target)) { closeMenu(); document.removeEventListener("pointerdown", off, true); } }, true), 0);
  }

  async function saveEdit() {
    const layout = L.validate(draft).layout;
    const rule = siteRule();
    if (rule && rule.container) layout.site = { container: rule.container, level: rule.level }; else delete layout.site;
    draft = null;
    const sites = Object.assign({}, S.sites);
    sites[SITE] = Object.assign({}, site(), { on: true, userLayout: layout, customized: true, baseOrgVersion: (S.orgConfig && S.orgConfig.version) || "" });
    await storageSet({ sites, editMode: false });
    toast(t("saved"));
  }
  async function cancelEdit() {
    draft = null;
    await storageSet({ editMode: false });
  }
  function download(name, text) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportLayout() {
    const layout = L.validate(draft).layout;
    const d = new Date();
    layout.version = d.toISOString().slice(0, 19).replace(/[-:T]/g, "");
    download("portal-customizer.json", JSON.stringify(layout, null, 2));
  }
  function importLayout() {
    const input = el("input", { type: "file", accept: "application/json,.json" });
    input.addEventListener("change", async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const r = L.validate(JSON.parse(await f.text()));
        if (!r.ok) throw new Error(r.error);
        edit(r.layout);
        toast(t("imported"));
      } catch (err) { alert(t("importFailed", [String(err.message || err)])); }
    });
    input.click();
  }

  // ---------- panel settings ----------
  function openSettings(id) {
    const f = L.findPanel(draft, id);
    if (!f) return;
    const p = f.panel;
    const fields = [];
    const input = (name, label, value, type, extra) => {
      const i = el(type === "textarea" ? "textarea" : "input", Object.assign({ name, type: type === "textarea" ? null : (type || "text") }, extra || {}));
      i.value = value == null ? "" : value;
      fields.push(el("label", { text: label }), i);
      return i;
    };
    const titleInput = input("title", p.type === "native" ? t("fieldTitleNative") : t("fieldTitle"), p.title);
    const showCb = el("input", { type: "checkbox", name: "header" });
    showCb.checked = p.header !== false;
    let showTouched = false;
    showCb.addEventListener("change", () => { showTouched = true; });
    // Typing a title into a panel whose title bar is off turns it on, unless the box was changed by hand.
    const hadTitle = !!p.title;
    titleInput.addEventListener("input", () => { if (!showTouched && !hadTitle && titleInput.value.trim()) showCb.checked = true; });
    fields.push(el("label", { class: "pc-row" }, [showCb, document.createTextNode(" " + (p.type === "native" ? t("fieldShowHeaderNative") : t("fieldShowHeader")))]));
    input("height", t("fieldHeight"), p.height || "", "number", { min: 40, placeholder: t("auto") });
    let preview = null;
    let dataSrc = null;
    let rows = null;
    if (p.type === "image") {
      const src = input("src", t("fieldImageUrl"), p.src && !p.src.startsWith("data:") ? p.src : "", "url", { placeholder: "https://" });
      const file = el("input", { type: "file", accept: "image/*" });
      fields.push(el("label", { text: t("fieldImageFile") }), file, el("div", { class: "pc-hint", text: t("imageFileHint") }));
      preview = el("img", { class: "pc-preview", src: p.src || null, hidden: !p.src });
      fields.push(preview);
      file.addEventListener("change", async () => {
        if (!file.files[0]) return;
        dataSrc = await readImage(file.files[0]);
        src.value = "";
        preview.src = dataSrc; preview.hidden = false;
      });
      src.addEventListener("input", () => { dataSrc = null; preview.src = src.value; preview.hidden = !src.value; });
      input("href", t("fieldLink"), p.href, "url", { placeholder: "https://" });
      const sel = el("select", { name: "fit" }, [el("option", { value: "cover", text: t("fitCover") }), el("option", { value: "contain", text: t("fitContain") })]);
      sel.value = p.fit || "cover";
      fields.push(el("label", { text: t("fieldFit") }), sel);
      input("bg", t("fieldBackground"), p.bg, "text", { placeholder: "#ffffff" });
    } else if (p.type === "links") {
      input("items", t("fieldLinks"), L.formatLinks(p.items), "textarea", { placeholder: "Example | https://example.com" });
      fields.push(el("div", { class: "pc-hint", text: t("linksHint") }));
      const cb = el("input", { type: "checkbox", name: "newTab" });
      cb.checked = p.newTab !== false;
      fields.push(el("label", { class: "pc-row" }, [cb, document.createTextNode(" " + t("fieldNewTab"))]));
      const disp = el("select", { name: "display" }, [el("option", { value: "list", text: t("displayList") }), el("option", { value: "grid", text: t("displayBanners") })]);
      disp.value = p.display || "list";
      fields.push(el("label", { text: t("fieldDisplay") }), disp);
    } else if (p.type === "video") {
      input("src", t("fieldVideoUrl"), p.src && !p.src.startsWith("data:") ? p.src : "", "url", { placeholder: "https://" });
      input("poster", t("fieldPoster"), p.poster && !p.poster.startsWith("data:") ? p.poster : "", "url", { placeholder: "https://" });
      input("href", t("fieldLink"), p.href, "url", { placeholder: "https://" });
      for (const [name, label, val] of [["autoplay", t("fieldAutoplay"), p.autoplay !== false], ["muted", t("fieldMuted"), p.muted !== false], ["loop", t("fieldLoop"), p.loop !== false], ["controls", t("fieldControls"), !!p.controls]]) {
        const c = el("input", { type: "checkbox", name }); c.checked = val;
        fields.push(el("label", { class: "pc-row" }, [c, document.createTextNode(" " + label)]));
      }
    } else if (p.type === "html") {
      input("html", t("fieldHtml"), p.html, "textarea");
      fields.push(el("div", { class: "pc-hint", text: t("htmlHint") }));
    } else if (p.type === "carousel") {
      rows = M.rowsEditor(p.slides || [], [{ key: "title", label: t("fieldTitle") }, { key: "href", label: t("fieldLinkShort") }, { key: "src", label: t("fieldImageUrl") }],
        { image: true, readImage, blank: () => ({ title: "", href: "", src: "" }) });
      fields.push(el("label", { text: t("fieldSlides") }), rows.node);
      input("interval", t("fieldInterval"), p.interval || 0, "number", { min: 0, max: 600 });
      const sel = el("select", { name: "fit" }, [el("option", { value: "cover", text: t("fitCover") }), el("option", { value: "contain", text: t("fitContain") })]);
      sel.value = p.fit || "cover";
      fields.push(el("label", { text: t("fieldFit") }), sel);
      for (const [name, label, val] of [["captions", t("fieldCaptions"), p.captions !== false], ["layer", t("fieldLayer"), !!p.layer]]) {
        const c = el("input", { type: "checkbox", name }); c.checked = val;
        fields.push(el("label", { class: "pc-row" }, [c, document.createTextNode(" " + label)]));
      }
    } else if (p.type === "feed") {
      rows = M.rowsEditor(p.tabs || [], [{ key: "title", label: t("fieldTabName") }, { key: "src", label: t("fieldTabSource") }, { key: "site", label: t("fieldTabSite") }, { key: "write", label: t("fieldTabWrite") }],
        { blank: () => ({ id: L.uid("t"), title: "", src: "", site: "", write: "" }) });
      fields.push(el("label", { text: t("fieldTabs") }), rows.node, el("div", { class: "pc-hint", text: t("feedHint") }));
      const boards = [...catalog.values()].filter((i) => i.src);
      if (boards.length) {
        const pick = el("select", {}, [el("option", { value: "", text: t("pickWidgetPlaceholder") }), ...boards.map((i) => el("option", { value: i.src, text: i.title }))]);
        pick.addEventListener("change", () => { if (pick.value) { rows.add({ id: L.uid("t"), title: pick.selectedOptions[0].textContent, src: pick.value, site: "", write: "" }); pick.value = ""; } });
        fields.push(el("label", { text: t("fieldAddFromWidget") }), pick);
      }
      const view = el("select", { name: "view" }, [el("option", { value: "card", text: t("viewCard") }), el("option", { value: "list", text: t("viewList") })]);
      view.value = p.view || "card";
      fields.push(el("label", { text: t("fieldView") }), view);
      const first = el("select", { name: "first" }, [el("option", { value: "", text: t("firstTabAuto") }), el("option", { value: "__all", text: t("feedAll") }),
        ...(p.tabs || []).map((x) => el("option", { value: x.id, text: x.title || x.src }))]);
      first.value = p.first || "";
      fields.push(el("label", { text: t("fieldFirstTab") }), first);
      input("limit", t("fieldLimit"), p.limit || 30, "number", { min: 1, max: 200 });
      input("refresh", t("fieldRefresh"), p.refresh || 0, "number", { min: 0, max: 1440 });
      for (const [name, label, val] of [["all", t("fieldAllTab"), p.all !== false], ["layer", t("fieldLayer"), p.layer !== false]]) {
        const c = el("input", { type: "checkbox", name }); c.checked = val;
        fields.push(el("label", { class: "pc-row" }, [c, document.createTextNode(" " + label)]));
      }
    } else if (p.type === "memo") {
      input("text", t("fieldMemoDefault"), p.text, "textarea");
      fields.push(el("div", { class: "pc-hint", text: t("memoHint") }));
    } else if (p.type === "iframe") {
      const urlInput = input("url", t("fieldPageUrl"), p.url, "url", { placeholder: "https://" });
      const sources = [...catalog.values()].filter((i) => i.src);
      if (sources.length) {
        const pick = el("select", { name: "pick" }, [el("option", { value: "", text: t("pickWidgetPlaceholder") }),
          ...sources.map((i) => el("option", { value: i.src, text: i.title }))]);
        pick.addEventListener("change", () => {
          if (!pick.value) return;
          urlInput.value = pick.value;
          if (!titleInput.value.trim() || titleInput.value === t("type_iframe")) titleInput.value = pick.selectedOptions[0].textContent;
          titleInput.dispatchEvent(new Event("input"));
        });
        fields.push(el("label", { text: t("fieldPickWidget") }), pick);
      }
      fields.push(el("div", { class: "pc-hint", text: t("iframeHint") }));
      input("refresh", t("fieldRefresh"), p.refresh || "", "number", { min: 0, max: 1440, placeholder: "0" });
      input("zoom", t("fieldZoom"), p.zoom || 100, "number", { min: 25, max: 300, step: 5 });
      const sc = el("input", { type: "checkbox", name: "scroll" });
      sc.checked = p.scroll !== false;
      fields.push(el("label", { class: "pc-row" }, [sc, document.createTextNode(" " + t("fieldScroll"))]));
    } else if (p.type === "native") {
      fields.push(el("div", { class: "pc-hint", text: t("nativeHint") }));
    }
    const form = el("form", { class: "pc-modal" }, [el("h3", { text: t("panelSettings") + " · " + t("type_" + p.type) }), ...fields,
      el("div", { class: "pc-actions" }, [el("button", { type: "button", text: t("cancel"), onclick: () => back.remove() }), el("button", { type: "submit", class: "pc-primary", text: t("apply") })])]);
    const back = el("div", { class: "pc-modal-back" }, form);
    back.addEventListener("pointerdown", (e) => { if (e.target === back) back.remove(); });
    form.addEventListener("keydown", (e) => { if (e.key === "Escape") back.remove(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = (n) => form.elements[n] && form.elements[n].value;
      const patch = { title: v("title"), height: v("height") ? Number(v("height")) : null };
      if (form.elements.header) patch.header = form.elements.header.checked;
      if (p.type === "image") Object.assign(patch, { src: dataSrc || v("src") || (p.src && p.src.startsWith("data:") && !v("src") ? p.src : ""), href: v("href"), fit: v("fit"), bg: v("bg") });
      if (p.type === "links") {
        // keep uploaded pictures of existing items (not shown in the text box)
        const items = L.parseLinks(v("items")).map((i) => { const old = (p.items || []).find((o) => o.url === i.url && o.img && o.img.startsWith("data:")); return old && !i.img ? Object.assign(i, { img: old.img }) : i; });
        Object.assign(patch, { items, newTab: form.elements.newTab.checked, display: v("display") });
      }
      if (p.type === "video") Object.assign(patch, { src: v("src") || (p.src && p.src.startsWith("data:") ? p.src : ""), poster: v("poster"), href: v("href"),
        autoplay: form.elements.autoplay.checked, muted: form.elements.muted.checked, loop: form.elements.loop.checked, controls: form.elements.controls.checked });
      if (p.type === "html") patch.html = v("html");
      if (p.type === "carousel") Object.assign(patch, { slides: rows.get(), interval: Number(v("interval")) || 0, fit: v("fit"), captions: form.elements.captions.checked, layer: form.elements.layer.checked });
      if (p.type === "feed") Object.assign(patch, { tabs: rows.get(), view: v("view"), first: v("first"), limit: Number(v("limit")) || 30, refresh: Number(v("refresh")) || 0, all: form.elements.all.checked, layer: form.elements.layer.checked });
      if (p.type === "memo") patch.text = v("text");
      if (p.type === "iframe") Object.assign(patch, { url: v("url"), refresh: Number(v("refresh")) || 0, zoom: Number(v("zoom")) || 100, scroll: form.elements.scroll.checked });
      back.remove();
      edit(L.updatePanel(draft, id, patch));
    });
    document.body.append(back);
    form.querySelector("input,textarea").focus();
  }

  // Downscale big pictures so the layout stays small enough to export and share.
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => {
        if (file.size < 600 * 1024 || /svg|gif/.test(file.type)) { resolve(fr.result); return; }
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 1600 / img.width);
          const c = document.createElement("canvas");
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/webp", 0.85));
        };
        img.onerror = () => resolve(fr.result);
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  // ---------- widget level picker ----------
  // Shows the widgets found on the page (outlines over the original page) and lets the user make them bigger
  // (one level up in the page tree), smaller (one level down) or click one widget as a sample. The choice is
  // kept as { container: generated selector, level } for this page and saved with the layout.
  let picker = null, pickerShown = false, freshDraft = false;
  function pickWidgets() { return picker.container && picker.container.isConnected ? D.atLevel(picker.container, picker.level) : []; }
  function openPicker() {
    uncloak(); // the picker looks at the page as it is
    say("widget unit picker opened");
    if (picker) return;
    unmount(); removeToolbar(); probe();
    const r = D.detect(document, siteRule());
    picker = { container: r ? r.container : null, level: r ? r.level : 1, framework: r ? r.framework : "", sampling: !r, // nothing found: start by choosing a sample widget
 hover: null, raf: 0 };
    const layer = el("div", { id: "pc-pick" });
    const info = el("span", { class: "pc-pick-info" });
    const bar = el("div", { id: "pc-pickbar" }, [
      el("b", { text: t("pickTitle") }), info,
      el("button", { id: "pc-pick-bigger", text: "◀ " + t("pickBigger"), onclick: () => { picker.level = Math.max(1, picker.level - 1); drawPicker(); } }),
      el("button", { id: "pc-pick-smaller", text: t("pickSmaller") + " ▶", onclick: () => { picker.level += 1; drawPicker(); } }),
      el("button", { id: "pc-pick-sample", text: t("pickSample"), onclick: () => { picker.sampling = !picker.sampling; drawPicker(); } }),
      el("button", { id: "pc-pick-auto", text: t("pickAuto"), onclick: () => {
        const a = D.detect(document, null);
        if (a) { picker.container = a.container; picker.level = a.level; picker.auto = true; } drawPicker(); } }),
      el("span", { class: "pc-sep" }),
      el("button", { id: "pc-pick-cancel", text: t("cancel"), onclick: () => closePicker(false) }),
      el("button", { id: "pc-pick-apply", class: "pc-primary", text: t("pickApply"), onclick: () => closePicker(true) }),
    ]);
    picker.layer = layer; picker.bar = bar; picker.info = info;
    document.body.append(layer, bar);
    document.addEventListener("mousemove", pickMove, true);
    document.addEventListener("click", pickClick, true);
    const loop = () => { if (!picker) return; drawPicker(); picker.raf = requestAnimationFrame(loop); };
    picker.raf = requestAnimationFrame(loop);
  }
  function drawPicker() {
    if (!picker) return;
    const ws = pickWidgets();
    const box = (r, cls, label) => {
      const b = el("div", { class: cls, style: { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" } });
      if (label) b.append(el("span", { text: label }));
      return b;
    };
    const kids = [];
    if (picker.container) kids.push(box(picker.container.getBoundingClientRect(), "pc-pick-area"));
    ws.forEach((w, i) => {
      const tt = D.titleOf(w);
      kids.push(box(w.getBoundingClientRect(), "pc-pick-w", (i + 1) + ". " + (tt.text || w.getAttribute("data-pc-c") || t("widget"))));
    });
    if (picker.sampling && picker.hover) kids.push(box(picker.hover.getBoundingClientRect(), "pc-pick-hover"));
    picker.layer.replaceChildren(...kids);
    picker.info.textContent = picker.sampling ? t("pickSampleHint") : t("pickInfo", [String(ws.length), picker.framework || t("noFramework")]);
    picker.bar.querySelector("#pc-pick-bigger").disabled = picker.level <= 1;
    picker.bar.querySelector("#pc-pick-smaller").disabled = !picker.container || D.atLevel(picker.container, picker.level + 1).length === 0;
    picker.bar.querySelector("#pc-pick-sample").classList.toggle("pc-on", picker.sampling);
    picker.bar.querySelector("#pc-pick-apply").disabled = ws.length === 0;
    try { document.documentElement.setAttribute("data-pc-pick", picker.level + ":" + ws.length); } catch (_e) { /* ignore */ }
  }
  function pickTarget(e) {
    let n = e.target;
    if (!n || n.closest("#pc-pickbar")) return null;
    // snap to the nearest framework component root or box
    for (let x = n, i = 0; x && x !== document.body && i < 4; x = x.parentElement, i++) if (x.hasAttribute && x.hasAttribute("data-pc-c") && D.isBox(x)) return x;
    for (let x = n; x && x !== document.body; x = x.parentElement) if (D.isBox(x)) return x;
    return null;
  }
  function pickMove(e) { if (picker && picker.sampling) picker.hover = pickTarget(e); }
  function pickClick(e) {
    if (!picker || e.target.closest("#pc-pickbar")) return;
    e.preventDefault(); e.stopPropagation();
    if (!picker.sampling) return;
    const target = pickTarget(e);
    const r = target && D.ruleFromSample(target);
    if (!r) { toast(t("pickNone")); return; }
    picker.container = r.container; picker.level = r.level; picker.sampling = false; picker.hover = null; picker.auto = false;
    drawPicker();
  }
  async function closePicker(apply) {
    if (!picker) return;
    const p = picker;
    cancelAnimationFrame(p.raf);
    document.removeEventListener("mousemove", pickMove, true);
    document.removeEventListener("click", pickClick, true);
    p.layer.remove(); p.bar.remove();
    document.documentElement.removeAttribute("data-pc-pick");
    if (apply && p.container) {
      const container = p.container;
      const sel = D.cssPath(container);
      let ok = false; try { ok = document.querySelector(sel) === container; } catch (_e) { ok = false; }
      const rule = ok ? { container: sel, level: p.level } : null;
      if (!ok) toast(t("pickNoSelector"));
      const before = JSON.stringify(siteRule());
      const sites = Object.assign({}, S.sites);
      const cur = Object.assign({}, site(), { on: true });
      if (rule) cur.rule = rule; else delete cur.rule;
      sites[SITE] = cur;
      S.sites = sites;
      if (JSON.stringify(siteRule()) !== before || !draft) { draft = null; freshDraft = true; } // widgets changed: the editor starts again from the page
      picker = null;
      await storageSet({ sites });
    } else {
      picker = null;
    }
    update();
  }

  // ---------- wiring ----------
  document.addEventListener("keydown", (e) => {
    if (!S.editMode || !mounted) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveEdit(); }
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let relevant = false;
    for (const k of KEYS) if (k in changes) { S[k] = changes[k].newValue; relevant = true; }
    if (!relevant) return;
    gateEdit();
    if ("editMode" in changes && !S.editMode) { draft = null; pickerShown = false; update.told = false; if (picker) { closePicker(false); return; } }
    if ("enabled" in changes && S.enabled === undefined) S.enabled = true;
    if (!S.sites) S.sites = {};
    waitStart = 0;
    // leaving edit mode or a new layout in view mode: look at the page again (the layout may now match it)
    if (("editMode" in changes && !S.editMode) || (!S.editMode && ("sites" in changes || "orgConfig" in changes))) { forceFresh = true; asIs = ""; }
    update();
  });

  // The page changes all the time. While mounted, only lost widgets (re-created by the framework) need a new
  // detection; while not mounted, look again at most once a second (the page may still be building itself).
  let pending = false, lastLook = 0, sawAdded = false, lateTimer = 0;
  // a remount (synchronous, so invisible) only when the number of boxes at the widget level changed
  function lateCheck() {
    if (lateTimer) return;
    lateTimer = setTimeout(() => {
      lateTimer = 0;
      if (!mounted || !detected || !detected.level || !mounted.container.isConnected) return;
      if (levelCount(mounted.container, detected.level) === detected.count) return;
      forceFresh = true;
      update();
    }, 150);
  }
  const ours = (m) => m.target.closest && m.target.closest("#pc-root, #pc-toolbar, .pc-menu, #pc-pick, #pc-pickbar");
  const observer = new MutationObserver((list) => {
    if (!active()) return;
    if (list.every(ours)) return;
    if (!sawAdded) sawAdded = list.some((m) => !ours(m) && [...m.addedNodes].some((n) => n.nodeType === 1 && !(n.id || "").startsWith("pc-")));
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const added = sawAdded; sawAdded = false;
      if (mounted) {
        if (!mounted.container.isConnected || [...catalog.values()].some((i) => !i.node.isConnected)) { update(); return; }
        // saved widgets that were not there at mount time: look again when the page adds a widget
        if (missingKeys.length && added && Date.now() - loadedAt < LATE_MS) lateCheck();
        return;
      }
      // a saved layout is waiting to be drawn: look often; otherwise at most once a second
      if (Date.now() - lastLook < (effectiveLayout() || S.editMode ? 100 : 1000)) return;
      lastLook = Date.now();
      update();
    });
  });

  say("running on " + SITE);
  chrome.storage.local.get(KEYS).then((r) => {
    Object.assign(S, r);
    if (S.enabled === undefined) S.enabled = true;
    if (!S.sites) S.sites = {};
    gateEdit();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    update();
  });
  window.__portalCustomizer = { update, get state() { return { S, draft, catalog: [...catalog.keys()], mounted: !!mounted, framework: detected && detected.framework, mode: detected && detected.mode }; } };
})();
