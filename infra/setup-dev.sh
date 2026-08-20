#!/usr/bin/env bash
# Prepara o projeto Google Cloud de desenvolvimento.
#
# Idempotente: pode ser rodado quantas vezes for preciso.
# Não cria nada que custe dinheiro parado — service account não tem custo.
#
# Uso:  bash infra/setup-dev.sh

source "$(dirname "$0")/lib.sh"

step "Pré-condições"
require_auth
require_project

step "Billing"
if [ "$(gc billing projects describe --format='value(billingEnabled)' 2>/dev/null)" = "True" ]; then
  ok "billing habilitado"
else
  fail "Billing desabilitado no projeto ${PROJECT_ID}. Cloud Run e Cloud Tasks exigem billing."
fi

step "APIs necessárias"
REQUIRED_APIS=(
  run.googleapis.com
  cloudtasks.googleapis.com
  cloudscheduler.googleapis.com
  secretmanager.googleapis.com
  storage.googleapis.com
  artifactregistry.googleapis.com
  cloudbuild.googleapis.com
  logging.googleapis.com
)

ENABLED="$(gc services list --enabled --format='value(config.name)')"

for api in "${REQUIRED_APIS[@]}"; do
  if grep -qx "${api}" <<< "${ENABLED}"; then
    ok "${api}"
  else
    info "habilitando ${api}"
    gc services enable "${api}"
    ok "${api}"
  fi
done

step "Service accounts"
# Uma identidade por responsabilidade. Ver docs/DEPLOYMENT.md.
create_sa() {
  local name="$1" description="$2"

  if gc iam service-accounts describe "$(sa_email "${name}")" >/dev/null 2>&1; then
    skip "${name}"
  else
    gc iam service-accounts create "${name}" \
      --display-name "${name}" \
      --description "${description}" >/dev/null
    ok "${name}"
  fi
}

create_sa "${SA_API}"    "Identidade do serviço apps/api no Cloud Run"
create_sa "${SA_WORKER}" "Identidade do serviço apps/worker no Cloud Run"
create_sa "${SA_TASKS}"  "Identidade usada pelo Cloud Tasks para invocar o worker via OIDC"

step "Concluído"
info "Próximo: bash infra/cloud-tasks-queues.sh"
info "Depois:  bash infra/storage-buckets.sh"
