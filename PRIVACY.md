# Privacy

The Portal Customizer extension does not collect, send or sell personal data. It talks only to the organization layout address you or your administrator set, usually your own company's Portal Customizer admin server.

- **Stored in your browser** (`chrome.storage.local`): the anonymous install id, the connection settings of the installation package (`config.json`), your layouts (per page address), memo texts, uploaded pictures, the organization layout address and the last downloaded organization layout, update check results.
- **Where it runs**: only on pages you turned on with **Customize this page** and pages named by your organization layout, and only on sites you allowed it to access. It reads the page's structure there (framework components and boxes) to find widgets; nothing of the page is sent anywhere.
- **Network requests made by the extension**
  - The organization layout address you enter (or your administrator sets): every 60 minutes by default, at the interval the layout file or you set, and when you press Load. These requests carry an anonymous random install id and the extension version (`X-PC-Client`, `X-PC-Version`) so the admin server can count installations; no name, account or page content is sent. The admin server records, per install id, the time of the last request, the extension version, the browser and operating system (from the request's User-Agent) and the network address the request came from, so administrators can see which installations stopped checking in. The user of a PC may name its installation from the popup, and administrators may give an installation a name, a person in charge and a note (for example a meeting room PC); the name is sent back to that installation and shown in its popup.
  - The same admin server's `/ext/latest.json`: version check (about once a minute while the browser runs).
  - Administrators only: the admin server address they log in to, for login and for sending layouts.
  - Images and web pages you add to panels are loaded by the page like any other link.
- **Updater helper** (optional, registered by you): when you click update it downloads the extension package from the admin server and replaces the extension files in the same folder.
