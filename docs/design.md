# How Portal Customizer works

## Finding widgets

1. `content/probe.js` runs in the page's own JavaScript world (content scripts cannot see framework objects on DOM nodes). It marks the root element of every component instance with `data-pc-c="<name>"` and the frameworks found on `<html data-pc-fw>`:
   - Vue 3: the root vnode on the mount container (`_vnode`, kept in production builds) is walked; each component instance's `subTree.el` is its root element. Development builds also expose `__vueParentComponent`.
   - Vue 2: `__vue__` on component root elements.
   - React: the fiber on each element (`__reactFiber$…`); an element is a component root when it is the first host node of the nearest component fiber.
   - Angular and web components: custom element tags.
   It only adds attributes and re-runs (debounced) when the page changes, or when the content script asks (`pc:probe` event).
2. `lib/detect.js` (content script world) looks for the main widget area. For every element with two or more visible boxes it lists the widgets under it: its box children, where a plain column (no background, border or text of its own, holding stacked boxes) expands into the boxes in it, and single-child wrappers are skipped. The element scoring best wins: large area × number of widgets (two columns or more required) × share of framework components × how much of the area the widgets cover. Widgets are grouped into columns by their left edge. Titles come from headings or title/header elements near the top of the widget.
3. A site rule from the organization layout (`site.container`, `site.widget`, `site.title`) replaces the automatic choice for pages that are not detected well; `site.pause` stops customizing while an element is on the page (a maximized view, a full-screen dialog) and `site.avoid` keeps the layout left of a panel floating on the right.

Detection runs while nothing is mounted (it needs the page in its own shape). When widgets of a saved layout have not appeared yet, it retries every 0.5 s for up to 6 s.

## Showing a layout

- The page's widgets are never moved in the page's DOM (the framework keeps owning them). The detected container is collapsed (`height: 0`) and hidden; `#pc-root` is inserted right before it and takes its place in the page flow.
- Each page widget used by the layout gets an empty slot in `#pc-root`. Every animation frame the widget is positioned exactly over its slot (absolute position inside the collapsed container; elements in between are made `position: static`), so it keeps its own content, buttons and updates.
- When the framework re-creates a widget (a new DOM node), the lost node is noticed, the page is detected again and the layout is mounted again.
- Extra panels (image, links, memo, web page, video, HTML, carousel, feed) are ordinary elements inside `#pc-root`.
- Turning the page off removes `#pc-root` and restores every style and attribute it changed.

## Where it runs

Content scripts are registered at run time (`chrome.scripting.registerContentScripts`) for the sites of pages turned on in the popup and the pages the organization layout names, limited to sites the user allowed. Layouts are stored per page address (`origin + path`) in `sites`.

Code: layout model `extension/lib/layout.js`, detection `extension/lib/detect.js`, probe `extension/content/probe.js`, page logic `extension/content/content.js`, registration, updates and the organization layout `extension/background.js`.
