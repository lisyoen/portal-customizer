// Which layout is published at a given moment. Pure functions (unit tested).
"use strict";

function ms(v) { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null; }

// A scheduled layout is shown between start and end. Layouts with neither and not default are drafts.
function status(l, now) {
  if (l.enabled === false) return "off";
  if (l.isDefault) return "default";
  const s = ms(l.start), e = ms(l.end);
  if (s == null && e == null) return "draft";
  if (s != null && now < s) return "upcoming";
  if (e != null && now >= e) return "ended";
  return "live";
}

// Scheduled layouts win over the default during their period; when periods overlap the one higher in the list wins.
// The default layout is shown whenever no scheduled layout is live.
function resolve(layouts, now) {
  const t = now == null ? Date.now() : now;
  const live = layouts.filter((l) => status(l, t) === "live");
  if (live.length) return { layout: live[0], reason: "scheduled" };
  const def = layouts.find((l) => l.isDefault && l.enabled !== false);
  if (def) return { layout: def, reason: "default" };
  return { layout: null, reason: "none" };
}

// Default first, then the rest in their saved order.
function ordered(layouts) {
  return layouts.slice().sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || (a.order || 0) - (b.order || 0));
}

// Times at which the published layout may change (for the timeline view).
function timeline(layouts, from, to) {
  const points = new Set([from]);
  for (const l of layouts) for (const v of [ms(l.start), ms(l.end)]) if (v != null && v > from && v < to) points.add(v);
  const sorted = [...points].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((p, i) => {
    const r = resolve(layouts, p);
    const id = r.layout ? r.layout.id : null;
    if (out.length && out[out.length - 1].id === id) return;
    out.push({ at: p, id, name: r.layout ? r.layout.name : "", reason: r.reason });
  });
  out.forEach((seg, i) => { seg.until = i + 1 < out.length ? out[i + 1].at : to; });
  return out;
}

module.exports = { status, resolve, ordered, timeline, ms };
