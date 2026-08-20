#!/usr/bin/env bash
# Cria os buckets do Cloud Storage.
#
# Idempotente. Bucket vazio não custa nada.
#
# Uso:  bash infra/storage-buckets.sh

source "$(dirname "$0")/lib.sh"

BUCKET_RAW="${PROJECT_ID}-raw-ml"
BUCKET_ERP="${PROJECT_ID}-erp-imports"
BUCKET_DOCS="${PROJECT_ID}-documents"

create_bucket() {
  local name="$1"

  if gc storage buckets describe "gs://${name}" >/dev/null 2>&1; then
    skip "${name}"
    return
  fi

  # Sem acesso público, em nenhuma hipótese: estes buckets guardam payload
  # comercial, planilha de estoque e documento fiscal.
  gc storage buckets create "gs://${name}" \
    --location "${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention >/dev/null

  ok "${name}"
}

step "Pré-condições"
require_auth
require_project

step "Buckets"
create_bucket "${BUCKET_RAW}"
create_bucket "${BUCKET_ERP}"
create_bucket "${BUCKET_DOCS}"

step "Ciclo de vida do payload bruto (D-030)"
# 90 dias em classe quente, depois classe fria. Regra declarativa do bucket, não
# rotina de expurgo em código — foi assim que a V2 ficou presa com raw_payload
# dentro das duas maiores tabelas do banco, sem conseguir limpar.
LIFECYCLE_FILE="$(mktemp)"
trap 'rm -f "${LIFECYCLE_FILE}"' EXIT

cat > "${LIFECYCLE_FILE}" <<'JSON'
{
  "rule": [
    {
      "action": { "type": "SetStorageClass", "storageClass": "COLDLINE" },
      "condition": { "age": 90, "matchesStorageClass": ["STANDARD"] }
    }
  ]
}
JSON

gc storage buckets update "gs://${BUCKET_RAW}" --lifecycle-file="${LIFECYCLE_FILE}" >/dev/null
ok "${BUCKET_RAW}: STANDARD -> COLDLINE aos 90 dias"

step "Concluído"
info "raw-ml     ${BUCKET_RAW}"
info "erp-imports ${BUCKET_ERP}"
info "documents   ${BUCKET_DOCS}"
