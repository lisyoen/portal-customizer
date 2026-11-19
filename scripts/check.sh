#!/usr/bin/env bash
# Static checks + unit tests. Run before every commit.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - << 'PY'
import json, os, re, sys
m = json.load(open("extension/manifest.json", encoding="utf-8"))
assert m["manifest_version"] == 3
files = list(m["icons"].values()) + [m["background"]["service_worker"], m["action"]["default_popup"], m["storage"]["managed_schema"]]
bg = open("extension/background.js", encoding="utf-8").read()
for name in ("CONTENT_JS", "CONTENT_CSS"):
    files += re.findall(r'"([^"]+)"', re.search(name + r" = \[([^\]]*)\]", bg).group(1))
files += ["content/probe.js"]
missing = [f for f in files if not os.path.isfile(os.path.join("extension", f))]
if missing: sys.exit(f"missing: {missing}")
used = set()
for root, _, names in os.walk("extension"):
    for n in names:
        if n.endswith((".js", ".html", ".json")):
            s = open(os.path.join(root, n), encoding="utf-8").read()
            used |= set(re.findall(r'__MSG_(\w+)__', s))
            used |= set(re.findall(r'data-i18n(?:-placeholder)?="(\w+)"', s))
            used |= set(k for k in re.findall(r'\bt\("(\w+)"', s) if not k.endswith("_"))
locales = {l: json.load(open(f"extension/_locales/{l}/messages.json", encoding="utf-8")) for l in ("en", "ko")}
undefined = sorted(k for k in used if k not in locales["en"])
if undefined: sys.exit(f"undefined i18n keys: {undefined}")
if set(locales["en"]) != set(locales["ko"]): sys.exit(f"locale key mismatch: {set(locales['en']) ^ set(locales['ko'])}")
for t in ("native", "image", "video", "html", "links", "memo", "iframe", "carousel", "feed"):
    assert "type_" + t in locales["en"], t
print(f"manifest OK v{m['version']} ({len(files)} files, {len(used)} i18n keys used)")
PY
for f in $(find extension server -name '*.js' -not -path '*/node_modules/*') updater/host.py; do
  case "$f" in *.py) python3 -m py_compile "$f";; *) node --check "$f";; esac
done
echo "syntax OK"
# Public repo guard: no private network addresses (extra local patterns in .guard-patterns, not committed).
PAT='\b(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]+\.[0-9]+\b'
[ -f .guard-patterns ] && PAT="$PAT|$(paste -sd'|' .guard-patterns)"
if grep -rInE "$PAT" --exclude-dir=.git --exclude-dir=dist --exclude=check.sh --exclude=.guard-patterns . ; then
  echo "internal address found"; exit 1
fi
echo "public repo guard OK"
node --test tests/
(cd server && node --test tests/)
python3 tests/updater_zip_test.py
