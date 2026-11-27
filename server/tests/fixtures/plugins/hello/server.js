"use strict";
module.exports.register = (api) => {
  api.route("GET", "/ping", () => ({ pong: true, id: api.id, config: api.settings.get() }));
  api.route("GET", "/secret", (req) => { const a = api.need(req); return { user: a.user }; });
  api.route("POST", "/echo/:name", async (req, res, p) => { const b = await api.json(req); return { name: p.name, body: b }; });
  api.route("POST", "/config", async (req) => { api.need(req, "admin"); api.settings.set(await api.json(req)); api.audit("test", "설정 저장"); return { ok: true }; });
  api.panel({ name: "board", title: "Hello board", path: "/panel.html", height: 300 });
  let n = 0;
  api.route("POST", "/more", () => { n += 1; return { n }; });
  api.panelSource(() => Array.from({ length: n }, (_, i) => ({ name: "dyn-" + i, title: "Dynamic " + i, path: "/panel.html?i=" + i })));
  api.connector({ id: "hello.whoami", title: "Who am I", sites: ["http://portal.test/"], request: { method: "POST", url: "/api/me", body: { q: "{{args.q}}" } }, response: { pick: { name: "user.name" } } });
  api.connector({ id: "hello.compose", kind: "open", sites: ["http://portal.test/"], url: "/compose?to={{args.to|url}}", confirm: "작성 창을 열까요?" });
  api.adminPage({ id: "main", title: "Hello 설정", path: "/admin.html" });
  api.provide("identity", "hello", { describe: () => "hello identity" });
};
