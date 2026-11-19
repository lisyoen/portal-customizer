#!/usr/bin/env bash
# Portal Customizer admin server installer (Linux, Node.js 18+, git, PM2).
#   curl -fsSL https://raw.githubusercontent.com/lisyoen/portal-customizer/main/server/scripts/install.sh | bash -s -- --port 9150 --url http://SERVER:9150
# Options: --dir DIR (default ~/portal-customizer-server)  --port N (9150)  --url http://host:port (address staff browsers use)
#          --admin ID (admin)  --name PM2_NAME (portal-customizer-server)
# Admin password: asked on the terminal, or PC_ADMIN_PASSWORD=... in the environment. Run again to upgrade.
set -euo pipefail
DIR="$HOME/portal-customizer-server"; PORT=9150; URL=""; ADMIN=admin; APP=portal-customizer-server
REPO="${PC_REPO:-https://github.com/lisyoen/portal-customizer.git}"
while (($#)); do case "$1" in
  --dir) DIR=$2; shift 2;; --port) PORT=$2; shift 2;; --url) URL=$2; shift 2;; --admin) ADMIN=$2; shift 2;; --name) APP=$2; shift 2;;
  *) echo "알 수 없는 옵션: $1" >&2; exit 2;; esac; done
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
die(){ echo "오류: $*" >&2; exit 1; }

say "1/6 필요한 프로그램 확인"
command -v git >/dev/null || die "git 이 없습니다 (sudo apt-get install -y git)"
command -v node >/dev/null || die "Node.js 가 없습니다 (18 이상 필요)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); ((NODE_MAJOR >= 18)) || die "Node.js 18 이상이 필요합니다(현재 $(node -v))"
if ! command -v pm2 >/dev/null; then echo "PM2 가 없어 설치합니다: npm install -g pm2"; npm install -g pm2 >/dev/null || die "PM2 설치 실패 — npm install -g pm2 를 직접 실행한 뒤 다시 실행하세요"; fi
echo "git $(git --version | awk '{print $3}') · node $(node -v) · pm2 $(pm2 -v)"

say "2/6 소스 받기: $DIR"
if [[ -d "$DIR/.git" ]]; then git -C "$DIR" fetch -q --force origin '+refs/tags/*:refs/tags/*' '+refs/heads/main:refs/remotes/origin/main' || die "git fetch 실패(프록시 설정 확인)"
else git clone -q "$REPO" "$DIR" || die "git clone 실패(프록시 설정 확인: git config --global http.proxy ...)"; git -C "$DIR" fetch -q --force origin '+refs/tags/*:refs/tags/*'; fi
cd "$DIR"
TAG=$(git tag -l 'server-v*' | sort -V | tail -1)
[[ -n "$TAG" ]] || die "관리 서버 릴리스 태그(server-v*)를 찾지 못했습니다"
git checkout -q -f "$TAG"
echo "버전: $TAG"

say "3/6 설정"
DATA="$DIR/server/data"; mkdir -p "$DATA"
if pm2 describe "$APP" >/dev/null 2>&1; then echo "이미 실행 중인 $APP 를 업그레이드합니다"; else
  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then die "포트 $PORT 를 이미 다른 프로그램이 쓰고 있습니다. --port 로 다른 포트를 지정하세요"; fi; fi
[[ -n "$URL" ]] || URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
node -e 'const fs=require("fs");const [f,port,url]=process.argv.slice(1);let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}c.port=Number(port);c.host=c.host||"0.0.0.0";c.publicUrl=url;fs.writeFileSync(f,JSON.stringify(c,null,2))' "$DATA/config.json" "$PORT" "$URL"
echo "포트 $PORT · 주소 $URL · 데이터 $DATA"

say "4/6 관리자 계정"
HAS_ADMIN=$(PC_DATA="$DATA" node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.env.PC_DATA+"/db.json","utf8"));console.log((d.admins||[]).length)}catch(e){console.log(0)}')
if [[ "$HAS_ADMIN" == "0" || -n "${PC_ADMIN_PASSWORD:-}" ]]; then
  PW="${PC_ADMIN_PASSWORD:-}"
  if [[ -z "$PW" ]]; then
    [[ -r /dev/tty ]] || die "비밀번호를 입력받을 수 없습니다. PC_ADMIN_PASSWORD=... 로 지정하세요"
    while :; do read -rsp "관리자 '$ADMIN' 비밀번호(8자 이상): " PW </dev/tty; echo; read -rsp "한 번 더: " PW2 </dev/tty; echo
      [[ ${#PW} -ge 8 && "$PW" == "$PW2" ]] && break; echo "8자 이상, 두 번 같게 입력하세요"; done
  fi
  PC_DATA="$DATA" PC_PASSWORD="$PW" node server/cli.js admin "$ADMIN" >/dev/null || die "관리자 계정 생성 실패"
  echo "관리자 '$ADMIN' 설정 완료"
else echo "기존 관리자 계정을 그대로 씁니다"; fi

say "5/6 실행(PM2: $APP)"
if pm2 describe "$APP" >/dev/null 2>&1; then pm2 restart "$APP" --update-env >/dev/null; else pm2 start server/server.js --name "$APP" --cwd "$DIR" --time >/dev/null; fi
pm2 save >/dev/null 2>&1 || true

say "6/6 확인"
VER=$(node -p 'require("./server/package.json").version'); OK=""
for i in $(seq 1 20); do curl --noproxy '*' -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q "\"$VER\"" && { OK=1; break; }; sleep 1; done
[[ -n "$OK" ]] || { pm2 logs "$APP" --lines 30 --nostream; die "서버가 응답하지 않습니다"; }
cat <<MSG

설치 완료: Portal Customizer 관리 서버 v$VER
  관리 페이지  : $URL/
  배포 주소    : $URL/portal-customizer.json   (직원 확장의 '사내 기본 배치'에 입력)
  관리자 로그인: 확장 팝업 › 관리자 로그인 › 서버 $URL · 아이디 $ADMIN
  업데이트     : 관리 페이지 › 설정·업데이트 (자동 업데이트 기본 켜짐) 또는 이 스크립트 다시 실행
  재부팅 후 자동 실행이 안 되어 있다면: pm2 startup 안내에 따라 한 번 설정
MSG
