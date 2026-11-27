# Plugins

The admin server can be extended with plugins: folders that add server routes, admin pages, panels that the
extension can place on a page, and *site connectors* — declarative requests the extension runs inside the
portal's own tab with the user's session. Plugins are separate packages; the core does not ship any.

## Package

```
my-plugin/
  plugin.json        { "id": "my-plugin", "name": "My plugin", "version": "1.0.0", "main": "server.js", "minCore": "0.5.0" }
  server.js          module.exports.register = (api) => { ... }
  public/            served at /p/my-plugin/ (panel pages, admin pages, assets)
```

- `id`: lowercase letters, digits and hyphens (2–40). Data that belongs to the plugin goes in `api.dataDir`
  (`<data>/plugin-data/<id>/`, included in the server backup).
- Install: admin console **Plugins** → upload a zip (plugin.json at the top or in one top folder). Uploading the
  same id replaces the plugin and loads its code again. Plugins can be switched off and removed (their data stays).
- Development: `PC_PLUGIN_DIRS=/path/a:/path/b node server.js` loads plugins from those folders (shown as
  development plugins; they cannot be replaced or removed from the console).
- A plugin that throws while loading is listed with its error; the server keeps running.

## Server API (`register(api)`)

| Member | Use |
|--------|-----|
| `api.route(method, path, handler)` | Route under `/api/p/<id><path>`. `handler(req, res, params, query)`; return a value to send it as JSON |
| `api.panel({ name, title, path, height, sites })` | Panel type offered in the extension's **Add panel** menu (page `/p/<id><path>`, optional page address prefixes) |
| `api.panelSource(fn)` | Panels that follow the plugin's data (e.g. one per board): `fn()` returns panel definitions each time the extension asks |
| `api.connector(def)` | Site connector (below) published to the extensions |
| `api.adminPage({ id, title, path })` | Page shown inside the admin console (same origin, uses the console login) |
| `api.provide(kind, name, impl)` / `api.use(kind)` | Services shared between plugins. Kinds: `identity`, `notify`, `profile`, `share`, `source` |
| `api.settings.get()` / `set(obj)` | Plugin settings stored with the server data |
| `api.need(req, role)` | Require an admin console login (`role: "admin"` for administrators) |
| `api.json(req)`, `api.readBody(req, limit)`, `api.send`, `api.fail(status, msg)`, `api.baseUrl(req)` | Helpers |
| `api.audit(by, action, target, detail)`, `api.log(msg)` | Audit log entry, server log |

## Panels

A plugin panel is the plugin's page shown in an iframe on the portal page. The URL gets `pc_site` (portal origin),
`pc_page` and `pc_panel`. Include the helper and call connectors:

```html
<script src="/sdk/pc-plugin.js"></script>
<script>
  const r = await PC.call("my-plugin.lookup", { q: "kim" });   // { status, ok, data }
</script>
```

The extension answers only iframes it created for that plugin, from the origin of the panel URL.

## Site connectors

```json
{ "id": "my-plugin.lookup", "kind": "fetch", "sites": ["https://portal.example.com/"],
  "request": { "method": "POST", "url": "/api/search", "bodyType": "json", "body": { "query": "{{args.q}}" }, "timeoutMs": 30000 },
  "response": { "type": "json", "pick": { "names": "items[].name" } } }
{ "id": "my-plugin.compose", "kind": "open", "sites": ["https://portal.example.com/"],
  "url": "/compose?to={{args.to|join|url}}", "confirm": "Open the compose window?" }
```

- Runs only on pages whose address starts with one of `sites`, and only against that page's origin (with its cookies).
- `confirm`: the user is asked before it runs.
- Templates: `{{args.x}}` (a whole-string template keeps the value's type), filters `url`, `json`, `b64`, `html`,
  `str`, `num`, `join`; objects `{ "$each": "{{args.list}}", "item": { ... "{{item}}" ... } }`,
  `{ "$b64": "..." }`, `{ "$mime": { "html": "..." } }` (HTML message as a MIME multipart/related text).
- `response.pick`: output key → path (`a.b`, `list[].name`).
- Connector definitions live on the admin server, so a change on the portal side is fixed there without
  releasing the extension again. The extension never runs code from the server.
