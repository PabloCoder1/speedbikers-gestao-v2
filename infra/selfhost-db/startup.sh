#!/bin/bash
# Script de inicialização da VM do banco (Supabase próprio). Roda a cada boot, como root,
# e é idempotente. Não contém segredo: o .env vem do Secret Manager.
#
# Metadados da VM usados: `backup-script` (conteúdo de backup.sh).
set -euo pipefail
exec > >(tee -a /var/log/sb-startup.log) 2>&1
echo "== $(date -u +%FT%TZ) startup"

PROJECT=speedbikers-prod
SECRET=selfhost-supabase-env
UPSTREAM_SHA=2679dc391646850d76629914a27ae89d90a04b07   # supabase/supabase, pasta docker/
DIR=/opt/supabase

meta() { curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/$1"; }
token() { meta instance/service-accounts/default/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }

export DEBIAN_FRONTEND=noninteractive

# 1. Docker Engine + compose, do repositório oficial.
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl git python3 cron
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Logs do Docker com teto, para não encher o disco.
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "3" } }
JSON
  systemctl restart docker
fi
systemctl enable --now docker

# 2. Agente de operações (métricas e logs no Cloud Monitoring).
if ! systemctl list-unit-files | grep -q google-cloud-ops-agent; then
  curl -sSf https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh -o /tmp/ops-agent.sh
  bash /tmp/ops-agent.sh --also-install || echo "aviso: ops agent nao instalou"
fi

# 3. Pasta docker/ do repositório oficial, no commit fixado, com um ajuste:
#    o banco grava num volume nativo do Docker (não numa pasta do host).
if [ ! -f "$DIR/.fetched-$UPSTREAM_SHA" ]; then
  mkdir -p "$DIR"
  tmp=$(mktemp -d)
  git -C "$tmp" init -q
  git -C "$tmp" remote add origin https://github.com/supabase/supabase.git
  git -C "$tmp" sparse-checkout set docker
  git -C "$tmp" fetch -q --depth 1 --filter=blob:none origin "$UPSTREAM_SHA"
  git -C "$tmp" checkout -q FETCH_HEAD
  cp -a "$tmp/docker/." "$DIR/"
  rm -rf "$tmp"
  python3 - "$DIR/docker-compose.yml" <<'PY'
import sys
p = sys.argv[1]
t = open(p, encoding="utf-8").read()
a = "      - ./volumes/db/data:/var/lib/postgresql/data:Z"
assert a in t, "linha do volume do banco nao encontrada: o compose mudou"
t = t.replace(a, "      - db-data:/var/lib/postgresql/data")
t = t.replace("\n  db-config:\n", "\n  db-config:\n  db-data:\n", 1)
open(p, "w", encoding="utf-8", newline="\n").write(t)
PY
  touch "$DIR/.fetched-$UPSTREAM_SHA"
fi

# 4. O .env vem do Secret Manager (a última versão). Falha = não sobe com env velho.
tmpenv=$(mktemp)
curl -sf -H "Authorization: Bearer $(token)" \
  "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$SECRET/versions/latest:access" \
  | python3 -c 'import sys,json,base64;sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]))' > "$tmpenv"
grep -q '^JWT_SECRET=' "$tmpenv" || { echo "ERRO: segredo sem JWT_SECRET"; exit 1; }
install -m 0600 "$tmpenv" "$DIR/.env"
rm -f "$tmpenv"

# 5. Backup diário (o script vem no metadado `backup-script`).
meta instance/attributes/backup-script > /usr/local/bin/sb-backup.sh || true
chmod 0755 /usr/local/bin/sb-backup.sh
echo '15 6 * * * root /usr/local/bin/sb-backup.sh >> /var/log/sb-backup.log 2>&1' > /etc/cron.d/sb-backup

# 6. Sobe a pilha.
cd "$DIR"
export COMPOSE_PROJECT_NAME=supabase
docker compose pull -q
docker compose up -d
echo "== $(date -u +%FT%TZ) fim"
