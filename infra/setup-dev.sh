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

step "Repositório de imagens (Artifact Registry)"
# `deploy-cloud-run.sh` publica em
# ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}, e até 2026-09-14 NADA criava
# esse repositório (D-349). No Dev ele foi feito à mão quando o ambiente nasceu,
# e a falta só apareceu no primeiro projeto novo — com o agravante de aparecer
# TARDE: o Cloud Build sobe o contexto, constrói a imagem inteira, e só então o
# push falha com `name unknown: Repository "speedbikers-v3" not found`. Um build
# pago para descobrir uma linha que faltava.
#
# O nome tem de ser o MESMO de `REPO` em `deploy-cloud-run.sh`. As duas pontas
# moram em arquivos diferentes e nenhuma guarda automática as compara — o que as
# mantém juntas é esta frase, como na tabela de segredos acima.
REPO_IMAGENS="speedbikers-v3"

if gc artifacts repositories describe "${REPO_IMAGENS}" --location "${REGION}" >/dev/null 2>&1; then
  skip "${REPO_IMAGENS} (${REGION})"
else
  gc artifacts repositories create "${REPO_IMAGENS}" \
    --location "${REGION}" \
    --repository-format docker \
    --description "Imagens da api e do worker (infra/deploy-cloud-run.sh)" >/dev/null
  ok "${REPO_IMAGENS} (${REGION})"
fi

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
# Ao criar uma task, quem enfileira declara qual identidade o Cloud Tasks vai
# assumir para invocar o worker. A `api` cria os jobs normais; o `worker` cria
# o próximo pedaço do backfill retomável. Ambos precisam poder "agir como" essa
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
grant_act_as "${SA_TASKS}" "${SA_WORKER}"

step "Acesso aos segredos"
# Concedido NO SEGREDO, não no projeto: cada identidade lê apenas o segredo de
# que precisa. `secretAccessor` permite ler o valor, não alterá-lo nem apagá-lo.
#
# A TABELA ABAIXO É A MESMA LISTA que `infra/deploy-cloud-run.sh` monta em
# `--set-secrets`, e existe por isso (D-348). Até 2026-09-14 este passo
# concedia apenas `SUPABASE_SERVICE_ROLE_KEY` (api e worker) e
# `ANTHROPIC_API_KEY` (só api). Os outros DOIS — `MERCADO_LIVRE_CLIENT_SECRET`
# e `ML_TOKEN_ENCRYPTION_KEY` — iam para o `--set-secrets` dos dois serviços
# sem concessão nenhuma. No Dev ninguém viu, porque essas concessões foram
# feitas à mão quando o ambiente nasceu; num projeto NOVO o deploy termina
# VERDE e a revisão não parte, porque o segredo é montado na PARTIDA do
# container, não no deploy.
#
# Regra de manutenção: segredo que entra no `--set-secrets` entra aqui, com os
# mesmos consumidores. As duas listas moram em arquivos diferentes e nenhuma
# guarda automática as compara — o que as mantém juntas é esta frase.
SEGREDOS_CONSUMIDORES=(
  "${SECRET_SUPABASE_KEY}:${SA_API} ${SA_WORKER}"
  "${SECRET_ML_CLIENT_SECRET}:${SA_API} ${SA_WORKER}"
  "${SECRET_ML_TOKEN_KEY}:${SA_API} ${SA_WORKER}"
  "${SECRET_ANTHROPIC_KEY}:${SA_API}"
)

grant_secret_access() {
  local secret="$1" sa="$2" output

  if ! output="$(gc secrets add-iam-policy-binding "${secret}" \
      --member "serviceAccount:$(sa_email "${sa}")" \
      --role roles/secretmanager.secretAccessor 2>&1)"; then
    printf '%s\n' "${output}" >&2
    fail "Falha ao conceder acesso a ${secret} para ${sa}. Mensagem do gcloud acima."
  fi

  info "${sa} pode ler ${secret}"
}

SEGREDOS_FALTANDO=()

for entrada in "${SEGREDOS_CONSUMIDORES[@]}"; do
  secret="${entrada%%:*}"
  consumidores="${entrada#*:}"

  if gc secrets describe "${secret}" >/dev/null 2>&1; then
    # Word splitting proposital: `consumidores` é lista separada por espaço.
    for sa in ${consumidores}; do
      grant_secret_access "${secret}" "${sa}"
    done
  else
    SEGREDOS_FALTANDO+=("${secret}")
    info "AVISO: ${secret} ainda não existe no Secret Manager de ${PROJECT_ID}"
  fi
done

unset entrada secret consumidores sa

# No Dev o aviso basta: este script roda enquanto o ambiente ainda está sendo
# montado, e rodá-lo de novo depois de criar o segredo concede o acesso. Em
# PRODUÇÃO, seguir com segredo faltando é publicar um container que não parte
# — e o deploy que o publica sai verde. Parar aqui custa uma rodada; descobrir
# pelo Cloud Logging custa o corte.
if [ "${#SEGREDOS_FALTANDO[@]}" -gt 0 ] && [ "${AMBIENTE}" = "prod" ]; then
  fail "AMBIENTE=prod com segredo(s) ausente(s) em ${PROJECT_ID}: ${SEGREDOS_FALTANDO[*]}. Crie-os no Secret Manager (docs/DEPLOYMENT.md secao 5) e rode este script DE NOVO — ele é idempotente. Sem eles o deploy termina verde e a revisão nova nunca parte."
fi

step "Concluído"
if [ "${#SEGREDOS_FALTANDO[@]}" -gt 0 ]; then
  info "Pendente: criar ${SEGREDOS_FALTANDO[*]} e rodar este script de novo"
fi
info "Próximo: bash infra/cloud-tasks-queues.sh"
info "Depois:  bash infra/storage-buckets.sh"
