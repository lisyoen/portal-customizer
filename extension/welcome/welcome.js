// Guide page opened after install and after updates (at most once a week): how to close Edge's developer mode
// warning without turning the extension off, how to turn it back on, the administrator's notice.
(() => {
  "use strict";
  const t = (k, s) => chrome.i18n.getMessage(k, s) || "";
  document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
  const reason = new URLSearchParams(location.search).get("reason");
  const v = chrome.runtime.getManifest().version;
  const title = reason === "update" ? t("welcomeTitleUpdate", [v]) : reason === "install" ? t("welcomeTitleInstall") : t("welcomeTitleManual");
  document.getElementById("title").textContent = title;
  document.title = title;
  async function fill() {
    const s = await chrome.storage.local.get(["clientId", "orgConfig"]);
    document.getElementById("pcId").textContent = t("welcomeId", [(s.clientId || "-").slice(0, 8)]);
    const notice = (s.orgConfig && s.orgConfig.notice) || "";
    document.getElementById("adminSec").hidden = !notice;
    document.getElementById("notice").textContent = notice;
  }
  fill();
  // right after install the organization layout (and its notice) may still be on its way
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && (c.orgConfig || c.clientId)) fill(); });
  document.getElementById("closeBtn").addEventListener("click", () => window.close());
})();
