// Portal Customizer "Media" style panels: carousel (featured contents), feed with tabs (collects posts from boards),
// layer view, bookmarks. Used by content.js through globalThis.PCMedia.
(() => {
  "use strict";
  const L = globalThis.PCLayout;
  const t = (k, s) => { try { return chrome.i18n.getMessage(k, s) || k; } catch (_e) { return k; } };
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

  // ---------- layer view (detail popup inside the page) ----------
  function openLayer(url, title) {
    document.querySelectorAll(".pc-layer-back").forEach((n) => n.remove());
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const back = el("div", { class: "pc-layer-back" }, el("div", { class: "pc-layer" }, [
      el("div", { class: "pc-layer-head" }, [
        el("span", { class: "pc-layer-title", text: title || url }),
        el("a", { class: "pc-btn-icon", href: url, target: "_blank", rel: "noopener", title: t("openNewTab"), text: "↗" }),
        el("button", { class: "pc-btn-icon pc-layer-close", type: "button", title: t("close"), text: "✕", onclick: close }),
      ]),
      el("iframe", { class: "pc-layer-frame", src: url, title: title || "" }),
    ]));
    back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(back);
    return back;
  }
  function openUrl(url, title, layer) { if (layer) openLayer(url, title); else window.open(url, "_blank", "noopener"); }

  // ---------- carousel ----------
  function renderCarousel(p, body, ctx) {
    const slides = p.slides || [];
    if (!slides.length) { body.append(el("div", { class: "pc-empty", text: t("emptyCarousel") })); return; }
    let i = 0;
    const track = el("div", { class: "pc-car-track" }, slides.map((s) => {
      const img = s.src ? el("img", { src: s.src, alt: s.title || "", style: { objectFit: p.fit || "cover" } }) : null;
      const cap = p.captions !== false && s.title ? el("div", { class: "pc-car-cap", text: s.title }) : null;
      const slide = el("div", { class: "pc-car-slide" + (s.href ? " pc-link" : "") }, [img, cap]);
      if (s.href) slide.addEventListener("click", () => openUrl(s.href, s.title, p.layer));
      return slide;
    }));
    const dots = el("div", { class: "pc-car-dots" }, slides.map((_s, n) => el("button", { type: "button", class: "pc-car-dot", "aria-label": String(n + 1), onclick: () => go(n) })));
    const go = (n) => {
      i = (n + slides.length) % slides.length;
      track.style.transform = `translateX(${-100 * i}%)`;
      [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
      box.dataset.index = String(i);
    };
    const box = el("div", { class: "pc-car" }, [track,
      slides.length > 1 ? el("button", { type: "button", class: "pc-car-nav prev", "aria-label": "<", text: "‹", onclick: () => go(i - 1) }) : null,
      slides.length > 1 ? el("button", { type: "button", class: "pc-car-nav next", "aria-label": ">", text: "›", onclick: () => go(i + 1) }) : null,
      slides.length > 1 ? dots : null]);
    body.append(box);
    go(0);
    if (p.interval > 0 && slides.length > 1 && !ctx.editing) {
      let paused = false;
      box.addEventListener("mouseenter", () => { paused = true; });
      box.addEventListener("mouseleave", () => { paused = false; });
      ctx.timers.push(setInterval(() => { if (!paused && box.isConnected) go(i + 1); }, p.interval * 1000));
    }
  }

  // ---------- feed sources: read posts from board pages of the same site ----------
  const sources = new Map(); // src -> { frame, items, listeners:Set, error }
  let pool = null;
  function framePool() {
    if (pool && pool.isConnected) return pool;
    pool = el("div", { id: "pc-feed-pool", "aria-hidden": "true" });
    document.body.append(pool);
    return pool;
  }
  function sameOrigin(url) { try { return new URL(url, location.href).origin === location.origin; } catch (_e) { return false; } }
  function extract(doc, limit) {
    const raw = [];
    doc.querySelectorAll("a").forEach((a) => {
      const row = a.closest("li, tr, dd, .list-item, .item") || a.parentElement;
      raw.push({ text: a.textContent, href: a.getAttribute("href") && !/^(#|javascript:)/i.test(a.getAttribute("href")) ? a.href : "", row: row ? row.textContent : "", a });
    });
    const items = L.cleanItems(raw, limit);
    // keep a handle on the element so a click can run the board's own handler
    const byText = new Map(raw.map((r) => [String(r.text || "").replace(/\s+/g, " ").trim(), r.a]));
    items.forEach((it) => { it.a = byText.get(it.text); });
    return items;
  }
  function source(src, limit) {
    let s = sources.get(src);
    if (s && s.frame.isConnected) return s;
    s = { src, items: [], listeners: new Set(), error: "", frame: null, obs: null };
    sources.set(src, s);
    if (!sameOrigin(src)) { s.error = "cross-origin"; return s; }
    // Reuse a widget frame already showing this page, otherwise load it out of sight.
    let frame = [...document.querySelectorAll("iframe")].find((f) => f.src === src && !f.closest("#pc-root"));
    if (!frame) {
      frame = el("iframe", { src, title: "", tabindex: "-1" });
      framePool().append(frame);
    }
    s.frame = frame;
    const read = () => {
      let doc;
      try { doc = frame.contentDocument; } catch (_e) { doc = null; }
      if (!doc || !doc.body) return;
      const items = extract(doc, Math.max(limit, 60));
      const sig = items.map((x) => x.text).join("\n");
      if (sig !== s.sig) { s.sig = sig; s.items = items; s.listeners.forEach((f) => f()); }
      if (!s.obs) {
        let timer = 0;
        s.obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(read, 150); });
        s.obs.observe(doc.body, { childList: true, subtree: true, characterData: true });
      }
    };
    s.read = read;
    frame.addEventListener("load", () => { s.obs = null; read(); });
    read();
    return s;
  }
  function reloadSource(src) {
    const s = sources.get(src);
    if (s && s.frame && s.frame.closest("#pc-feed-pool")) s.frame.src = src;
    else if (s && s.read) s.read();
  }

  // ---------- bookmarks ----------
  let bookmarks = [];
  const bmListeners = new Set();
  chrome.storage.local.get("bookmarks").then((r) => { bookmarks = r.bookmarks || []; bmListeners.forEach((f) => f()); }).catch(() => {});
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.bookmarks) { bookmarks = c.bookmarks.newValue || []; bmListeners.forEach((f) => f()); } });
  const bmKey = (it) => (it.tabSrc || "") + "\n" + it.text;
  function isBookmarked(it) { return bookmarks.some((b) => b.key === bmKey(it)); }
  function toggleBookmark(it) {
    const key = bmKey(it);
    const next = isBookmarked(it) ? bookmarks.filter((b) => b.key !== key)
      : [{ key, text: it.text, href: it.href || "", tabSrc: it.tabSrc || "", tab: it.tab || "", at: Date.now() }, ...bookmarks].slice(0, 300);
    bookmarks = next;
    chrome.storage.local.set({ bookmarks: next }).catch(() => {});
  }

  // ---------- feed panel ----------
  function highlight(text, q) {
    if (!q) return [document.createTextNode(text)];
    const out = [];
    const low = text.toLowerCase(), ql = q.toLowerCase();
    let i = 0;
    for (;;) {
      const j = low.indexOf(ql, i);
      if (j < 0) break;
      if (j > i) out.push(document.createTextNode(text.slice(i, j)));
      out.push(el("mark", { text: text.slice(j, j + q.length) }));
      i = j + q.length;
    }
    out.push(document.createTextNode(text.slice(i)));
    return out;
  }
  function fmtDate(ms) {
    if (!ms) return "";
    const d = new Date(ms), n = new Date();
    if (d.toDateString() === n.toDateString() && (d.getHours() || d.getMinutes())) return d.toTimeString().slice(0, 5);
    return `${d.getFullYear() % 100}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  }

  function renderFeed(p, body, ctx) {
    const tabs = p.tabs || [];
    const box = el("div", { class: "pc-feed pc-feed-" + (p.view || "card") });
    body.append(box);
    body.style.overflow = "hidden";
    if (!tabs.length) { box.append(el("div", { class: "pc-empty", text: t("emptyFeed") })); return; }
    const allTab = p.all !== false && tabs.length > 1 ? [{ id: "__all", title: t("feedAll") }] : [];
    const myTab = [{ id: "__my", title: t("feedMy") }];
    const tabList = [...allTab, ...tabs, ...myTab];
    const stateKey = "feedTab:" + p.id;
    let current = (tabList.find((x) => x.id === p.first) || tabList[0]).id;
    let sort = "default";
    let query = "";
    try { const v = sessionStorage.getItem(stateKey); if (v && tabList.some((x) => x.id === v)) current = v; } catch (_e) { /* no storage */ }

    const tabBar = el("div", { class: "pc-feed-tabs", role: "tablist" });
    const sortSel = el("select", { class: "pc-feed-sort", title: t("feedSort") }, [
      el("option", { value: "default", text: t("sortDefault") }), el("option", { value: "date", text: t("sortDate") }), el("option", { value: "title", text: t("sortTitle") })]);
    const search = el("input", { class: "pc-feed-search", type: "search", placeholder: t("feedSearch") });
    const sub = el("div", { class: "pc-feed-sub" });
    const list = el("div", { class: "pc-feed-list" });
    box.append(el("div", { class: "pc-feed-head" }, [tabBar, el("div", { class: "pc-feed-tools" }, [search, sortSel])]), sub, list);

    const srcOf = new Map(tabs.filter((x) => x.src).map((x) => [x.id, source(x.src, p.limit || 30)]));
    const itemsOf = (tab) => {
      const s = srcOf.get(tab.id);
      return s ? s.items.slice(0, p.limit || 30).map((it) => Object.assign({}, it, { tab: tab.title, tabSrc: tab.src })) : [];
    };
    function itemNode(it) {
      const marked = isBookmarked(it);
      const open = () => {
        if (it.href && it.href.split("#")[0] !== String(it.tabSrc || "").split("#")[0]) openUrl(it.href, it.text, p.layer !== false);
        else if (it.a && it.a.isConnected) it.a.click(); // the board's own handler (e.g. its detail popup)
        else if (it.tabSrc) openUrl(it.tabSrc, it.tab, p.layer !== false);
      };
      const more = el("button", { class: "pc-btn-icon pc-feed-more", type: "button", title: t("more"), text: "⋯", onclick: (e) => { e.stopPropagation(); moreMenu(e.currentTarget, it); } });
      const star = el("button", { class: "pc-btn-icon pc-feed-star" + (marked ? " on" : ""), type: "button", title: t("bookmark"), text: marked ? "★" : "☆",
        onclick: (e) => { e.stopPropagation(); toggleBookmark(it); draw(); } });
      return el("div", { class: "pc-feed-item", tabindex: "0", title: it.row || it.text, onclick: open, onkeydown: (e) => { if (e.key === "Enter") open(); } }, [
        el("div", { class: "pc-feed-title" }, highlight(it.text, query)),
        el("div", { class: "pc-feed-meta" }, [current === "__all" || current === "__my" ? el("span", { class: "pc-feed-src", text: it.tab || "" }) : null,
          el("span", { class: "pc-feed-date", text: fmtDate(it.date) })]),
        el("div", { class: "pc-feed-actions" }, [star, more]),
      ]);
    }
    function moreMenu(anchor, it) {
      document.querySelectorAll(".pc-menu.pc-feed-menu").forEach((m) => m.remove());
      const url = it.href || it.tabSrc || "";
      const r = anchor.getBoundingClientRect();
      const m = el("div", { class: "pc-menu pc-feed-menu", style: { left: Math.min(r.left, innerWidth - 220) + "px", top: r.bottom + 4 + "px" } }, [
        el("button", { text: t("openNewTab"), onclick: () => { m.remove(); window.open(url, "_blank", "noopener"); } }),
        el("button", { text: t("copyUrl"), onclick: async () => { m.remove(); try { await navigator.clipboard.writeText(url); } catch (_e) { /* ignore */ } } }),
        el("button", { text: t("shareMail"), onclick: () => { m.remove(); location.href = "mailto:?subject=" + encodeURIComponent(it.text) + "&body=" + encodeURIComponent(it.text + "\n" + url); } }),
      ]);
      document.body.append(m);
      setTimeout(() => document.addEventListener("pointerdown", function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", off, true); } }, true), 0);
    }
    function draw() {
      tabBar.replaceChildren(...tabList.map((x) => el("button", { type: "button", role: "tab", class: "pc-feed-tab" + (x.id === current ? " on" : ""), "aria-selected": String(x.id === current), text: x.title || t("untitled"),
        onclick: () => { current = x.id; sort = "default"; sortSel.value = "default"; try { sessionStorage.setItem(stateKey, current); } catch (_e) { /* ignore */ } draw(); } })));
      const tab = tabs.find((x) => x.id === current);
      sub.replaceChildren(...(tab ? [
        tab.site ? el("a", { href: tab.site, target: "_blank", rel: "noopener", text: t("siteLink") + " ↗" }) : null,
        tab.write ? el("a", { href: tab.write, target: "_blank", rel: "noopener", class: "pc-feed-write", text: "✎ " + t("writePost") }) : null,
        tab.src ? el("button", { type: "button", class: "pc-btn-icon", title: t("refresh"), text: "↻", onclick: () => reloadSource(tab.src) }) : null,
      ] : []));
      sub.hidden = !sub.childElementCount;
      let items;
      if (current === "__all") items = L.mergeRoundRobin(tabs.map(itemsOf), p.limit || 30);
      else if (current === "__my") items = bookmarks.map((b) => ({ text: b.text, href: b.href, tab: b.tab, tabSrc: b.tabSrc, date: 0 }));
      else items = itemsOf(tab);
      if (query) items = items.filter((x) => x.text.toLowerCase().includes(query.toLowerCase()) || (x.row || "").toLowerCase().includes(query.toLowerCase()));
      items = L.sortItems(items, sort);
      const s = tab && srcOf.get(tab.id);
      if (tab && s && s.error) {
        // another site: show the page itself
        list.replaceChildren(el("iframe", { class: "pc-iframe", src: tab.src, title: tab.title || "" }));
        return;
      }
      list.replaceChildren(...(items.length ? items.map(itemNode) : [el("div", { class: "pc-empty", text: current === "__my" ? t("feedNoBookmarks") : query ? t("feedNoMatch") : t("feedLoading") })]));
    }
    let pending = 0;
    const redraw = () => { if (!box.isConnected) return; cancelAnimationFrame(pending); pending = requestAnimationFrame(draw); };
    srcOf.forEach((s) => s.listeners.add(redraw));
    bmListeners.add(redraw);
    sortSel.addEventListener("change", () => { sort = sortSel.value; draw(); });
    search.addEventListener("input", () => { query = search.value.trim(); draw(); });
    draw();
    if (p.refresh > 0 && !ctx.editing) ctx.timers.push(setInterval(() => tabs.forEach((x) => x.src && reloadSource(x.src)), p.refresh * 60000));
    ctx.cleanups.push(() => { srcOf.forEach((s) => s.listeners.delete(redraw)); bmListeners.delete(redraw); });
  }

  // ---------- settings editors ----------
  // Small table editor: one row per entry, with given text fields (+ optional image file button).
  function rowsEditor(rows, fields, opts) {
    const wrap = el("div", { class: "pc-rows" });
    const data = rows.map((r) => Object.assign({}, r));
    const draw = () => {
      wrap.replaceChildren(...data.map((r, i) => el("div", { class: "pc-rows-row" }, [
        ...fields.map((f) => {
          const inp = el("input", { type: "text", placeholder: f.label, title: f.label, value: f.key === "src" && String(r.src || "").startsWith("data:") ? t("uploadedImage") : (r[f.key] || "") });
          if (f.key === "src" && String(r.src || "").startsWith("data:")) inp.readOnly = true;
          inp.addEventListener("input", () => { r[f.key] = inp.value.trim(); });
          return inp;
        }),
        opts.image ? el("button", { type: "button", class: "pc-rows-btn", title: t("fieldImageFile"), text: "🖼", onclick: () => {
          const file = el("input", { type: "file", accept: "image/*" });
          file.addEventListener("change", async () => { if (file.files[0]) { r.src = await opts.readImage(file.files[0]); draw(); } });
          file.click();
        } }) : null,
        el("button", { type: "button", class: "pc-rows-btn", title: "↑", text: "↑", disabled: i === 0, onclick: () => { data.splice(i - 1, 0, data.splice(i, 1)[0]); draw(); } }),
        el("button", { type: "button", class: "pc-rows-btn", title: t("deletePanel"), text: "✕", onclick: () => { data.splice(i, 1); draw(); } }),
      ])), el("button", { type: "button", class: "pc-rows-add", text: "+ " + t("addRow"), onclick: () => { data.push(opts.blank ? opts.blank() : {}); draw(); } }));
    };
    draw();
    return { node: wrap, get: () => data, add: (r) => { data.push(r); draw(); } };
  }

  globalThis.PCMedia = { renderCarousel, renderFeed, openLayer, openUrl, rowsEditor, extract, _sources: sources };
})();
