#!/bin/bash
# Backup diário do banco: dump completo (formato custom) para o bucket, com conferência.
# Roda às 06:15 UTC (03:15 em Brasília). Retenção de 35 dias no bucket (regra do bucket).
set -euo pipefail

BUCKET=speedbikers-prod-db-backups
D=$(date -u +%F)
DIR=/var/backups/sb
F="$DIR/$D.dump"
mkdir -p "$DIR"

meta() { curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/$1"; }
token() { meta instance/service-accounts/default/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }

docker exec supabase-db pg_dump -U supabase_admin -d postgres -Fc > "$F"

# Um dump vazio ou truncado não pode virar "backup".
tamanho=$(stat -c %s "$F")
[ "$tamanho" -gt 1048576 ] || { echo "ERRO: dump com $tamanho bytes"; exit 1; }
# Lista o conteudo para um arquivo antes do grep: `grep -q` fecha o cano cedo e o
# pipefail transformaria o SIGPIPE do pg_restore em falso erro.
docker exec -i supabase-db pg_restore -l < "$F" > "$F.lista"
grep -q "TABLE DATA public job_runs" "$F.lista" || { echo "ERRO: dump sem a tabela job_runs"; exit 1; }
rm -f "$F.lista"

curl -sf -X POST -H "Authorization: Bearer $(token)" -H "Content-Type: application/octet-stream" \
  --data-binary @"$F" \
  "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=diario/$D.dump" > /dev/null

echo "$(date -u +%FT%TZ) ok: diario/$D.dump ($tamanho bytes)"
find "$DIR" -name '*.dump' -mtime +2 -delete
