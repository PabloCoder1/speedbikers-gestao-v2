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
# `billing projects describe` também recebe o projeto como posicional.
if ! BILLING="$(gc_positional billing projects describe --format='value(billingEnabled)' 2>&1)"; then
  printf '%s\n' "${BILLING}" >&2
  fail "Não foi possível verificar o billing. Mensagem do gcloud acima."
fi

if [ "${BILLING}" = "True" ]; then
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

create_sa "${SA_API}"       "Runtime do backend API Speed Bikers Gestao V3"
create_sa "${SA_WORKER}"    "Runtime dos workers Speed Bikers Gestao V3"
create_sa "${SA_TASKS}"     "Identidade usada pelo Cloud Tasks"
create_sa "${SA_SCHEDULER}" "Identidade usada pelo Cloud Scheduler"

step "Delegação de identidade"
# Ao criar uma task, a `api` declara qual identidade o Cloud Tasks vai assumir
# para invocar o worker. Para isso ela precisa poder "agir como" essa
# identidade — sem isso o enfileiramento falha com PERMISSION_DENIED em
# `iam.serviceAccounts.actAs`.
#
# A permissão é concedida NA service account alvo, não no projeto: a `api` pode
# agir como o invocador do Tasks e como nenhuma outra.
grant_act_as() {
  local target="$1" member="$2" output

  if ! output="$(gc iam service-accounts add-iam-policy-binding "$(sa_email "${target}")" \
      --member "serviceAccount:$(sa_email "${member}")" \
      --role roles/iam.serviceAccountUser 2>&1)"; then
    printf '%s\n' "${output}" >&2
    fail "Falha ao conceder serviceAccountUser em ${target}. Mensagem do gcloud acima."
  fi

  info "${member} pode agir como ${target}"
}

grant_act_as "${SA_TASKS}" "${SA_API}"

step "Acesso ao segredo do Supabase"
# Concedido NO SEGREDO, não no projeto: cada identidade lê apenas o segredo de
# que precisa. `secretAccessor` permite ler o valor, não alterá-lo nem apagá-lo.
grant_secret_access() {
  local sa="$1" output

  if ! output="$(gc secrets add-iam-policy-binding "${SECRET_SUPABASE_KEY}" \
      --member "serviceAccount:$(sa_email "${sa}")" \
      --role roles/secretmanager.secretAccessor 2>&1)"; then
    printf '%s\n' "${output}" >&2
    fail "Falha ao conceder acesso ao segredo para ${sa}. Mensagem do gcloud acima."
  fi

  info "${sa} pode ler ${SECRET_SUPABASE_KEY}"
}

if gc secrets describe "${SECRET_SUPABASE_KEY}" >/dev/null 2>&1; then
  grant_secret_access "${SA_API}"
  grant_secret_access "${SA_WORKER}"
else
  info "AVISO: segredo ${SECRET_SUPABASE_KEY} ainda não existe; pulando"
fi

step "Concluído"
info "Próximo: bash infra/cloud-tasks-queues.sh"
info "Depois:  bash infra/storage-buckets.sh"
