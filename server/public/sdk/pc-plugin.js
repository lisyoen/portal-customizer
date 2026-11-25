// Portal Customizer plugin panel helper. Include it in a plugin's panel page:
//   <script src="/sdk/pc-plugin.js"></script>
//   const me = await PC.call("myplugin.whoami", { q: "x" });   // runs the connector in the portal tab
// PC.site / PC.page / PC.panel come from the panel url; PC.inPortal is false when the page is opened directly.
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const pending = new Map();
  let seq = 0;
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.pc !== "result" || e.source !== window.parent || !pending.has(d.id)) return;
    const p = pending.get(d.id); pending.delete(d.id); clearTimeout(p.timer);
    if (d.ok) p.resolve(d.data); else p.reject(Object.assign(new Error(d.error || "연동 실패"), { code: d.code || "" }));
  });
  function call(op, args, timeoutMs) {
    if (window.parent === window) return Promise.reject(new Error("포털 화면 안에서만 쓸 수 있습니다"));
    return new Promise((resolve, reject) => {
      const id = "c" + (++seq) + "-" + Date.now();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("확장이 응답하지 않습니다")); }, timeoutMs || 130000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ pc: "call", id, op, args: args || {} }, q.get("pc_site") || "*");
    });
  }
  window.PC = { call, site: q.get("pc_site") || "", page: q.get("pc_page") || "", panel: q.get("pc_panel") || "", inPortal: window.parent !== window && !!q.get("pc_site") };
})();
