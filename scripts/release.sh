#!/usr/bin/env bash
# Usage: scripts/release.sh <version> <notes.md>   (release notes are written in Korean)
# Bumps the manifest, builds the zip, commits, tags, pushes and creates the GitHub release.
# Staff extensions update from the admin server: upload the zip on its 확장 배포 page.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?version required, e.g. 0.2.1}"
NOTES="${2:?release notes file required (Korean)}"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }

python3 - "$VERSION" << 'PY'
import json, sys
v = sys.argv[1]
p = "extension/manifest.json"
m = json.load(open(p, encoding="utf-8")); m["version"] = v
open(p, "w", encoding="utf-8").write(json.dumps(m, ensure_ascii=False, indent=2) + "\n")
PY
bash scripts/check.sh > /dev/null
mkdir -p dist
ZIP="dist/portal-customizer-v${VERSION}.zip"
bash scripts/build-zip.sh "$ZIP"
git add -A
git commit -qm "release: v${VERSION}"
git tag "v${VERSION}"
git push -q origin main "v${VERSION}"
gh release create "v${VERSION}" "$ZIP" --title "v${VERSION}" --notes-file "$NOTES"
echo "released v${VERSION}"
