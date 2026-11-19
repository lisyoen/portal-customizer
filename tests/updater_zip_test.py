#!/usr/bin/env python3
"""Release-zip self update: host.py downloads a newer zip and replaces the folder in place."""
import functools, http.server, json, os, shutil, struct, subprocess, sys, tempfile, threading

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def build(version, out):
    """Release zip with the given manifest version (copy of the current tree)."""
    tmp = tempfile.mkdtemp()
    try:
        shutil.copytree(os.path.join(REPO, "extension"), os.path.join(tmp, "extension"))
        shutil.copytree(os.path.join(REPO, "updater"), os.path.join(tmp, "updater"),
                        ignore=shutil.ignore_patterns("__pycache__", "host-manifest.json"))
        shutil.copytree(os.path.join(REPO, "scripts"), os.path.join(tmp, "scripts"))
        shutil.copy(os.path.join(REPO, "LICENSE"), os.path.join(tmp, "LICENSE"))
        m = os.path.join(tmp, "extension", "manifest.json")
        d = json.load(open(m, encoding="utf-8")); d["version"] = version
        json.dump(d, open(m, "w", encoding="utf-8"))
        subprocess.run(["bash", os.path.join(tmp, "scripts", "build-zip.sh"), out], check=True, capture_output=True)
    finally:
        shutil.rmtree(tmp)


def call_host(folder, env, version="", zip_url=""):
    msg = json.dumps({"action": "update", "version": version, "zipUrl": zip_url}).encode()
    p = subprocess.run([sys.executable, os.path.join(folder, "updater", "host.py")],
                       input=struct.pack("<I", len(msg)) + msg, capture_output=True, env=env, timeout=60)
    n = struct.unpack("<I", p.stdout[:4])[0]
    return json.loads(p.stdout[4:4 + n])


def main():
    work = tempfile.mkdtemp()
    try:
        serve = os.path.join(work, "serve")
        os.makedirs(os.path.join(serve, "v9.9.9"))
        build("9.9.9", os.path.join(serve, "v9.9.9", "portal-customizer-v9.9.9.zip"))
        json.dump({"version": "9.9.9"}, open(os.path.join(serve, "latest.json"), "w"))
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass
        handler = functools.partial(Quiet, directory=serve)
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        env = dict(os.environ, PC_LATEST_URL=f"{base}/latest.json", PC_DOWNLOAD_BASE=base)

        # An installed release folder at 9.9.8 with a registered helper and a stray old file.
        folder = os.path.join(work, "installed")
        os.makedirs(folder)
        build("9.9.8", os.path.join(work, "old.zip"))
        shutil.unpack_archive(os.path.join(work, "old.zip"), folder)
        open(os.path.join(folder, "updater", "host-manifest.json"), "w").write("{}")
        open(os.path.join(folder, "stale.js"), "w").write("old")

        r = call_host(folder, env)
        assert r["ok"] and not r["upToDate"] and r["after"] == "9.9.9", r
        assert json.load(open(os.path.join(folder, "manifest.json")))["version"] == "9.9.9"
        assert not os.path.exists(os.path.join(folder, "stale.js")), "old files must be removed"
        assert os.path.exists(os.path.join(folder, "updater", "host-manifest.json")), "registration must survive"
        assert not os.path.exists(os.path.join(folder, ".pc-update")), "staging must be cleaned"
        assert os.path.isfile(os.path.join(folder, "background.js"))

        r = call_host(folder, env)
        assert r["ok"] and r["upToDate"], r
        r = call_host(folder, env, version="9.9.9")
        assert r["ok"] and r["upToDate"], r
        # admin server source: the extension passes the package address (any path), GitHub is not used
        os.makedirs(os.path.join(serve, "ext"))
        build("9.9.10", os.path.join(serve, "ext", "portal-customizer-v9.9.10.zip"))
        no_github = dict(os.environ, PC_LATEST_URL="http://127.0.0.1:9/none", PC_DOWNLOAD_BASE="http://127.0.0.1:9")
        r = call_host(folder, no_github, version="9.9.10", zip_url=f"{base}/ext/portal-customizer-v9.9.10.zip")
        assert r["ok"] and r["after"] == "9.9.10", r
        r = call_host(folder, no_github, version="9.9.11", zip_url="file:///etc/passwd")
        assert not r["ok"], r
        httpd.shutdown()
        print("updater zip self-update OK")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
