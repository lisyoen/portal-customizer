#!/usr/bin/env bash
# Release the admin server: bump version, test, tag server-vX.Y.Z, push, GitHub release with the offline update package.
#   bash server/scripts/release.sh <version> <notes.md>   (release notes are written in Korean)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
VERSION=${1:?version required}; NOTES=${2:?release notes file required (Korean)}
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
node -e 'const fs=require("fs");const f="server/package.json";const p=JSON.parse(fs.readFileSync(f));p.version=process.argv[1];fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$VERSION"
(cd server && node --test tests/ >/dev/null)
TAG="server-v$VERSION"
git add -A && git commit -qm "server release: v$VERSION" && git tag "$TAG" && git push -q origin main "$TAG"
PKG=$(bash server/scripts/build-update-package.sh "$TAG" dist)
gh release create "$TAG" "$PKG" --title "관리 서버 v$VERSION" --notes-file "$NOTES" --latest=false
echo "released $TAG"
