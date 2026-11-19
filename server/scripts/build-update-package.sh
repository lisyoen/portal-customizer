#!/usr/bin/env bash
# Offline update package for the admin server: manifest.json + repo.bundle (release tag).
#   bash server/scripts/build-update-package.sh server-vX.Y.Z [outdir]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
TAG=${1:?tag required}; OUT=${2:-dist}; VERSION=${TAG#server-v}
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "tag not found: $TAG" >&2; exit 1; }
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
PKG="portal-customizer-server-update-$VERSION"; mkdir -p "$STAGE/$PKG"
git bundle create "$STAGE/$PKG/repo.bundle" "$TAG" 2>/dev/null
node -e 'const fs=require("fs"),c=require("crypto"),p=require("path");const [d,v,tag,commit]=process.argv.slice(1);const files={};for(const f of fs.readdirSync(d))files[f]=c.createHash("sha256").update(fs.readFileSync(p.join(d,f))).digest("hex");fs.writeFileSync(p.join(d,"manifest.json"),JSON.stringify({product:"portal-customizer-server",format:1,version:v,tag,commit,created_at:new Date().toISOString(),files},null,1))' \
  "$STAGE/$PKG" "$VERSION" "$TAG" "$(git rev-parse "$TAG^{commit}")"
mkdir -p "$OUT"; tar czf "$OUT/$PKG.tar.gz" -C "$STAGE" "$PKG"
echo "$OUT/$PKG.tar.gz"
