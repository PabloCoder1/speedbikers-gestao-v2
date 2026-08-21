#!/usr/bin/env bash
# Cria as filas do Cloud Tasks.
#
# Idempotente. Fila vazia não custa nada; o custo vem do despacho.
#
# Uso:  bash infra/cloud-tasks-queues.sh
#       bash infra/cloud-tasks-queues.sh offracer     # cria a fila de uma conta ML

source "$(dirname "$0")/lib.sh"

# ---------------------------------------------------------------------------
# NOTA IMPORTANTE SOBRE RATE LIMIT
#
# O limite de taxa do Cloud Tasks é POR FILA, não por conta. Para respeitar o
# rate limit do Mercado Livre por conta — que é o objetivo declarado na D-014 —
# cada conta precisa da própria fila `ml-sync-<conta>`.
#
# Uma fila única compartilhada faria um backfill de uma conta consumir o
# orçamento de requisições das outras. A V2 registrou 17 respostas HTTP 429 em
# 24 h entre 4 contas SEM backfill rodando.
#
# Os números abaixo são PROVISÓRIOS: a política de rate limit vigente do
# Mercado Livre ainda não foi confirmada na documentação oficial. Ver a lista
# de verificação em docs/MERCADO_LIVRE.md secao 1. Ajustar depois de confirmar,
# nunca por chute.
# ---------------------------------------------------------------------------

create_queue() {
  local name="$1" dispatches="$2" concurrent="$3" attempts="$4" min_backoff="$5" max_backoff="$6"

  if gc tasks queues describe "${name}" --location "${REGION}" >/dev/null 2>&1; then
    skip "${name}"
  else
    gc tasks queues create "${name}" \
      --location "${REGION}" \
      --max-dispatches-per-second "${dispatches}" \
      --max-concurrent-dispatches "${concurrent}" \
      --max-attempts "${attempts}" \
      --min-backoff "${min_backoff}" \
      --max-backoff "${max_backoff}" >/dev/null
    ok "${name}  (${dispatches}/s, ${concurrent} simultâneas, ${attempts} tentativas)"
  fi

  # Menor privilégio: a `api` enfileira, e a permissão é dada por fila, não no
  # projeto inteiro.
  #
  # Sem `|| true`: engolir a falha aqui esconderia exatamente o erro que
  # importa — service account inexistente ou sem permissão de conceder papel.
  local binding
  if ! binding="$(gc tasks queues add-iam-policy-binding "${name}" \
      --location "${REGION}" \
      --member "serviceAccount:$(sa_email "${SA_API}")" \
      --role roles/cloudtasks.enqueuer 2>&1)"; then
    printf '%s\n' "${binding}" >&2
    fail "Falha ao conceder cloudtasks.enqueuer em ${name}. Mensagem do gcloud acima."
  fi

  info "${name}: enqueuer -> ${SA_API}"
}

step "Pré-condições"
require_auth
require_project

# Fila por conta do Mercado Livre, quando um nome de conta é informado.
if [ "$#" -gt 0 ]; then
  step "Fila da conta ${1}"
  create_queue "ml-sync-${1}" 5 10 8 10s 600s
  exit 0
fi

step "Filas base"

# analytics-recompute: alto throughput, poucas tentativas. O recálculo é
# derivado e recomputável — se falhar, a próxima venda do mesmo SKU reenfileira.
create_queue "analytics-recompute" 10 20 5 5s 300s

# backfill: prioridade baixa DE PROPÓSITO. Nunca pode disputar capacidade com o
# tráfego vivo. Muitas tentativas porque o trabalho é longo e retomável.
create_queue "backfill" 1 2 10 30s 3600s

# Único caso em que o WORKER também enfileira, não só a api: cada pedaço do
# backfill (`docs/HANDOFF.md`), ao terminar, enfileira o próximo pedaço
# direto nesta fila. Menor privilégio: só nesta fila, não no projeto.
binding_worker_backfill="$(gc tasks queues add-iam-policy-binding "backfill" \
    --location "${REGION}" \
    --member "serviceAccount:$(sa_email "${SA_WORKER}")" \
    --role roles/cloudtasks.enqueuer 2>&1)" || {
  printf '%s\n' "${binding_worker_backfill}" >&2
  fail "Falha ao conceder cloudtasks.enqueuer em backfill para o worker. Mensagem do gcloud acima."
}
info "backfill: enqueuer -> ${SA_WORKER} (auto-encadeamento)"

# maintenance: conferência de saldo, expurgo, medição. Baixa frequência.
create_queue "maintenance" 1 1 3 60s 600s

step "Filas por conta do Mercado Livre"
info "Nenhuma conta conectada ainda (Fase 2)."
info "Ao conectar uma conta, rode: bash infra/cloud-tasks-queues.sh <slug-da-conta>"

step "Concluído"
gc tasks queues list --location "${REGION}"
