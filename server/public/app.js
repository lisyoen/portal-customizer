// Portal Customizer admin console (no build step).
"use strict";
const $app = document.getElementById("app");
let me = null;

// ---------- utils ----------
function h(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children == null ? [] : children)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (raw) { opt.body = body; if (raw !== true) opt.headers["Content-Type"] = raw; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, opt);
  if (r.status === 401 && url !== "/api/login") { me = null; renderLogin(); throw new Error("로그인이 필요합니다"); }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || String(data) || r.statusText);
  return data;
}
function toast(msg) { const t = h("div", { class: "toast", text: msg }); document.body.append(t); setTimeout(() => t.remove(), 2600); }

// Copy text: the Clipboard API needs a secure page (https or localhost); over plain http fall back to a
// hidden textarea + execCommand, and as a last resort show the text selected for Ctrl+C.
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); toast("복사했습니다"); return true; } } catch (_e) { /* fall back */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand("copy"); } catch (_e) { ok = false; }
  ta.remove();
  if (ok) { toast("복사했습니다"); return true; }
  window.prompt("Ctrl+C 로 복사하세요", text);
  return false;
}
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message); return null; } }
function fmt(iso) { if (!iso) return "-"; const d = new Date(iso); return d.toLocaleString("ko-KR", { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function toLocalInput(iso) { if (!iso) return ""; const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function size(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B"; }
function modal(title, content, actions) {
  const close = () => back.remove();
  const box = h("div", { class: "modal" }, [h("h3", { text: title }), content, h("div", { class: "row", style: { justifyContent: "flex-end", marginTop: "14px" } }, (actions || []).map((a) => h("button", { class: a.cls || "", text: a.text, onclick: async () => { if ((await a.run()) !== false) close(); } })).concat([h("button", { text: "닫기", onclick: close })]))]);
  const back = h("div", { class: "modal-back", onclick: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  return { close, box };
}
function pickFile(accept) { return new Promise((resolve) => { const i = h("input", { type: "file", accept: accept || "" }); i.addEventListener("change", () => resolve(i.files[0] || null)); i.click(); }); }
async function upload(file) { return api("PUT", "/api/upload?name=" + encodeURIComponent(file.name), file, file.type || "application/octet-stream"); }
const STATUS = { default: "기본", live: "공개 중", upcoming: "공개 예정", ended: "종료", draft: "미게시", off: "사용 안 함" };
const TYPES = { native: "화면 위젯", image: "이미지", video: "동영상", html: "하이퍼텍스트", memo: "메모", links: "링크 모음", iframe: "웹 페이지", carousel: "캐러셀", feed: "탭 피드" };
const CTYPES = { image: "이미지", video: "동영상", text: "텍스트", html: "하이퍼텍스트", link: "링크" };

// ---------- shell ----------
// name from settings: sidebar title, login title and browser tab
let siteName = "Portal Customizer";
function setSiteName(n) { siteName = (n || "").trim() || "Portal Customizer"; document.title = siteName + " 관리"; }
async function loadSiteName() { try { setSiteName((await api("GET", "/api/health")).siteName); } catch (_e) { /* keep default */ } }
function renderLogin(msg) {
  const user = h("input", { type: "text", placeholder: "아이디", autocomplete: "username" });
  const pw = h("input", { type: "password", placeholder: "비밀번호", autocomplete: "current-password" });
  const err = h("div", { class: "err", text: msg || "" });
  const go = async () => {
    try { await api("POST", "/api/login", { user: user.value, password: pw.value, label: "web" }); await boot(); }
    catch (e) { err.textContent = e.message; }
  };
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $app.replaceChildren(h("div", { class: "card login" }, [h("img", { src: "favicon.svg", alt: "" }), h("h1", { style: { justifyContent: "center" }, text: siteName + " 관리" }), user, pw, err,
    h("button", { class: "primary", style: { width: "100%" }, text: "로그인", onclick: go })]));
  user.focus();
}
const PAGES = [["layouts", "배치"], ["contents", "콘텐츠(CMS)"], ["stats", "통계"], ["admins", "관리자·감사 로그"], ["extension", "확장 배포"], ["settings", "설정·업데이트"], ["manual", "매뉴얼"], ["license", "라이선스"]];
function shell(active, content) {
  $app.replaceChildren(h("div", { class: "layout" }, [
    h("nav", { class: "side" }, [h("a", { class: "brand", href: "#/layouts", title: "배치 목록으로", id: "brand", onclick: () => { if (location.hash === "#/layouts") route(); } }, [h("img", { src: "favicon.svg", alt: "" }), siteName]), versionBox(),
      ...PAGES.filter(([k]) => k !== "admins" || me.role === "admin").map(([k, t]) => h("a", { href: "#/" + k, class: active === k ? "on" : "", text: t })),
      h("div", { class: "grow" }),
      h("div", { class: "me", text: `${me.name} (${me.role === "admin" ? "관리자" : "편집자"})` }),
      h("a", { href: "#", text: "비밀번호 변경", onclick: (e) => { e.preventDefault(); changePassword(); } }),
      h("a", { href: "#", text: "로그아웃", onclick: async (e) => { e.preventDefault(); await api("POST", "/api/logout"); me = null; renderLogin(); } })]),
    h("main", {}, content)]));
}
// version under the title, like Skipper: current version, update button when a newer release exists, release link
let upd = null, updTimer = null;
function versionBox() {
  const box = h("div", { class: "ver", id: "verBox" });
  fillVersion(box);
  if (!updTimer) { refreshUpdate(); updTimer = setInterval(refreshUpdate, 60000); }
  return box;
}
async function refreshUpdate() {
  try { upd = await api("GET", "/api/update"); } catch (_e) { return; }
  // the server was updated while this page stayed open: load the new screens (menus) too
  if (pageVersion && upd.current && upd.current !== pageVersion) {
    if (!(ed && ed.dirty)) { location.reload(); return; }
    if (!staleNoticed) { staleNoticed = true; toast("관리 서버가 v" + upd.current + " 로 업데이트되었습니다. 저장한 뒤 새로고침하세요."); }
  }
  const box = document.getElementById("verBox"); if (box) fillVersion(box);
}
function fillVersion(box) {
  const isAdmin = me && me.role === "admin";
  const cur = upd ? upd.current : "";
  const c = upd && upd.check;
  const running = upd && upd.status && !["done", "failed"].includes(upd.status.phase) && Date.now() - Date.parse(upd.status.at || 0) < 10 * 60000;
  box.replaceChildren(
    h("div", { class: "row" }, [h("span", { class: "ver-num", text: cur ? "v" + cur : "…" }),
      upd ? h("a", { href: upd.releaseUrl || upd.releases, target: "_blank", rel: "noopener", text: "릴리스 노트" }) : null]),
    running ? h("div", { class: "ver-note", text: "업데이트 중…" })
      : c && c.newer ? h("button", { class: "primary ver-btn", disabled: !isAdmin, title: isAdmin ? "" : "관리자만 업데이트할 수 있습니다", text: `v${c.latest} 로 업데이트`,
        onclick: () => confirm(`v${c.latest} 로 업데이트합니다. 잠시 서버가 재시작됩니다. 진행할까요?`) && guard(async () => { await api("POST", "/api/update/apply", {}); toast("업데이트를 시작했습니다"); waitUpdate(); }) })
      : h("button", { class: "ver-btn", disabled: !isAdmin, text: !c ? "새 버전 확인" : c.ok === false ? "확인 실패 · 다시 확인" : "최신 버전 · 다시 확인", title: c && c.error ? c.error : (c ? "확인 " + fmt(c.at) : ""),
        onclick: () => guard(async () => { const r = await api("POST", "/api/update/check"); toast(r.ok ? (r.newer ? `v${r.latest} 이 있습니다` : "최신 버전입니다") : "확인 실패: " + r.error); refreshUpdate(); }) }),
    upd ? h("a", { class: "ver-all", href: upd.releases, target: "_blank", rel: "noopener", text: "GitHub 릴리스 전체" }) : null);
}
function changePassword() {
  const cur = h("input", { type: "password" }), pw = h("input", { type: "password" });
  modal("비밀번호 변경", h("div", {}, [h("div", { class: "field" }, [h("label", { text: "현재 비밀번호" }), cur]), h("div", { class: "field" }, [h("label", { text: "새 비밀번호(8자 이상)" }), pw])]),
    [{ text: "변경", cls: "primary", run: () => guard(async () => { await api("POST", "/api/me/password", { current: cur.value, password: pw.value }); toast("변경했습니다"); }) }]);
}
let pageVersion = "", staleNoticed = false; // server version this page's code came with
async function boot() {
  try { const r = await api("GET", "/api/me"); me = r.admin; pageVersion = r.version || pageVersion; } catch (_e) { return; }
  route();
}
window.addEventListener("hashchange", () => { if (me) route(); });
function route() {
  const [, page, id] = location.hash.split("/");
  if (page === "layout" && id) return pageLayout(id);
  if (page === "contents") return pageContents(id);
  if (page === "stats") return pageStats();
  if (page === "admins" && me.role === "admin") return pageAdmins();
  if (page === "settings") return pageSettings();
  if (page === "extension") return pageExtension();
  if (page === "manual") return pageDoc("manual", "매뉴얼");
  if (page === "license") return pageDoc("license", "라이선스");
  return pageLayouts();
}

// ---------- extension distribution ----------
async function pageExtension() {
  const d = await api("GET", "/api/extension");
  const isAdmin = me.role === "admin";
  const notes = h("textarea", { rows: 3, placeholder: "변경 내용(선택)", style: { width: "100%" } });
  const publish = h("input", { type: "checkbox", checked: true });
  const latest = location.origin + d.latestUrl;
  shell("extension", [h("h1", { text: "확장 배포" }),
    h("div", { class: "card" }, [
      h("p", { style: { marginTop: 0 }, text: d.current ? `지금 배포 중: v${d.current}` : "배포 중인 확장 패키지가 없습니다." }),
      h("p", { class: "muted", html: "직원 확장의 팝업에서 <b>업데이트 받을 곳</b>이 <b>관리 서버</b>(또는 자동)이면 이 서버에서 새 버전을 받습니다. 확장 업데이트는 관리 서버 업데이트와 따로 합니다. 확인 주소: " }, [h("code", { text: latest })]),
      h("div", { class: "field" }, [h("label", { text: "확장 패키지 올리기 (GitHub 릴리스의 portal-customizer-vX.Y.Z.zip)" }), notes]),
      h("div", { class: "row" }, [h("label", { class: "row" }, [publish, "올리면서 바로 배포"]),
        h("button", { class: "primary", disabled: !isAdmin, text: "zip 파일 선택해서 올리기", onclick: async () => {
          const f = await pickFile(".zip,application/zip"); if (!f) return;
          await guard(async () => { const r = await api("PUT", `/api/extension?publish=${publish.checked ? 1 : 0}&notes=${encodeURIComponent(notes.value)}`, f, "application/zip"); toast(`v${r.release.version} 을(를) 올렸습니다`); pageExtension(); });
        } }),
        d.current ? h("button", { disabled: !isAdmin, text: "배포 중지", onclick: () => confirm("확장 배포를 중지할까요? 직원 확장은 새 버전을 받지 못합니다.") && guard(async () => { await api("POST", "/api/extension/unpublish"); pageExtension(); }) }) : null])]),
    h("div", { class: "card" }, [h("h2", { style: { marginTop: 0 }, text: "올린 패키지" }),
      d.releases.length ? h("table", {}, [h("thead", {}, h("tr", {}, ["버전", "올린 시각", "올린 사람", "크기", "변경 내용", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, d.releases.map((r) => h("tr", {}, [
          h("td", {}, [h("b", { text: "v" + r.version }), r.version === d.current ? h("span", { class: "badge", text: " 배포 중" }) : null]),
          h("td", { text: fmt(r.uploadedAt) }), h("td", { text: r.by || "" }), h("td", { text: Math.round(r.size / 1024) + " KB" }),
          h("td", { class: "muted", text: r.notes || "" }),
          h("td", {}, [h("a", { href: "/ext/portal-customizer-v" + r.version + ".zip", text: "받기" }), " ",
            r.version !== d.current ? h("button", { class: "small", disabled: !isAdmin, text: "이 버전 배포", onclick: () => guard(async () => { await api("POST", `/api/extension/${r.version}/publish`); toast(`v${r.version} 을(를) 배포합니다`); pageExtension(); }) }) : null, " ",
            r.version !== d.current ? h("button", { class: "small danger", disabled: !isAdmin, text: "삭제", onclick: () => confirm(`v${r.version} 패키지를 지울까요?`) && guard(async () => { await api("DELETE", "/api/extension/" + r.version); pageExtension(); }) }) : null])])))])
        : h("p", { class: "muted", text: "아직 올린 패키지가 없습니다." })])]);
}

// ---------- manual / license (markdown from the repository docs) ----------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function mdInline(s) {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function markdown(text) {
  const lines = String(text).replace(/\r/g, "").split("\n"); const out = []; let i = 0;
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i += 1; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i += 1; out.push("<pre>" + esc(buf.join("\n")) + "</pre>"); continue; }
    const hm = /^(#{1,4})\s+(.*)$/.exec(l);
    if (hm) { const n = Math.min(4, hm[1].length + 1); out.push(`<h${n}>${mdInline(hm[2])}</h${n}>`); i += 1; continue; }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push("<table><thead><tr>" + head.map((c) => "<th>" + mdInline(c) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c) => "<td>" + mdInline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>");
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>` + items.map((t) => "<li>" + mdInline(t) + "</li>").join("") + `</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (!l.trim()) { i += 1; continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#|```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push("<p>" + para.map(mdInline).join("<br>") + "</p>");
  }
  return out.join("\n");
}
async function pageDoc(name, title) {
  const d = await api("GET", "/api/docs/" + name);
  const body = h("div", { class: "card doc", html: markdown(d.text) });
  const extra = [];
  if (name === "license") {
    const full = h("pre", { class: "license-text", hidden: true });
    extra.push(h("div", { class: "card" }, [h("button", { text: "LICENSE 전문 보기", onclick: async (e) => {
      if (!full.textContent) full.textContent = (await api("GET", "/api/docs/license-text")).text;
      full.hidden = !full.hidden; e.currentTarget.textContent = full.hidden ? "LICENSE 전문 보기" : "전문 접기";
    } }), full]));
  }
  shell(name, [h("h1", { text: title }), body, ...extra]);
}

// ---------- layouts list ----------
async function pageLayouts() {
  const d = await api("GET", "/api/layouts");
  const tl = await api("GET", "/api/timeline");
  const colors = ["#1a6dff", "#2e9d5b", "#d4880f", "#8a4fd3", "#d0455b", "#1597a5", "#6d7a99"];
  const colorOf = {}; d.layouts.forEach((l, i) => { colorOf[l.id] = colors[i % colors.length]; });
  const span = tl.to - tl.from;
  const timeline = h("div", { class: "timeline" }, tl.segments.map((s) => h("div", { style: { flex: String((s.until - s.at) / span), background: s.id ? colorOf[s.id] : "#b9c0cf" },
    title: `${fmt(new Date(s.at).toISOString())} ~ ${fmt(new Date(s.until).toISOString())}  ${s.name || "게시 없음"}`, text: s.name || "게시 없음" })));
  const ids = d.layouts.map((l) => l.id);
  const move = async (i, dir) => {
    const list = d.layouts.filter((l) => !l.isDefault).map((l) => l.id);
    const k = list.indexOf(ids[i]); const j = k + dir; if (k < 0 || j < 0 || j >= list.length) return;
    [list[k], list[j]] = [list[j], list[k]];
    await guard(() => api("POST", "/api/layouts/order", { ids: list })); pageLayouts();
  };
  const rows = d.layouts.map((l, i) => {
    const start = h("input", { type: "datetime-local", value: toLocalInput(l.start), disabled: l.isDefault });
    const end = h("input", { type: "datetime-local", value: toLocalInput(l.end), disabled: l.isDefault });
    const save = () => guard(async () => { await api("PUT", "/api/layouts/" + l.id, { start: start.value ? new Date(start.value).toISOString() : null, end: end.value ? new Date(end.value).toISOString() : null }); toast("공개 기간을 저장했습니다"); pageLayouts(); });
    start.addEventListener("change", save); end.addEventListener("change", save);
    return h("tr", {}, [
      h("td", {}, l.isDefault ? h("span", { class: "badge default", text: "1" }) : h("div", { class: "row" }, [h("span", { class: "muted", text: String(i + 1) }),
        h("button", { class: "small", text: "▲", title: "우선순위 올리기", onclick: () => move(i, -1) }), h("button", { class: "small", text: "▼", title: "우선순위 내리기", onclick: () => move(i, 1) })])),
      h("td", {}, [h("span", { style: { display: "inline-block", width: "10px", height: "10px", borderRadius: "3px", background: colorOf[l.id], marginRight: "6px" } }),
        h("a", { href: "#/layout/" + l.id, text: l.name }), d.current === l.id ? h("span", { class: "badge now", style: { marginLeft: "6px" }, text: "지금 노출" }) : null,
        h("div", { class: "muted", text: `${l.columns}컬럼 · ${l.panels}패널 · ${fmt(l.updatedAt)} ${l.updatedBy || ""}` })]),
      h("td", {}, h("span", { class: "badge " + l.status, text: STATUS[l.status] })),
      h("td", {}, l.isDefault ? h("span", { class: "muted", text: "항상(예약 배치가 없을 때)" }) : h("div", { class: "row" }, [start, "~", end])),
      h("td", {}, h("input", { type: "checkbox", checked: l.enabled, title: "사용", onchange: (e) => guard(async () => { await api("PUT", "/api/layouts/" + l.id, { enabled: e.target.checked }); pageLayouts(); }) })),
      h("td", {}, h("div", { class: "row" }, [
        l.isDefault ? null : h("button", { class: "small", text: "기본으로", onclick: () => guard(async () => { await api("POST", `/api/layouts/${l.id}/default`); pageLayouts(); }) }),
        h("button", { class: "small", text: "편집", onclick: () => { location.hash = "#/layout/" + l.id; } }),
        h("button", { class: "small", text: "복사", onclick: () => guard(async () => { await api("POST", `/api/layouts/${l.id}/duplicate`); pageLayouts(); }) }),
        h("button", { class: "small danger", text: "삭제", onclick: () => confirm(`'${l.name}' 배치를 삭제할까요?`) && guard(async () => { await api("DELETE", "/api/layouts/" + l.id); pageLayouts(); }) })]))]);
  });
  const pub = location.origin + "/portal-customizer.json";
  shell("layouts", [
    h("h1", {}, ["배치", h("button", { class: "primary small", text: "JSON 파일로 추가", onclick: importLayout })]),
    h("div", { class: "card" }, [h("div", { class: "row" }, [h("b", { text: "배포 주소" }), h("code", { text: pub }), h("button", { class: "small", id: "copyPub", text: "복사", onclick: () => copyText(pub) }),
      h("a", { href: "/portal-customizer.json", target: "_blank", text: "지금 게시본 보기" })]),
      h("div", { class: "hint", text: "직원들은 확장 팝업의 '사내 기본 배치'에 이 주소를 넣습니다. 관리자는 확장에서 관리자 로그인 후 '관리 서버로 전송'으로 배치를 올립니다." })]),
    h("div", { class: "card" }, [h("div", { class: "row" }, [h("b", { text: "앞으로 30일 노출 일정" }), h("span", { class: "muted", text: "예약 배치가 공개 기간에는 기본 배치보다 먼저 노출되고, 기간이 겹치면 목록에서 위에 있는 배치가 노출됩니다." })]), timeline]),
    h("div", { class: "card" }, d.layouts.length ? h("table", {}, [h("tr", {}, ["우선순위", "이름", "상태", "공개 기간", "사용", ""].map((t) => h("th", { text: t }))), ...rows])
      : h("div", { class: "muted", text: "아직 배치가 없습니다. 확장에서 관리자 로그인 후 '관리 서버로 전송'을 누르거나 JSON 파일로 추가하세요." }))]);
}
async function importLayout() {
  const f = await pickFile("application/json,.json"); if (!f) return;
  await guard(async () => { const j = JSON.parse(await f.text()); await api("POST", "/api/layouts", { name: j.name || f.name.replace(/\.json$/, ""), layout: j, source: "file" }); toast("추가했습니다"); pageLayouts(); });
}

// ---------- layout editor ----------
let ed = null;   // { id, meta, layout, dirty }
async function pageLayout(id) {
  const d = await api("GET", "/api/layouts/" + id);
  ed = { id, meta: d, layout: d.layout, dirty: false, tab: (ed && ed.id === id && ed.tab) || "panels" };
  drawEditor();
}
function markDirty() { ed.dirty = true; const b = document.getElementById("saveBtn"); if (b) b.disabled = false; drawSchematic(); }
function drawEditor() {
  const name = h("input", { type: "text", value: ed.meta.name, style: { width: "280px" }, oninput: (e) => { ed.meta.name = e.target.value; markDirty(); } });
  const note = h("input", { type: "text", value: ed.meta.note || "", placeholder: "메모", style: { width: "280px" }, oninput: (e) => { ed.meta.note = e.target.value; markDirty(); } });
  const tabs = h("div", { class: "tabs" }, [["panels", "패널 설정"], ["json", "JSON"], ["history", "변경 이력"]].map(([k, t]) => h("a", { href: "#", class: ed.tab === k ? "on" : "", text: t, onclick: (e) => { e.preventDefault(); ed.tab = k; drawEditor(); } })));
  const body = ed.tab === "json" ? editorJson() : ed.tab === "history" ? h("div", { id: "hist" }) : editorPanels();
  shell("layouts", [
    h("h1", {}, [h("a", { href: "#/layouts", text: "배치" }), "›", name, h("span", { class: "badge " + ed.meta.status, text: STATUS[ed.meta.status] }),
      h("span", { class: "grow" }), h("button", { id: "saveBtn", class: "primary", text: "저장", disabled: !ed.dirty, onclick: saveLayout })]),
    h("div", { class: "card" }, [h("div", { class: "row" }, [note, h("span", { class: "muted", text: `수정 ${fmt(ed.meta.updatedAt)} ${ed.meta.updatedBy || ""}` }),
      h("span", { class: "muted", id: "unitInfo", text: ed.layout.site ? `위젯 단위: 확장에서 지정(영역 아래 ${ed.layout.site.level}단계)` : "위젯 단위: 자동 감지" })]), h("div", { id: "schematic", style: { marginTop: "10px" } })]),
    tabs, body]);
  drawSchematic();
  if (ed.tab === "history") drawHistory();
}
function drawSchematic() {
  const box = document.getElementById("schematic"); if (!box) return;
  const cols = ed.layout.columns || [];
  box.replaceChildren(h("div", { class: "schematic" }, cols.map((c) => h("div", { class: "c", style: { flex: c.flex ? "1 1 0" : `0 0 ${Math.max(18, (c.width || 380) / 8)}px` } },
    (c.panels || []).map((p) => h("div", { class: "p", style: { flex: p.height ? `0 0 ${Math.max(10, p.height / 8)}px` : "1 1 0", opacity: p.hidden ? ".4" : "1" }, text: p.title || TYPES[p.type] || p.type, title: `${TYPES[p.type] || p.type}${p.height ? " · " + p.height + "px" : ""}` }))))));
}
async function saveLayout() {
  await guard(async () => { await api("PUT", "/api/layouts/" + ed.id, { name: ed.meta.name, note: ed.meta.note, layout: ed.layout }); toast("저장했습니다"); await pageLayout(ed.id); });
}
function editorJson() {
  const ta = h("textarea", { style: { minHeight: "60vh", fontFamily: "monospace", fontSize: "12px" }, value: JSON.stringify(ed.layout, null, 2) });
  return h("div", { class: "card" }, [ta, h("div", { class: "row", style: { marginTop: "8px" } }, [h("button", { text: "JSON 적용", onclick: () => { try { const j = JSON.parse(ta.value); if (!Array.isArray(j.columns)) throw new Error("columns 가 없습니다"); ed.layout = j; markDirty(); toast("적용했습니다. 저장을 누르세요"); } catch (e) { toast("JSON 오류: " + e.message); } } }),
    h("button", { text: "내려받기", onclick: () => { const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(Object.assign({ name: ed.meta.name }, ed.layout), null, 2)], { type: "application/json" })), download: (ed.meta.name || "layout") + ".json" }); a.click(); } })])]);
}
async function drawHistory() {
  const r = await api("GET", `/api/layouts/${ed.id}/revisions`);
  document.getElementById("hist").replaceChildren(h("div", { class: "card" }, r.revisions.length ? h("table", {}, [h("tr", {}, ["저장 시각", "저장한 사람", "이름", ""].map((t) => h("th", { text: t }))),
    ...r.revisions.map((v) => h("tr", {}, [h("td", { text: fmt(v.at) }), h("td", { text: v.by }), h("td", { text: v.name }),
      h("td", {}, h("button", { class: "small", text: "이 상태로 되돌리기", onclick: () => confirm("이 이력으로 되돌릴까요? 지금 상태는 이력에 남습니다.") && guard(async () => { await api("POST", `/api/layouts/${ed.id}/restore`, { index: v.index }); toast("되돌렸습니다"); pageLayout(ed.id); }) }))]))])
    : h("div", { class: "muted", text: "아직 변경 이력이 없습니다." })));
}
function editorPanels() {
  const L = ed.layout;
  L.gaps = L.gaps || {};
  const gp = h("input", { type: "number", min: 0, max: 200, value: L.gaps.panel ?? "", placeholder: "25", style: { width: "80px" }, oninput: (e) => { if (e.target.value === "") delete L.gaps.panel; else L.gaps.panel = Number(e.target.value); markDirty(); } });
  const gc = h("input", { type: "number", min: 0, max: 200, step: 0.5, value: L.gaps.col ?? "", placeholder: "12.5", style: { width: "80px" }, oninput: (e) => { if (e.target.value === "") delete L.gaps.col; else L.gaps.col = Number(e.target.value); markDirty(); } });
  return h("div", {}, [
    h("div", { class: "card row" }, [h("b", { text: "기본 간격" }), "패널 사이", gp, "px · 컬럼 사이", gc, "px", h("span", { class: "grow" }),
      h("button", { text: "+ 컬럼", onclick: () => { L.columns.push({ id: "c" + Math.random().toString(36).slice(2, 8), width: 320, panels: [] }); markDirty(); drawEditor(); } })]),
    h("div", { class: "cols" }, L.columns.map((c, ci) => columnCard(c, ci)))]);
}
function columnCard(c, ci) {
  const L = ed.layout;
  const width = h("input", { type: "number", min: 120, max: 3000, value: c.flex ? "" : c.width, placeholder: "채움", style: { width: "80px" }, disabled: !!c.flex,
    oninput: (e) => { c.width = Number(e.target.value) || 380; markDirty(); } });
  const fill = h("input", { type: "checkbox", checked: !!c.flex, onchange: (e) => { if (e.target.checked) { c.flex = 1; c.width = null; } else { c.flex = null; c.width = 380; } markDirty(); drawEditor(); } });
  const gap = h("input", { type: "number", min: 0, max: 200, value: c.gap ?? "", placeholder: "기본", style: { width: "64px" }, oninput: (e) => { if (e.target.value === "") delete c.gap; else c.gap = Number(e.target.value); markDirty(); } });
  const add = h("select", { onchange: (e) => { if (!e.target.value) return; c.panels.push(newPanel(e.target.value)); markDirty(); drawEditor(); } },
    [h("option", { value: "", text: "+ 패널 추가" }), ...Object.entries(TYPES).filter(([k]) => k !== "native").map(([k, t]) => h("option", { value: k, text: t }))]);
  return h("div", { class: "col-card" }, [
    h("div", { class: "row" }, [h("b", { text: `컬럼 ${ci + 1}` }), h("span", { class: "grow" }),
      h("button", { class: "small", text: "◀", disabled: ci === 0, onclick: () => { L.columns.splice(ci - 1, 0, L.columns.splice(ci, 1)[0]); markDirty(); drawEditor(); } }),
      h("button", { class: "small", text: "▶", disabled: ci === L.columns.length - 1, onclick: () => { L.columns.splice(ci + 1, 0, L.columns.splice(ci, 1)[0]); markDirty(); drawEditor(); } }),
      h("button", { class: "small danger", text: "삭제", disabled: L.columns.length <= 1, onclick: () => { if (!c.panels.length || confirm("컬럼과 패널을 삭제할까요?")) { L.columns.splice(ci, 1); markDirty(); drawEditor(); } } })]),
    h("div", { class: "row", style: { marginTop: "6px" } }, ["폭", width, "px", h("label", { class: "row" }, [fill, "남은 폭 채움"]), "왼쪽 간격", gap]),
    ...c.panels.map((p, pi) => panelCard(c, ci, p, pi)), add]);
}
function newPanel(type) {
  const id = "p" + Math.random().toString(36).slice(2, 9);
  const base = { id, type, title: TYPES[type], height: 200 };
  if (type === "image") Object.assign(base, { title: "", src: "", href: "", fit: "cover", height: 180 });
  if (type === "video") Object.assign(base, { src: "", poster: "", autoplay: true, muted: true, loop: true, controls: false, height: 240 });
  if (type === "html") Object.assign(base, { html: "" });
  if (type === "memo") Object.assign(base, { text: "" });
  if (type === "links") Object.assign(base, { items: [], newTab: true, display: "list", height: null });
  if (type === "iframe") Object.assign(base, { url: "", refresh: 0, zoom: 100, height: 320 });
  if (type === "carousel") Object.assign(base, { slides: [], interval: 5, fit: "cover", captions: true, height: 240 });
  if (type === "feed") Object.assign(base, { tabs: [], view: "card", all: true, layer: true, refresh: 10, limit: 30, height: 420 });
  return base;
}
function fieldText(p, key, label, opts) {
  const o = opts || {};
  const i = h(o.textarea ? "textarea" : "input", { type: o.type || "text", value: p[key] ?? "", placeholder: o.placeholder || "", oninput: (e) => { p[key] = o.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value; markDirty(); } });
  return h("div", { class: "field" }, [h("label", { text: label }), i]);
}
function fieldCheck(p, key, label, def) {
  return h("label", { class: "row" }, [h("input", { type: "checkbox", checked: p[key] ?? def, onchange: (e) => { p[key] = e.target.checked; markDirty(); } }), label]);
}
// URL field with upload and CMS pick
function mediaField(obj, key, label, kind, onPick) {
  const input = h("input", { type: "url", value: obj[key] || "", placeholder: "https://", oninput: (e) => { obj[key] = e.target.value; markDirty(); preview(); } });
  const thumb = h("div");
  const preview = () => { thumb.replaceChildren(obj[key] ? (kind === "video" ? h("video", { class: "thumb", src: obj[key], muted: true }) : kind === "image" ? h("img", { class: "thumb", src: obj[key] }) : "") : ""); };
  preview();
  const set = (v) => { obj[key] = v; input.value = v; markDirty(); preview(); };
  return h("div", { class: "field" }, [h("label", { text: label }), h("div", { class: "media-input" }, [input,
    h("button", { class: "small", text: "업로드", onclick: async () => { const f = await pickFile(kind === "video" ? "video/*" : kind === "image" ? "image/*" : ""); if (f) await guard(async () => set((await upload(f)).url)); } }),
    h("button", { class: "small", text: "CMS", onclick: () => pickContent(kind, (c) => { set(c.url || c.link || ""); if (onPick) onPick(c); }) })]), thumb]);
}
function rowsField(list, fields, label, opts) {
  const box = h("div", { class: "rows" });
  const draw = () => box.replaceChildren(...list.map((r, i) => h("div", { class: "r" }, [
    ...fields.map(([k, ph]) => h("input", { type: "text", placeholder: ph, value: r[k] || "", oninput: (e) => { r[k] = e.target.value; markDirty(); } })),
    opts && opts.media ? h("button", { class: "small", text: "CMS", onclick: () => pickContent(opts.media, (c) => { r[opts.mediaKey] = c.url || c.link; if (!r.title) r.title = c.title; if (opts.linkKey && c.link && c.type !== "link") r[opts.linkKey] = c.link; markDirty(); draw(); }) }) : null,
    opts && opts.media ? h("button", { class: "small", text: "업로드", onclick: async () => { const f = await pickFile(opts.media === "video" ? "video/*" : "image/*"); if (f) await guard(async () => { r[opts.mediaKey] = (await upload(f)).url; markDirty(); draw(); }); } }) : null,
    h("button", { class: "small", text: "↑", disabled: i === 0, onclick: () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); markDirty(); draw(); } }),
    h("button", { class: "small danger", text: "✕", onclick: () => { list.splice(i, 1); markDirty(); draw(); } })])),
    h("button", { class: "small", text: "+ 추가", onclick: () => { list.push(opts && opts.blank ? opts.blank() : {}); markDirty(); draw(); } }));
  draw();
  return h("div", { class: "field" }, [h("label", { text: label }), box]);
}
function panelCard(c, ci, p, pi) {
  const L = ed.layout;
  const open = ed.open === p.id;
  const moveTo = h("select", { title: "다른 컬럼으로", onchange: (e) => { const t = Number(e.target.value); if (Number.isNaN(t)) return; L.columns[t].panels.push(c.panels.splice(pi, 1)[0]); markDirty(); drawEditor(); } },
    [h("option", { value: "", text: "→" }), ...L.columns.map((_x, i) => i === ci ? null : h("option", { value: String(i), text: `컬럼 ${i + 1}` })).filter(Boolean)]);
  const body = open ? panelBody(p) : null;
  return h("div", { class: "panel-card" + (p.hidden ? " hidden-panel" : "") }, [
    h("div", { class: "head" }, [h("span", { class: "badge", text: TYPES[p.type] || p.type }), h("span", { class: "title", text: p.title || (p.type === "native" ? p.key : "") }),
      h("button", { class: "small", text: "▲", disabled: pi === 0, onclick: () => { c.panels.splice(pi - 1, 0, c.panels.splice(pi, 1)[0]); markDirty(); drawEditor(); } }),
      h("button", { class: "small", text: "▼", disabled: pi === c.panels.length - 1, onclick: () => { c.panels.splice(pi + 1, 0, c.panels.splice(pi, 1)[0]); markDirty(); drawEditor(); } }),
      moveTo,
      h("button", { class: "small", text: open ? "접기" : "설정", onclick: () => { ed.open = open ? null : p.id; drawEditor(); } }),
      h("button", { class: "small danger", text: "✕", onclick: () => { c.panels.splice(pi, 1); markDirty(); drawEditor(); } })]),
    body]);
}
function panelBody(p) {
  const common = [fieldText(p, "title", "제목"), fieldCheck(p, "header", "제목 표시", true),
    h("div", { class: "row" }, [fieldText(p, "height", "높이(px, 비우면 자동)", { type: "number" }), fieldText(p, "gap", "위쪽 간격(px, 비우면 기본)", { type: "number" })]),
    fieldCheck(p, "hidden", "숨김", false)];
  let own = [];
  if (p.type === "native") own = [h("div", { class: "hint", text: "화면에 원래 있던 위젯입니다(내용은 원래 화면이 그립니다). 식별키: " + p.key })];
  if (p.type === "image") own = [mediaField(p, "src", "이미지", "image", (ct) => { if (ct.link && !p.href) p.href = ct.link; }), fieldText(p, "href", "클릭하면 열 주소"),
    h("div", { class: "field" }, [h("label", { text: "맞춤" }), h("select", { onchange: (e) => { p.fit = e.target.value; markDirty(); } }, [h("option", { value: "cover", text: "채우기", selected: p.fit !== "contain" }), h("option", { value: "contain", text: "전체 보이기", selected: p.fit === "contain" })])])];
  if (p.type === "video") own = [mediaField(p, "src", "동영상(mp4·webm)", "video", (ct) => { if (ct.poster) p.poster = ct.poster; }), mediaField(p, "poster", "미리보기 이미지(선택)", "image"),
    h("div", { class: "row" }, [fieldCheck(p, "autoplay", "자동 재생", true), fieldCheck(p, "muted", "음소거", true), fieldCheck(p, "loop", "반복", true), fieldCheck(p, "controls", "재생 버튼 표시", false)]), fieldText(p, "href", "클릭하면 열 주소(선택)")];
  if (p.type === "html") own = [fieldText(p, "html", "하이퍼텍스트(HTML, 스크립트·스타일 태그는 제거됨)", { textarea: true }),
    h("button", { class: "small", text: "CMS 에서 가져오기", onclick: () => pickContent("html,text", (ct) => { p.html = ct.type === "text" ? esc(ct.text).replace(/\n/g, "<br>") : ct.html; markDirty(); drawEditor(); }) })];
  if (p.type === "memo") own = [fieldText(p, "text", "기본 내용", { textarea: true })];
  if (p.type === "iframe") own = [fieldText(p, "url", "페이지 주소"), h("div", { class: "row" }, [fieldText(p, "refresh", "자동 새로고침(분)", { type: "number" }), fieldText(p, "zoom", "확대/축소(%)", { type: "number" })]), fieldCheck(p, "scroll", "안에서 스크롤", true)];
  if (p.type === "links") { p.items = p.items || []; own = [rowsField(p.items, [["title", "제목"], ["url", "https://주소"], ["img", "배너 이미지(선택)"]], "링크", { media: "image", mediaKey: "img", linkKey: "url" }),
    h("div", { class: "field" }, [h("label", { text: "표시" }), h("select", { onchange: (e) => { p.display = e.target.value; markDirty(); } }, [h("option", { value: "list", text: "목록", selected: p.display !== "grid" }), h("option", { value: "grid", text: "배너 타일", selected: p.display === "grid" })])]), fieldCheck(p, "newTab", "새 탭에서 열기", true)]; }
  if (p.type === "carousel") { p.slides = p.slides || []; own = [rowsField(p.slides, [["title", "제목"], ["href", "링크(선택)"], ["src", "이미지 주소"]], "슬라이드", { media: "image", mediaKey: "src", linkKey: "href", blank: () => ({ title: "", href: "", src: "" }) }),
    fieldText(p, "interval", "자동 넘김(초, 0 = 안 함)", { type: "number" }), fieldCheck(p, "captions", "제목 표시", true), fieldCheck(p, "layer", "링크를 레이어 창으로", false)]; }
  if (p.type === "feed") { p.tabs = p.tabs || []; own = [rowsField(p.tabs, [["title", "탭 이름"], ["src", "게시판 주소"], ["site", "사이트 바로가기"], ["write", "글쓰기 주소"]], "탭", { blank: () => ({ id: "t" + Math.random().toString(36).slice(2, 8), title: "", src: "", site: "", write: "" }) }),
    h("div", { class: "row" }, [h("div", { class: "field" }, [h("label", { text: "보기" }), h("select", { onchange: (e) => { p.view = e.target.value; markDirty(); } }, [h("option", { value: "card", text: "카드형", selected: p.view !== "list" }), h("option", { value: "list", text: "리스트형", selected: p.view === "list" })])]),
      fieldText(p, "limit", "탭당 게시글 수", { type: "number" }), fieldText(p, "refresh", "자동 새로고침(분)", { type: "number" })]),
    fieldCheck(p, "all", "ALL 탭", true), fieldCheck(p, "layer", "레이어 창으로 열기", true)]; }
  return h("div", { class: "body" }, [...common, ...own]);
}
function esc(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

// ---------- CMS ----------
async function pickContent(kinds, onPick) {
  const types = String(kinds || "").split(",").filter(Boolean);
  const [g, cs] = await Promise.all([api("GET", "/api/groups"), api("GET", "/api/contents")]);
  const list = cs.contents.filter((c) => !types.length || types.includes(c.type) || (types.includes("image") && c.type === "link" && false));
  const grid = h("div", { class: "grid" });
  const sel = h("select", {}, [h("option", { value: "", text: "모든 그룹" }), ...g.groups.map((x) => h("option", { value: x.id, text: x.name }))]);
  const q = h("input", { type: "search", placeholder: "검색" });
  let m;
  const draw = () => grid.replaceChildren(...list.filter((c) => (!sel.value || c.groupId === sel.value) && (!q.value || (c.title + " " + (c.tags || "")).toLowerCase().includes(q.value.toLowerCase())))
    .map((c) => contentCard(c, () => { onPick(c); m.close(); }, true)));
  sel.addEventListener("change", draw); q.addEventListener("input", draw); draw();
  m = modal("CMS 콘텐츠 선택", h("div", {}, [h("div", { class: "row", style: { marginBottom: "10px" } }, [sel, q]), list.length ? grid : h("div", { class: "muted", text: "선택할 콘텐츠가 없습니다. 콘텐츠(CMS) 메뉴에서 먼저 등록하세요." })]));
}
function contentCard(c, onclick, pick) {
  const pv = c.type === "image" ? h("img", { src: c.url, alt: "" }) : c.type === "video" ? h("video", { src: c.url, muted: true, poster: c.poster || null }) : c.type === "html" ? h("div", { text: c.html.replace(/<[^>]+>/g, " ").slice(0, 120) }) : h("div", { text: (c.text || c.link || "").slice(0, 120) });
  return h("div", { class: "content-card" + (pick ? " pick" : ""), onclick }, [h("div", { class: "preview" }, pv), h("div", { class: "info" }, [h("span", { class: "badge", text: CTYPES[c.type] }), " ", h("b", { text: c.title || "(제목 없음)" }), c.tags ? h("div", { class: "muted", text: c.tags }) : null])]);
}
async function pageContents(groupId) {
  const [g, cs] = await Promise.all([api("GET", "/api/groups"), api("GET", "/api/contents" + (groupId ? "?group=" + groupId : ""))]);
  const groups = h("div", { class: "groups" }, [h("a", { href: "#/contents", class: !groupId ? "on" : "", text: `전체 (${g.groups.reduce((n, x) => n + x.count, 0) + 0})` }),
    ...g.groups.map((x) => h("a", { href: "#/contents/" + x.id, class: groupId === x.id ? "on" : "", text: `${x.name} (${x.count})` })), h("a", { href: "#/contents/none", class: groupId === "none" ? "on" : "", text: "그룹 없음" })]);
  const cur = g.groups.find((x) => x.id === groupId);
  shell("contents", [
    h("h1", {}, ["콘텐츠(CMS)", h("button", { class: "primary small", text: "+ 콘텐츠", onclick: () => editContent(null, g.groups, groupId) }),
      h("button", { class: "small", text: "+ 그룹", onclick: async () => { const n = prompt("그룹 이름"); if (n) await guard(async () => { const r = await api("POST", "/api/groups", { name: n }); location.hash = "#/contents/" + r.group.id; }); } }),
      cur ? h("button", { class: "small", text: "그룹 이름 변경", onclick: async () => { const n = prompt("그룹 이름", cur.name); if (n) await guard(async () => { await api("PUT", "/api/groups/" + cur.id, { name: n }); pageContents(groupId); }); } }) : null,
      cur ? h("button", { class: "small danger", text: "그룹 삭제", onclick: () => confirm("그룹을 삭제할까요? 콘텐츠는 '그룹 없음'으로 옮겨집니다.") && guard(async () => { await api("DELETE", "/api/groups/" + cur.id); location.hash = "#/contents"; }) }) : null]),
    h("div", { class: "row", style: { alignItems: "flex-start" } }, [h("div", { class: "card", style: { width: "200px", flex: "0 0 auto" } }, groups),
      h("div", { class: "grow" }, cs.contents.length ? h("div", { class: "grid" }, cs.contents.map((c) => contentCard(c, () => editContent(c, g.groups, groupId)))) : h("div", { class: "card muted", text: "콘텐츠가 없습니다." }))])]);
}
function editContent(c, groups, groupId) {
  const d = c ? Object.assign({}, c) : { type: "image", groupId: groupId && groupId !== "none" ? groupId : null, title: "" };
  const box = h("div");
  const draw = () => {
    const rows = [
      h("div", { class: "row" }, [h("div", { class: "field" }, [h("label", { text: "종류" }), h("select", { disabled: !!c, onchange: (e) => { d.type = e.target.value; draw(); } }, Object.entries(CTYPES).map(([k, t]) => h("option", { value: k, text: t, selected: d.type === k })))]),
        h("div", { class: "field" }, [h("label", { text: "그룹" }), h("select", { onchange: (e) => { d.groupId = e.target.value || null; } }, [h("option", { value: "", text: "그룹 없음" }), ...groups.map((x) => h("option", { value: x.id, text: x.name, selected: d.groupId === x.id }))])])]),
      h("div", { class: "field" }, [h("label", { text: "제목" }), h("input", { type: "text", value: d.title || "", oninput: (e) => { d.title = e.target.value; } })]),
    ];
    if (d.type === "image" || d.type === "video") { rows.push(mediaFieldPlain(d, "url", d.type === "video" ? "동영상 파일" : "이미지 파일", d.type)); if (d.type === "video") rows.push(mediaFieldPlain(d, "poster", "미리보기 이미지(선택)", "image")); }
    if (d.type === "text") rows.push(h("div", { class: "field" }, [h("label", { text: "텍스트" }), h("textarea", { value: d.text || "", oninput: (e) => { d.text = e.target.value; } })]));
    if (d.type === "html") rows.push(h("div", { class: "field" }, [h("label", { text: "하이퍼텍스트(HTML)" }), h("textarea", { style: { minHeight: "200px", fontFamily: "monospace" }, value: d.html || "", oninput: (e) => { d.html = e.target.value; } })]));
    rows.push(h("div", { class: "field" }, [h("label", { text: d.type === "link" ? "링크 주소" : "클릭하면 열 주소(선택)" }), h("input", { type: "url", value: d.link || "", oninput: (e) => { d.link = e.target.value; } })]));
    rows.push(h("div", { class: "field" }, [h("label", { text: "태그(검색용, 쉼표로 구분)" }), h("input", { type: "text", value: d.tags || "", oninput: (e) => { d.tags = e.target.value; } })]));
    box.replaceChildren(...rows);
  };
  draw();
  const acts = [{ text: "저장", cls: "primary", run: () => guard(async () => { if (c) await api("PUT", "/api/contents/" + c.id, d); else await api("POST", "/api/contents", d); toast("저장했습니다"); pageContents(groupId); }) }];
  if (c) acts.push({ text: "삭제", cls: "danger", run: () => confirm("삭제할까요?") && guard(async () => { await api("DELETE", "/api/contents/" + c.id); pageContents(groupId); }) });
  modal(c ? "콘텐츠 수정" : "콘텐츠 등록", box, acts);
}
function mediaFieldPlain(obj, key, label, kind) {
  const input = h("input", { type: "url", value: obj[key] || "", placeholder: "업로드하거나 주소 입력", oninput: (e) => { obj[key] = e.target.value; pv(); } });
  const thumb = h("div");
  const pv = () => thumb.replaceChildren(obj[key] ? (kind === "video" ? h("video", { class: "thumb", src: obj[key], controls: true }) : h("img", { class: "thumb", src: obj[key] })) : "");
  pv();
  return h("div", { class: "field" }, [h("label", { text: label }), h("div", { class: "media-input" }, [input, h("button", { class: "small", text: "파일 업로드", onclick: async () => {
    const f = await pickFile(kind === "video" ? "video/*" : "image/*"); if (!f) return;
    await guard(async () => { const r = await upload(f); obj[key] = r.url; input.value = r.url; if (!obj.title) obj.title = f.name.replace(/\.[^.]+$/, ""); pv(); toast(`${size(r.size)} 업로드`); });
  } })]), thumb]);
}

// ---------- stats ----------
async function pageStats() {
  const d = await api("GET", "/api/stats?days=30");
  const max = Math.max(1, ...d.days.map((x) => x.users));
  const maxR = Math.max(1, ...d.days.map((x) => x.req));
  const sum = d.days.reduce((n, x) => n + x.req, 0);
  const table = (obj, head) => h("table", {}, [h("tr", {}, head.map((t) => h("th", { text: t }))), ...Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => h("tr", {}, [h("td", { text: k }), h("td", { text: String(v) })]))]);
  shell("stats", [h("h1", { text: "통계 (최근 30일)" }),
    h("div", { class: "row" }, [h("div", { class: "card grow" }, [h("div", { class: "muted", text: "사용자(확장 설치 수)" }), h("div", { style: { fontSize: "28px", fontWeight: 700 }, text: String(d.users) })]),
      h("div", { class: "card grow" }, [h("div", { class: "muted", text: "배치 요청 수" }), h("div", { style: { fontSize: "28px", fontWeight: 700 }, text: String(sum) })]),
      h("div", { class: "card grow" }, [h("div", { class: "muted", text: "오늘 사용자" }), h("div", { style: { fontSize: "28px", fontWeight: 700 }, text: String(d.days[d.days.length - 1].users) })])]),
    h("div", { class: "card" }, [h("b", { text: "일별 사용자" }), h("div", { class: "bars" }, d.days.map((x) => h("div", { style: { height: (x.users / max) * 100 + "%" }, "data-tip": `${x.day} 사용자 ${x.users} · 요청 ${x.req}` })))]),
    h("div", { class: "card" }, [h("b", { text: "일별 요청" }), h("div", { class: "bars" }, d.days.map((x) => h("div", { style: { height: (x.req / maxR) * 100 + "%", background: "#2e9d5b" }, "data-tip": `${x.day} 요청 ${x.req}` })))]),
    h("div", { class: "row", style: { alignItems: "flex-start" } }, [h("div", { class: "card grow" }, [h("b", { text: "노출된 배치" }), table(d.served, ["배치", "요청"])]),
      h("div", { class: "card grow" }, [h("b", { text: "확장 버전" }), table(d.versions, ["버전", "요청"])])]),
    h("div", { class: "hint", text: "사용자 수는 확장이 처음 설치될 때 만든 임의 식별값으로 셉니다(개인 정보 없음)." })]);
}

// ---------- admins & audit ----------
async function pageAdmins() {
  const [a, au] = await Promise.all([api("GET", "/api/admins"), api("GET", "/api/audit?limit=300")]);
  const user = h("input", { type: "text", placeholder: "아이디" }), name = h("input", { type: "text", placeholder: "이름" }), pw = h("input", { type: "password", placeholder: "비밀번호(8자 이상)" });
  const role = h("select", {}, [h("option", { value: "admin", text: "관리자" }), h("option", { value: "editor", text: "편집자(배치·콘텐츠만)" })]);
  shell("admins", [h("h1", { text: "관리자" }),
    h("div", { class: "card" }, [h("table", {}, [h("tr", {}, ["아이디", "이름", "권한", "마지막 로그인", ""].map((t) => h("th", { text: t }))),
      ...a.admins.map((x) => h("tr", {}, [h("td", { text: x.user + (x.disabled ? " (중지)" : "") }), h("td", { text: x.name }), h("td", { text: x.role === "admin" ? "관리자" : "편집자" }), h("td", { text: fmt(x.lastLogin) }),
        h("td", {}, h("div", { class: "row" }, [
          h("button", { class: "small", text: "비밀번호 재설정", onclick: async () => { const p = prompt(`${x.user} 의 새 비밀번호(8자 이상)`); if (p) await guard(async () => { await api("PUT", "/api/admins/" + x.id, { password: p }); toast("재설정했습니다"); }); } }),
          h("button", { class: "small", text: x.role === "admin" ? "편집자로" : "관리자로", onclick: () => guard(async () => { await api("PUT", "/api/admins/" + x.id, { role: x.role === "admin" ? "editor" : "admin" }); pageAdmins(); }) }),
          h("button", { class: "small", text: x.disabled ? "사용" : "중지", onclick: () => guard(async () => { await api("PUT", "/api/admins/" + x.id, { disabled: !x.disabled }); pageAdmins(); }) }),
          x.id === me.id ? null : h("button", { class: "small danger", text: "삭제", onclick: () => confirm(`${x.user} 를 삭제할까요?`) && guard(async () => { await api("DELETE", "/api/admins/" + x.id); pageAdmins(); }) })]))]))]),
      h("div", { class: "row", style: { marginTop: "10px" } }, [user, name, pw, role, h("button", { class: "primary", text: "추가", onclick: () => guard(async () => { await api("POST", "/api/admins", { user: user.value, name: name.value, password: pw.value, role: role.value }); pageAdmins(); }) })])]),
    h("h2", { text: "감사 로그" }),
    h("div", { class: "card" }, h("table", {}, [h("tr", {}, ["시각", "사람", "작업", "대상", "비고"].map((t) => h("th", { text: t }))), ...au.audit.map((x) => h("tr", {}, [h("td", { text: fmt(x.at) }), h("td", { text: x.by }), h("td", { text: x.action }), h("td", { text: x.target }), h("td", { class: "muted", text: x.detail })]))]))]);
}

// ---------- settings & update ----------
async function pageSettings() {
  const [s, u, m] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/update"), api("GET", "/api/media")]);
  const st = s.settings; const isAdmin = me.role === "admin";
  const pub = h("input", { type: "url", value: st.publicUrl || "", placeholder: location.origin, style: { width: "320px" } });
  const site = h("input", { type: "text", value: st.siteName || "" });
  const auto = h("input", { type: "checkbox", checked: st.autoUpdate !== false });
  const mins = h("input", { type: "number", min: 1, max: 10080, value: st.checkMinutes || (st.checkHours ? st.checkHours * 60 : 1), style: { width: "80px" } });
  const refresh = h("input", { type: "number", min: 1, max: 1440, value: st.refreshMinutes || 5, style: { width: "80px" } });
  const match = h("textarea", { rows: 3, style: { width: "100%" }, placeholder: "https://portal.example.com/home" }); match.value = (st.siteMatch || []).join("\n");
  const status = u.status;
  const unused = m.files.filter((f) => !f.used);
  shell("settings", [h("h1", { text: "설정·업데이트" }),
    h("div", { class: "card" }, [h("h2", { style: { marginTop: 0 }, text: "서버" }),
      h("div", { class: "field" }, [h("label", { text: "서버 주소(업로드 파일 주소에 쓰임, 비우면 접속 주소 사용)" }), pub]),
      h("div", { class: "field" }, [h("label", { text: "이름(관리 화면 왼쪽 위 제목·로그인 화면·브라우저 탭에 표시)" }), site]),
      h("div", { class: "row" }, [h("label", { class: "row" }, [auto, "새 버전 자동 업데이트"]), "확인 주기", mins, "분"]),
      h("div", { class: "row", style: { marginTop: "8px" } }, ["직원 확장이 배치를 다시 확인하는 주기", refresh, "분", h("span", { class: "muted", text: "portal-customizer.json 에 함께 배포됩니다. 짧을수록 빨리 반영되지만 요청이 늘어납니다." })]),
      h("button", { class: "primary", disabled: !isAdmin, style: { marginTop: "8px" }, text: "저장", onclick: () => guard(async () => { await api("PUT", "/api/settings", { publicUrl: pub.value, siteName: site.value, autoUpdate: auto.checked, checkMinutes: Number(mins.value), refreshMinutes: Number(refresh.value) }); setSiteName(site.value); toast("저장했습니다"); pageSettings(); }) })]),
    h("div", { class: "card" }, [h("h2", { style: { marginTop: 0 }, text: "적용할 화면" }),
      h("div", { class: "field" }, [h("label", { text: "배치를 적용할 화면 주소(한 줄에 하나, 이 주소로 시작하는 화면에 적용, * 는 아무 글자)" }), match]),
      h("p", { class: "muted", text: "위젯은 확장이 자동으로 찾고, 관리자가 편집 모드의 ▣ 위젯 단위 에서 확인·조정합니다. 정한 위젯 단위는 배치와 함께 이 서버로 전송되어 직원에게 배포됩니다." }),
      h("button", { class: "primary", disabled: !isAdmin, style: { marginTop: "8px" }, text: "저장", onclick: () => guard(async () => {
        await api("PUT", "/api/settings", { siteMatch: match.value }); toast("저장했습니다"); pageSettings(); }) })]),
    h("div", { class: "card" }, [h("h2", { style: { marginTop: 0 }, text: "업데이트" }),
      h("div", { class: "row" }, [h("span", { text: `현재 v${u.current}` }), u.check ? h("span", { class: "muted", text: u.check.ok ? `최신 v${u.check.latest || "-"} (확인 ${fmt(u.check.at)})` : "확인 실패: " + u.check.error }) : null]),
      h("div", { class: "row", style: { marginTop: "8px" } }, [
        h("button", { disabled: !isAdmin, text: "새 버전 확인", onclick: () => guard(async () => { const r = await api("POST", "/api/update/check"); toast(r.ok ? (r.newer ? `v${r.latest} 이 있습니다` : "최신 버전입니다") : "확인 실패: " + r.error); pageSettings(); }) }),
        u.check && u.check.newer ? h("button", { class: "primary", disabled: !isAdmin, text: `v${u.check.latest} 로 업데이트`, onclick: () => confirm("업데이트하는 동안 잠시 서버가 재시작됩니다. 진행할까요?") && guard(async () => { await api("POST", "/api/update/apply", {}); toast("업데이트를 시작했습니다"); waitUpdate(); }) }) : null,
        h("button", { disabled: !isAdmin, text: "업데이트 패키지 올리기", onclick: async () => { const f = await pickFile(".gz,.tgz,application/gzip"); if (f) await guard(async () => { toast("패키지를 확인하는 중입니다"); await api("PUT", "/api/update/package", f, "application/gzip"); toast("업데이트를 시작했습니다"); waitUpdate(); }); } })]),
      h("div", { class: "hint", text: "인터넷이 안 되면 GitHub 릴리스의 portal-customizer-server-update-버전.tar.gz 를 받아 '업데이트 패키지 올리기'로 설치합니다." }),
      status ? h("pre", { class: "log", text: `${fmt(status.at)}  ${status.phase}  v${status.from} → v${status.to}${status.reason ? "\n" + status.reason : ""}` }) : null]),
    h("div", { class: "card" }, [h("h2", { style: { marginTop: 0 }, text: "백업·복원" }),
      h("div", { class: "row" }, [h("a", { href: isAdmin ? "/api/backup" : null }, h("button", { disabled: !isAdmin, text: "백업 내려받기(배치·콘텐츠·파일)" })),
        h("button", { disabled: !isAdmin, text: "백업에서 복원", onclick: async () => { const f = await pickFile(".gz,.tgz"); if (f && confirm("지금 데이터를 백업 파일 내용으로 바꿀까요?")) await guard(async () => { await api("PUT", "/api/backup", f, "application/gzip"); toast("복원했습니다"); boot(); }); } })])]),
    h("div", { class: "card" }, [h("h2", { style: { marginTop: 0 }, text: "업로드 파일" }),
      h("div", { class: "muted", text: `${m.files.length}개 · ${size(m.files.reduce((n, f) => n + f.size, 0))} · 사용하지 않는 파일 ${unused.length}개(${size(unused.reduce((n, f) => n + f.size, 0))})` }),
      unused.length ? h("button", { class: "small", style: { marginTop: "6px" }, text: "사용하지 않는 파일 지우기", onclick: () => confirm("배치·콘텐츠 어디에도 쓰이지 않는 파일을 지울까요?") && guard(async () => { for (const f of unused) await api("DELETE", "/api/media/" + f.file); pageSettings(); }) }) : null])]);
}
function waitUpdate() {
  const t0 = Date.now();
  const tick = async () => {
    try { const r = await fetch("/api/update"); if (r.ok) { const d = await r.json(); if (d.status && ["done", "failed"].includes(d.status.phase) && Date.now() - t0 > 3000) { toast(d.status.phase === "done" ? `v${d.status.to} 로 업데이트했습니다` : "업데이트 실패: " + d.status.reason); return pageSettings(); } } } catch (_e) { /* restarting */ }
    if (Date.now() - t0 < 180000) setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

loadSiteName().then(boot).then(() => { if (!me) renderLogin(); });
