<p align="center"><img src="assets/icon.svg" width="96" alt="Portal Customizer"></p>

<h1 align="center">Portal Customizer</h1>

<p align="center">Make your portal or dashboard page your own: the widgets of the page are found automatically, then you drag them around, resize columns and add image, link, memo and web page panels.</p>

<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

## How it works

Portal Customizer reads the component structure of the front-end framework that built the page to find its widgets (panels, cards, rows).

| Page | How widgets are found |
|------|-----------------------|
| Vue 3 | Root element of each component instance in the app's vnode tree (production builds included) |
| Vue 2 | Component root elements (`__vue__`) |
| React | First DOM element of each component in the fiber tree |
| Angular, web components | Custom element tags (`app-card` and so on) |
| Anything else | Page structure (boxes side by side with boxes stacked in them) |

The group of widgets that covers the largest area over two or more columns becomes the area to customize, and its widgets are split into columns. On the first edit of a page an administrator confirms the widget unit: the widgets found are outlined over the page and can be made bigger (one level up in the page tree), smaller (one level down) or picked from one sample widget. The choice is saved with the layout and sent to the admin server, so no selectors need to be written by hand.

The page's framework keeps rendering and updating its widgets. Portal Customizer never moves them in the page's DOM; it only decides where they appear, so their buttons, updates and clicks keep working.

## Features

| Feature | Description |
|---------|-------------|
| Per page | Turn it on with **Customize this page** in the popup (access to that site is asked once). Layouts are kept per page address; the popup shows the framework found and the widget count. |
| Edit mode | Shown after an administrator login to the admin server. An edit toolbar appears on the page. |
| Drag and drop | Move widgets between columns or reorder them; drag a column header to reorder columns. |
| Size and spacing | Drag a column edge for width, a panel's bottom edge for height; set panel and column gaps one by one or as defaults. A layout made from the page starts with the page's own spacing. |
| Widgets | Keep, hide or remove the page's widgets and hide their titles. Widgets re-created or rendered late by the page are found and placed again. |
| Extra panels | Image, links (list or banners), memo, web page, video, HTML (unsafe markup removed), carousel, tab feed (collects posts from boards on the same site). |
| Admin server | Optional server for administrators: layouts sent from the extension, default and scheduled layouts, the pages they apply to, contents (CMS), statistics, extension distribution. See [server/README.md](server/README.md). |
| Organization default | Point the extension to a layout file and the pages it names start with that layout; changes are picked up automatically. |
| Export / import | Save a layout as JSON and load it again. |
| One-click updates | When an administrator uploads a new version on the admin server's **확장 배포** page, the icon shows **NEW**; one click installs it. |

## Install

Developer mode install (Chrome, Edge and other Chromium browsers).

1. Download `portal-customizer-vX.Y.Z.zip` from [Releases](https://github.com/lisyoen/portal-customizer/releases/latest) and unzip it.
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and choose the folder.
3. Register the update helper once. Windows: double-click `updater\install-updater.bat`; macOS / Linux: `bash updater/install-updater.sh`.

## Use

1. Open the page, click the Portal Customizer icon and press **Customize this page**.
2. Log in as an administrator and turn on **Edit mode**. The page's widgets appear, split into columns.
3. Drag widgets by their title bar, add panels and columns from the toolbar, open ⚙ for settings.
4. Press **Save** (Ctrl+S). **Original layout** starts again from the page's own layout.

**Stop customizing this page** or the **Enable** switch in the popup brings the original page back at any time.

## Organization default

On the admin server, enter the page addresses (pages starting with the address; `*` matches anything) under **설정·업데이트 > 적용할 화면** and publish a layout. Staff enter `http://server:port/portal-customizer.json` under **Organization default** in the popup. File format: [docs/layout-format.md](docs/layout-format.md).

## Development

- `bash scripts/check.sh`: manifest, i18n, syntax, public repo guard, unit tests (layout, detection, server, updater).
- `NODE_PATH=/path/to/node_modules node tests/e2e/run.mjs`: Playwright end-to-end tests against Vue 3, Vue 2, React 18 and plain HTML dashboards (`tests/e2e/fixtures`); needs `playwright`, `vue@3`, `vue2@npm:vue@2`, `react@18`, `react-dom@18`. `tests/e2e/admin.mjs` covers the admin server.
- `scripts/release.sh <version> <notes.md>` builds the zip, tags and publishes a GitHub release.

## Contributing

Outside pull requests are not accepted; please open an issue. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy

The extension collects no personal data. Layouts, memos and images stay in the browser (`chrome.storage.local`); network requests go only to the organization layout address and the admin server. It runs only on sites you turned it on for. See [PRIVACY.md](PRIVACY.md).

## License: Business Source License 1.1

Portal Customizer is source-available under the [Business Source License 1.1](LICENSE) (not an OSI open source license).

- Installing, changing and running it inside your own organization is free, and changed versions may be shared under the same license.
- **Commercial Use** (providing it to other organizations for a fee: selling, building, customizing, operating, maintaining or hosting it for them) requires the author's **prior written consent** in a separate commercial license agreement.
- Each version converts to the Apache License 2.0 four years after its publication.

Commercial licensing: lisyoen@gmail.com
