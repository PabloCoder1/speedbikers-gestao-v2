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

bucket_exists() {
  grep -Fxq -- "$1" <<< "${EXISTING_BUCKETS}"
}

create_bucket() {
  local name="$1"
  shift

  if bucket_exists "${name}"; then
    skip "${name}"
    return
  fi

  # Estes buckets guardam payload comercial, estoque e documentos fiscais.
  gc storage buckets create "gs://${name}" \
    --location "${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention "$@" >/dev/null

  ok "${name}"
}

step "Pré-condições"
require_auth
require_project

if ! EXISTING_BUCKETS="$(gc storage buckets list --format='value(name)' | tr -d '\r')"; then
  fail "Não foi possível listar os buckets em ${PROJECT_ID}."
fi

# D-030: 90 dias em classe quente e depois COLDLINE. O comando update
# substitui todas as regras, por isso instalamos a regra apenas na criação.
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

if bucket_exists "${BUCKET_RAW}"; then
  if ! lifecycle="$(gc storage buckets describe "gs://${BUCKET_RAW}" --format='json(lifecycle_config)')"; then
    fail "Não foi possível consultar o lifecycle de ${BUCKET_RAW}."
  fi
  if ! node -e '
    const { readFileSync } = require("node:fs");
    const { isDeepStrictEqual } = require("node:util");
    try {
      const expected = JSON.parse(readFileSync(process.argv[1], "utf8")).rule[0];
      const current = JSON.parse(readFileSync(0, "utf8")).lifecycle_config?.rule;
      if (!Array.isArray(current) || !current.some((rule) => isDeepStrictEqual(rule, expected))) {
        process.exitCode = 1;
      }
    } catch {
      process.exitCode = 1;
    }
  ' "${LIFECYCLE_FILE}" <<< "${lifecycle}"; then
    fail "Lifecycle de ${BUCKET_RAW} não confirma D-030. Revise a configuração existente antes de continuar."
  fi
fi

step "Buckets"
create_bucket "${BUCKET_RAW}" "--lifecycle-file=${LIFECYCLE_FILE}"
create_bucket "${BUCKET_ERP}"
create_bucket "${BUCKET_DOCS}"

step "Permissões por bucket"
# Menor privilégio: cada identidade recebe acesso apenas ao bucket que usa, no
# próprio bucket — nunca um papel de storage no projeto inteiro.
grant_bucket() {
  local bucket="$1" sa="$2" role="$3" output

  if ! output="$(gc storage buckets add-iam-policy-binding "gs://${bucket}" \
      --member "serviceAccount:$(sa_email "${sa}")" \
      --role "${role}" 2>&1)"; then
    printf '%s\n' "${output}" >&2
    fail "Falha ao conceder ${role} em ${bucket}. Mensagem do gcloud acima."
  fi

  info "${bucket}: ${role#roles/} -> ${sa}"
}

# O worker grava o payload bruto; a api não precisa tocar nele.
grant_bucket "${BUCKET_RAW}"  "${SA_WORKER}" "roles/storage.objectAdmin"

# Planilhas do ERP e documentos fiscais entram pela api (upload do usuário) e
# são lidos pelo worker no processamento.
grant_bucket "${BUCKET_ERP}"  "${SA_API}"    "roles/storage.objectAdmin"
grant_bucket "${BUCKET_ERP}"  "${SA_WORKER}" "roles/storage.objectViewer"
grant_bucket "${BUCKET_DOCS}" "${SA_API}"    "roles/storage.objectAdmin"
grant_bucket "${BUCKET_DOCS}" "${SA_WORKER}" "roles/storage.objectViewer"

step "Concluído"
info "raw-ml      ${BUCKET_RAW}"
info "erp-imports ${BUCKET_ERP}"
info "documents   ${BUCKET_DOCS}"
