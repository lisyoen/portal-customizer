// Portal Customizer early script (document_start): on a page with a saved layout, keeps the page's widget area
// hidden until content.js has mounted the layout, so a reload does not show the original arrangement first.
// The selector is the container found last time (cloak:<page>) or the widget rule's container. The rule is
// scoped to html:not(.pc-active), so it stops applying as soon as the layout is mounted; content.js removes it
// when nothing is going to be drawn, and it removes itself after 10 s whatever happens.
(() => {
  "use strict";
  if (window.__portalCustomizerEarly) return;
  window.__portalCustomizerEarly = true;
  const SITE = location.origin + location.pathname;
  const CK = "cloak:" + SITE;
  let api;
  try { api = chrome.storage.local; } catch (_e) { return; }
  const AK = "asis:" + SITE;
  api.get(["enabled", "sites", "orgConfig", CK, AK]).then((r) => {
    if (r.enabled === false) return;
    const st = (r.sites || {})[SITE] || {};
    const org = r.orgConfig;
    const L = globalThis.PCLayout;
    const orgOn = !!(org && org.layout && L && L.matchesSite(org.match, location.href));
    if (!st.on && !orgOn) return;
    const lay = st.customized && st.userLayout ? st.userLayout : orgOn ? org.layout : null;
    if (!lay) return;
    // last time this layout matched the page and nothing was drawn: do not hide anything
    if (r[AK] && L && L.sig && L.sig(lay) === r[AK]) return;
    const rule = st.rule || lay.site || (orgOn && org.site) || null;
    const sel = String(r[CK] || (rule && rule.container) || "").trim();
    if (!sel) return;
    try { document.querySelector(sel); } catch (_e) { return; }
    const s = document.createElement("style");
    s.id = "pc-cloak";
    s.textContent = `html:not(.pc-active) :is(${sel}) { visibility: hidden !important; }`;
    (document.head || document.documentElement).appendChild(s);
    setTimeout(() => s.remove(), 10000);
  }).catch(() => { /* extension reloaded */ });
})();
