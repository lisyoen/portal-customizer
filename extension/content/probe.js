// Portal Customizer probe (runs in the page's own JavaScript world).
// Content scripts cannot see framework internals (Vue/React objects live on the page's DOM nodes as
// JavaScript properties), so this script reads them and leaves plain attributes the content script can read:
//   <html data-pc-fw="vue3,react">         frameworks found on the page
//   <div data-pc-c="UserCard">             root element of a component instance (its name)
// It only adds attributes; it never changes the page's own state.
(() => {
  "use strict";
  if (window.__pcProbe) return;
  const MAX_NODES = 20000;

  function vue3Name(inst) {
    const t = inst && inst.type;
    if (!t) return "";
    return t.name || t.__name || (t.__file ? String(t.__file).split(/[\\/]/).pop().replace(/\.\w+$/, "") : "") || "";
  }
  function reactName(type) {
    if (!type) return "";
    if (typeof type === "function") return type.displayName || type.name || "";
    if (typeof type === "object") return type.displayName || (type.render && (type.render.displayName || type.render.name)) || (type.type && reactName(type.type)) || "";
    return "";
  }
  // React: the fiber that created a DOM element is stored on it under a random key.
  function fiberOf(el) {
    for (const k in el) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k];
    return null;
  }
  function firstHost(fiber) {
    let f = fiber && fiber.child;
    while (f) { if (f.tag === 5) return f.stateNode; f = f.child; }
    return null;
  }

  // Vue 3 production builds keep no per-element marks, but the mount container holds the root vnode:
  // walk the vnode tree and name the root element of every component instance (innermost named wins).
  function walkVue3(vnode, names, depth) {
    if (!vnode || depth > 400) return;
    const inst = vnode.component;
    if (inst) {
      const el = inst.subTree && inst.subTree.el;
      if (el && el.nodeType === 1) { const nm = vue3Name(inst); if (nm || !names.has(el)) names.set(el, nm || "Component"); }
      walkVue3(inst.subTree, names, depth + 1);
      return;
    }
    if (Array.isArray(vnode.children)) for (const c of vnode.children) if (c && typeof c === "object") walkVue3(c, names, depth + 1);
  }

  function probe() {
    const found = new Set();
    const nodes = document.body ? document.body.getElementsByTagName("*") : [];
    const n = Math.min(nodes.length, MAX_NODES);
    const vueNames = new Map();
    for (let i = 0; i < n; i++) {
      const el = nodes[i];
      if (el.__vue_app__ || (el._vnode && el._vnode.__v_isVNode)) { found.add("vue3"); walkVue3(el._vnode, vueNames, 0); }
    }
    for (let i = 0; i < n; i++) {
      const el = nodes[i];
      if (el.closest && el.closest("#pc-root")) continue;
      let name = vueNames.get(el) || "";
      // Vue 3: the component instance whose rendered root is this element
      const v3 = !name && el.__vueParentComponent;
      if (v3) {
        found.add("vue3");
        let inst = v3;
        while (inst && inst.subTree && inst.subTree.el === el) { if (vue3Name(inst)) { name = vue3Name(inst); break; } inst = inst.parent; }
      }
      // Vue 2: __vue__ is set on a component's root element
      if (!name && el.__vue__) {
        found.add("vue2");
        const vm = el.__vue__;
        if (vm.$el === el && vm.$parent) name = (vm.$options && (vm.$options.name || vm.$options._componentTag)) || "Component";
      }
      // React: nearest component above this element, if this element is that component's first host node
      if (!name) {
        const fiber = fiberOf(el);
        if (fiber) {
          found.add("react");
          let f = fiber.return;
          while (f && f.tag !== 5) {
            if ((f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15) && reactName(f.type)) {
              if (firstHost(f) === el) name = reactName(f.type);
              break;
            }
            f = f.return;
          }
        }
      }
      // Angular components and other custom elements (web components): the tag is the component
      if (!name && el.tagName.includes("-")) {
        if (el.__ngContext__ !== undefined) found.add("angular");
        name = el.tagName.toLowerCase();
      }
      if (name) { if (el.getAttribute("data-pc-c") !== name) el.setAttribute("data-pc-c", name); }
      else if (el.hasAttribute("data-pc-c")) el.removeAttribute("data-pc-c");
    }
    if (document.querySelector("[ng-version]")) found.add("angular");
    if (document.querySelector("[class*='svelte-']")) found.add("svelte");
    const fw = [...found].sort().join(",");
    if (document.documentElement.getAttribute("data-pc-fw") !== fw) document.documentElement.setAttribute("data-pc-fw", fw);
    document.documentElement.setAttribute("data-pc-probed", String(Date.now()));
    return fw;
  }

  let timer = 0;
  function soon() { clearTimeout(timer); timer = setTimeout(probe, 150); }
  // the content script asks for a fresh probe before it scans the page
  document.addEventListener("pc:probe", () => probe());
  new MutationObserver((list) => {
    for (const m of list) if (m.type === "childList" && !(m.target.closest && m.target.closest("#pc-root"))) { soon(); return; }
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.__pcProbe = { probe };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", probe); else probe();
})();
