#!/bin/bash
# Aplica as migrations do Git e carrega os dados na pilha da VM.
# Entradas (no bucket, prefixo import/): migrations.tgz (pasta supabase/migrations) e dados.sql.gz
# (saída do extrator, com `delete from` antes de cada COPY). Roda NA VM, como root.
# Uso: sudo bash restore.sh [migrations|dados|tudo]
set -euo pipefail

BUCKET=speedbikers-prod-db-backups
CLI_VERSION=2.115.0
ETAPA=${1:-tudo}

cd /opt/supabase
# Lê só o que precisa: o .env tem valores com espaço e não é um arquivo de shell.
envget() { grep -m1 "^$1=" /opt/supabase/.env | cut -d= -f2-; }
POOLER_TENANT_ID=$(envget POOLER_TENANT_ID)
POSTGRES_PASSWORD=$(envget POSTGRES_PASSWORD)
POSTGRES_PORT=$(envget POSTGRES_PORT)

meta() { curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/$1"; }
token() { meta instance/service-accounts/default/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
baixar() {
  local obj; obj=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1")
  curl -sf -H "Authorization: Bearer $(token)" "https://storage.googleapis.com/storage/v1/b/$BUCKET/o/$obj?alt=media"
}

if [ "$ETAPA" = migrations ] || [ "$ETAPA" = tudo ]; then
  if ! command -v supabase >/dev/null 2>&1; then
    curl -fsSL "https://github.com/supabase/cli/releases/download/v${CLI_VERSION}/supabase_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin supabase
  fi
  rm -rf /tmp/mig && mkdir -p /tmp/mig/supabase
  baixar import/migrations.tgz | tar -xz -C /tmp/mig/supabase
  echo 'project_id = "sb-prod"' > /tmp/mig/supabase/config.toml
  echo "== migrations ($(ls /tmp/mig/supabase/migrations | wc -l) arquivos)"
  supabase migration up --db-url "postgresql://postgres.${POOLER_TENANT_ID}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT:-5432}/postgres?sslmode=disable" --workdir /tmp/mig 2>&1 | tail -3 | cut -c1-200
fi

if [ "$ETAPA" = dados ] || [ "$ETAPA" = tudo ]; then
  echo "== carga dos dados"
  time (baixar import/dados.sql.gz | gunzip | docker exec -i supabase-db psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1)
  docker exec supabase-db psql -U supabase_admin -d postgres -qc "vacuum analyze"
  docker exec supabase-db psql -U supabase_admin -d postgres -tAc "select pg_size_pretty(pg_database_size('postgres'))" | sed 's/^/banco: /'
fi
