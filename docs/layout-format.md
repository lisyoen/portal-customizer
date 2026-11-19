# Layout file format

A layout is the JSON written by **Export**. The same file works as an organization default.

```json
{
  "schema": 1,
  "version": "20261116093000",
  "name": "Team default",
  "columns": [
    { "id": "c1", "width": 380, "panels": [
      { "id": "p1", "type": "native", "key": "c:NoticeCard|Notice", "title": "Notice", "height": 200 },
      { "id": "p2", "type": "image", "src": "https://intranet.example.com/banner.png", "href": "https://intranet.example.com", "fit": "cover", "height": 160, "header": false }
    ]},
    { "id": "c2", "flex": 1, "panels": [
      { "id": "p3", "type": "native", "key": "src:/widgets/calendar?view=month", "title": "Calendar", "height": null },
      { "id": "p4", "type": "links", "title": "Shortcuts", "items": [{ "title": "Wiki", "url": "https://wiki.example.com" }], "newTab": true },
      { "id": "p5", "type": "memo", "title": "Notice", "text": "Default memo text", "height": 160 },
      { "id": "p6", "type": "iframe", "title": "Dashboard", "url": "https://dash.example.com", "height": 320 }
    ]}
  ]
}
```

| Field | Meaning |
|-------|---------|
| `version` | Any string. When it changes, people using the default get the new layout; people with their own layout see a notice. If missing, a hash of the file is used. |
| `name` | Shown in the popup. |
| `refreshMinutes` | Optional. How often (minutes, 1–1440) browsers check this file again. Default 60. A value the user types in the popup wins; the admin server publishes its own setting here (default 5). |
| `match` | Organization layout only. Pages it applies to: address prefixes (array or space-separated), `*` matches anything, e.g. `["https://portal.example.com/home"]`. Without it the layout applies to no page. |
| `site` | Organization layout only, optional. CSS selectors for pages automatic detection does not get right: `container` (element holding the widgets), `widget` (each widget), `title` (title inside a widget), `pause` (while this element exists the page is left as it is), `avoid` (panel floating on the right; the layout stays left of it). |
| column `width` / `flex` | Fixed width in px (120–3000), or `"flex": 1` to fill the remaining width. |
| panel `height` | px (40–4000) or `null` to share the remaining column height. |
| `gaps.panel` / `gaps.col` | Default space between panels in a column and between columns (px, default 16 each). |
| column `gap` / panel `gap` | Space left of that column / above that panel (0–200 px), overriding the default. |
| panel `hidden` | `true` keeps the panel in the layout but does not show it. |
| panel `header` | `false` hides the title bar (custom panels). |
| `native` `key` | Identifies a widget of the page: `src:` + path and sorted query of its only frame, else `c:` + component name (+ `|` + title), else `title:` + title. Keys not found on a page are skipped. |
| `image` `src` | `https://` / `http://` address or a `data:image/...` value (uploaded pictures are exported this way). |

Only `http(s)` addresses are accepted for links, images and web pages; other values are dropped when the file is loaded.

## Setting the address for everyone (administrators)

Portal Customizer reads the managed storage key `orgConfigUrl`. With Chrome on Windows, for example:

```
HKEY_LOCAL_MACHINE\Software\Policies\Google\Chrome\3rdparty\extensions\cfbjnlfoibngobcpbepnpcmkefdippce\policy
    orgConfigUrl (REG_SZ) = https://intranet.example.com/portal-customizer.json
```

(Edge: `HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\...\policy`.) The browser still needs access to that server: allow it once from the popup with **Load**, or serve the file with an `Access-Control-Allow-Origin` header.

## Media-style panels

```json
{ "id": "f1", "type": "feed", "title": "News", "height": 420, "view": "card", "all": true, "first": "", "layer": true, "refresh": 10, "limit": 30,
  "tabs": [{ "id": "t1", "title": "Company board", "src": "https://portal.example.com/board/list?id=1", "site": "https://...", "write": "https://..." }] }
{ "id": "c1", "type": "carousel", "height": 240, "interval": 5, "fit": "cover", "captions": true, "layer": false,
  "slides": [{ "title": "Featured", "href": "https://...", "src": "https://.../slide.png" }] }
{ "id": "b1", "type": "links", "display": "grid", "items": [{ "title": "Wiki", "url": "https://...", "img": "https://.../logo.png" }] }
```

A feed tab whose address is on the same site as the portal is read in the background and its posts (links in the board list) are shown as cards; a tab on another site shows the page itself. Bookmarks are personal and are not part of the layout file.
