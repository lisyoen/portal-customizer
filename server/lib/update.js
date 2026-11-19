// Self update from GitHub release tags (server-vX.Y.Z) or from an uploaded offline package.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");      // git checkout (repository root)
const PREFIX = "server-v";

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, Object.assign({ cwd: ROOT, maxBuffer: 20 * 1024 * 1024, timeout: 120000 }, opts || {}), (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") }));
  });
}
function cmpVer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
async function latestRemote() {
  const r = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/${PREFIX}*`]);
  if (!r.ok) return { ok: false, error: (r.err || "git ls-remote failed").trim().slice(-300) };
  const versions = [...r.out.matchAll(new RegExp(`refs/tags/${PREFIX}(\\d+\\.\\d+\\.\\d+)$`, "gm"))].map((m) => m[1]);
  versions.sort(cmpVer);
  return { ok: true, latest: versions[versions.length - 1] || null, versions };
}
function statusFile(dataDir) { return path.join(dataDir, "update", "status.json"); }
function readStatus(dataDir) { try { return JSON.parse(fs.readFileSync(statusFile(dataDir), "utf8")); } catch (_e) { return null; } }

// Runs the target release's own update script detached: it checks out the tag, restarts the PM2 app,
// checks /api/health and rolls back on failure. This process is restarted by it.
async function apply(dataDir, version, opts) {
  const tag = PREFIX + version;
  const dir = path.join(dataDir, "update");
  fs.mkdirSync(dir, { recursive: true });
  if (!(opts && opts.offline)) {
    const f = await run("git", ["fetch", "--force", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
    if (!f.ok) return { ok: false, error: "fetch failed: " + f.err.trim().slice(-300) };
  }
  const script = path.join(dir, `self-update-${tag}.sh`);
  const show = await run("git", ["show", `${tag}:server/scripts/self-update.sh`]);
  if (!show.ok) return { ok: false, error: "update script not found in " + tag };
  fs.writeFileSync(script, show.out, { mode: 0o755 });
  const log = path.join(dir, `update-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  // setsid + an intermediate shell that exits at once: the updater is re-parented to init, so PM2 restarting
  // this app (it kills the app's process tree) does not stop the updater.
  const child = spawn("bash", ["-c", 'setsid nohup bash "$0" "$1" >>"$2" 2>&1 </dev/null &', script, tag, log], {
    cwd: ROOT, detached: true, stdio: "ignore",
    env: Object.assign({}, process.env, { PC_PM2_NAME: process.env.PC_PM2_NAME || process.env.name || "portal-customizer-server", PC_ROOT: ROOT, PC_DATA: dataDir, PC_UPDATE_LOG: log, PC_UPDATE_OFFLINE: opts && opts.offline ? "1" : "" }),
  });
  child.unref();
  return { ok: true, tag, log };
}

// Offline package: portal-customizer-server-update-X.Y.Z.tar.gz = manifest.json + repo.bundle
async function installPackage(dataDir, file, currentVersion) {
  const dir = fs.mkdtempSync(path.join(dataDir, "update", "pkg-"));
  const x = await run("tar", ["xzf", file, "-C", dir]);
  if (!x.ok) return { ok: false, error: "압축을 풀지 못했습니다" };
  const top = fs.readdirSync(dir).map((n) => path.join(dir, n)).find((p) => fs.existsSync(path.join(p, "manifest.json"))) || dir;
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(top, "manifest.json"), "utf8")); } catch (_e) { return { ok: false, error: "manifest.json 이 없습니다" }; }
  if (m.product !== "portal-customizer-server") return { ok: false, error: "Portal Customizer 관리 서버 업데이트 패키지가 아닙니다" };
  for (const [name, digest] of Object.entries(m.files || {})) {
    const p = path.join(top, name);
    if (!fs.existsSync(p) || crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== digest) return { ok: false, error: "패키지 파일이 손상되었습니다: " + name };
  }
  if (cmpVer(m.version, currentVersion) <= 0) return { ok: false, error: `이미 v${currentVersion} 입니다. 더 새 버전만 설치할 수 있습니다(패키지 v${m.version})` };
  const tag = PREFIX + m.version;
  const f = await run("git", ["fetch", "--force", path.join(top, "repo.bundle"), `refs/tags/${tag}:refs/tags/${tag}`]);
  if (!f.ok) return { ok: false, error: "패키지의 릴리스를 가져오지 못했습니다: " + f.err.trim().slice(-200) };
  return apply(dataDir, m.version, { offline: true });
}

module.exports = { latestRemote, apply, installPackage, readStatus, cmpVer, PREFIX, ROOT };
