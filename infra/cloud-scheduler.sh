#!/usr/bin/env bash
# Cria os agendamentos do Cloud Scheduler.
#
# Idempotente: recria o job se ele já existir, para que a definição no script
# continue sendo a verdade.
#
# O Scheduler dispara APENAS reconciliação e manutenção. Nunca despacha fila —
# foi o polling por cron que dominou o banco da V2 (D-014).
#
# Uso:  bash infra/cloud-scheduler.sh

source "$(dirname "$0")/lib.sh"

TIME_ZONE="America/Sao_Paulo"

# ATENÇÃO ao editar textos passados ao gcloud no Windows: o wrapper é um .cmd
# interpretado pelo cmd.exe, que trata `>`, `<`, `|` e `&` como operadores mesmo
# dentro de aspas. Um `->` numa descrição faz o comando falhar com uma mensagem
# sobre 'C:\Program', que não tem relação aparente com a causa.

upsert_job() {
  local name="$1" schedule="$2" uri="$3" description="$4"

  local action=create
  if gc scheduler jobs describe "${name}" --location "${REGION}" >/dev/null 2>&1; then
    action=update
  fi

  local output
  if ! output="$(gc scheduler jobs "${action}" http "${name}" \
      --location "${REGION}" \
      --schedule "${schedule}" \
      --time-zone "${TIME_ZONE}" \
      --uri "${uri}" \
      --http-method POST \
      --oidc-service-account-email "$(sa_email "${SA_SCHEDULER}")" \
      --oidc-token-audience "${API_URL}" \
      --description "${description}" 2>&1)"; then
    printf '%s\n' "${output}" >&2
    fail "Falha ao ${action} o job ${name}. Mensagem do gcloud acima."
  fi

  ok "${name} (${schedule} ${TIME_ZONE})"
}

step "Pré-condições"
require_auth
require_project

API_URL="$(gc run services describe api --region "${REGION}" --format='value(status.url)' 2>/dev/null || true)"
[ -n "${API_URL}" ] || fail "Serviço api não existe. Rode: bash infra/deploy-cloud-run.sh api"
info "api: ${API_URL}"

step "Agendamentos"

# Heartbeat: prova continuamente que a corrente api -> Cloud Tasks -> worker
# está inteira. Custa praticamente nada e transforma uma falha silenciosa de
# integração em algo observável.
upsert_job \
  "v3-heartbeat" \
  "0 * * * *" \
  "${API_URL}/internal/jobs/ping" \
  "Verificacao horaria da malha api para Cloud Tasks para worker"

# Reconciliacao por janela: rede de seguranca do que o webhook perdeu
# (docs/MERCADO_LIVRE.md secao 3), nao o caminho de frescor. Uma vez por hora
# basta -- o filtro do Mercado Livre so tem granularidade de hora cheia
# mesmo (confirmado na documentacao oficial, mesma secao), e o dedupe de
# triggerOrdersReconciliation ja recusaria uma segunda chamada na mesma hora.
upsert_job \
  "v3-reconcile-orders" \
  "0 * * * *" \
  "${API_URL}/internal/schedule/reconcile" \
  "Reconciliacao por janela de pedidos, por conta Mercado Livre CONNECTED"

# Captura de estoque Full por conta: cadencia menor que a de pedidos --
# Full nao muda tao rapido, e cada execucao faz duas chamadas HTTP por item
# sem variacao da conta. Mais conservador com o orcamento de rate limit nao
# documentado (D-042) do que copiar a cadencia horaria sem necessidade.
upsert_job \
  "v3-fulfillment-snapshot" \
  "0 */6 * * *" \
  "${API_URL}/internal/schedule/fulfillment" \
  "Captura de estoque Full, por conta Mercado Livre CONNECTED"

# Reconciliacao de estoque contra o snapshot do UpSeller (D-029) -- cadencia
# DIARIA, nao horaria: o snapshot so muda quando alguem reimporta a planilha
# manualmente, esporadico por natureza. Por ORGANIZACAO, nao por conta ML
# (D-006) -- diferente dos dois jobs acima.
upsert_job \
  "v3-reconcile-balances" \
  "0 6 * * *" \
  "${API_URL}/internal/schedule/maintenance" \
  "Reconciliacao de estoque (LOCAL/RESERVADO) contra o snapshot do UpSeller, por organizacao"

# Conferencia automatica ledger x projecao (D-056) -- as duas fontes sao
# internas (stock_movements x inventory_balances) e so divergem por bug
# (trigger pulado, escrita direta na projecao), nunca por processo humano --
# diferente do job acima. Cadencia diaria, horario escalonado (30min depois)
# para nao competir por recurso com a reconciliacao do UpSeller.
upsert_job \
  "v3-verify-ledger-integrity" \
  "30 6 * * *" \
  "${API_URL}/internal/schedule/ledger-integrity" \
  "Conferencia ledger (stock_movements) contra a projecao (inventory_balances), por organizacao"

# Sincronizacao de listings/anuncios (D-058) -- cadencia menor que pedidos,
# mesmo raciocinio de Full (nao muda tao rapido, mais conservador com o
# orcamento de rate limit nao documentado, D-042). Por CONTA, nao por
# organizacao -- listing pertence a uma conta Mercado Livre especifica.
upsert_job \
  "v3-listings-snapshot" \
  "0 */6 * * *" \
  "${API_URL}/internal/schedule/listings" \
  "Sincronizacao de listings/anuncios, por conta Mercado Livre CONNECTED"

# Sincronizacao de visitas por anuncio (D-032) -- cadencia DIARIA, mais
# conservadora que listings/Full: visita nao e dado operacional urgente como
# estoque, e fetchListingVisits ja busca last=3 dias a cada rodada (absorve
# uma rodada perdida sem esperar o dia seguinte). Por CONTA.
upsert_job \
  "v3-listing-visits-snapshot" \
  "0 7 * * *" \
  "${API_URL}/internal/schedule/listing-visits" \
  "Sincronizacao de visitas por anuncio, por conta Mercado Livre CONNECTED"

step "Concluído"
gc scheduler jobs list --location "${REGION}" --format="table(name.basename(),schedule,state)"
