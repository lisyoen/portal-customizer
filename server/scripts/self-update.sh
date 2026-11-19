#!/usr/bin/env bash
# Portal Customizer admin server self update (run detached by the server, or by hand: bash server/scripts/self-update.sh server-vX.Y.Z)
# checkout tag -> restart PM2 app -> health check -> roll back to the previous commit on failure.
set -uo pipefail
TAG=${1:?tag required}
ROOT=${PC_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}; cd "$ROOT"
DATA=${PC_DATA:-$ROOT/server/data}
APP=${PC_PM2_NAME:-portal-customizer-server}
PORT=${PORT:-$(node -e 'try{console.log(require(process.argv[1]).port||9150)}catch(e){console.log(9150)}' "$DATA/config.json" 2>/dev/null)}
DIR="$DATA/update"; mkdir -p "$DIR"; STATUS="$DIR/status.json"
VERSION=${TAG#server-v}
PREV=$(git rev-parse HEAD); PREV_VERSION=$(node -p 'require("./server/package.json").version')
status(){ node -e 'const fs=require("fs");const[p,phase,from,to,reason]=process.argv.slice(1);fs.writeFileSync(p,JSON.stringify({phase,from,to,reason,at:new Date().toISOString()}))' "$STATUS" "$1" "$PREV_VERSION" "$VERSION" "${2:-}"; echo "[$(date -Iseconds)] $1 ${2:-}"; }
health(){ for i in $(seq 1 30); do v=$(curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch(e){}})'); [[ "$v" == "$VERSION" ]] && return 0; sleep 2; done; return 1; }
rollback(){ status failed "$1"; git checkout -q -f "$PREV" && pm2 restart "$APP" --update-env >/dev/null 2>&1; echo "rolled back to $PREV"; exit 1; }
status fetching
if [[ -z "${PC_UPDATE_OFFLINE:-}" ]]; then git fetch --force origin "+refs/tags/$TAG:refs/tags/$TAG" || { status failed "fetch 실패"; exit 1; }; fi
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { status failed "태그 없음: $TAG"; exit 1; }
cp -f "$DATA/db.json" "$DIR/db-before-$VERSION.json" 2>/dev/null || true
status checkout; git checkout -q -f "$TAG" || rollback "checkout 실패"
status restarting; pm2 restart "$APP" --update-env 2>&1 | tail -5; [[ ${PIPESTATUS[0]} -eq 0 ]] || rollback "PM2 재시작 실패"
status verifying; health || rollback "새 버전 응답 없음"
pm2 save >/dev/null 2>&1 || true
status done
echo "update complete: $TAG"
