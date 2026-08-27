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

# Aviso de orcamento de IA (D-082/D-100) -- soma ai_runs.cost_usd do mes de
# negocio e emite ai.budget.exceeded ao ultrapassar o teto (avisa, nunca
# bloqueia). Cadencia diaria, 9h: horario escalonado depois de todos os
# jobs de manutencao/diagnostico da manha (6h..8h30). O EVENTO deduplica
# por mes no dominio, entao rodar todo dia so mantem o atraso maximo do
# aviso em ate 24h.
upsert_job \
  "v3-check-ai-budget" \
  "0 9 * * *" \
  "${API_URL}/internal/schedule/ai-budget" \
  "Aviso de orcamento de IA: soma ai_runs.cost_usd do mes e emite ai.budget.exceeded ao ultrapassar o teto, por organizacao"

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

# Reconciliacao de Perguntas do Mercado Livre (Fase 7B, D-089).
#
# Cadencia de 10 em 10 minutos desde 2026-08-26 (D-092). Era 6h, sob a
# premissa de que o webhook entregava em segundos e isto era so rede de
# seguranca -- premissa que D-091 derrubou: o webhook NUNCA foi chamado.
# Enquanto o painel do Mercado Livre nao for configurado, esta varredura e o
# unico caminho de ingestao, e uma pergunta levava ate 6h para aparecer.
#
# Custo: 4 contas x 6 execucoes/hora = 24 chamadas/hora, cada uma uma pagina
# pequena filtrada por UNANSWERED. Por CONTA.
upsert_job \
  "v3-support-questions-reconcile" \
  "*/10 * * * *" \
  "${API_URL}/internal/schedule/support-questions" \
  "Reconciliacao de Perguntas nao respondidas, por conta Mercado Livre CONNECTED"

# Reconciliacao de Mensagens pos-venda. Mesma cadencia e mesmo motivo medido da
# de Perguntas: o webhook do Mercado Livre nunca foi chamado (D-091), entao
# enquanto o painel nao for configurado esta varredura e a UNICA porta por onde
# uma mensagem pos-venda entra.
#
# Custo: 1 chamada a /messages/unread por conta, mais 1 por conversa nao lida.
# O handler trunca em 120 conversas por execucao para nao consumir o pool
# compartilhado de 500 rpm da mensageria. Por CONTA.
upsert_job \
  "v3-support-messages-reconcile" \
  "*/10 * * * *" \
  "${API_URL}/internal/schedule/support-messages" \
  "Reconciliacao de Mensagens pos-venda nao lidas, por conta Mercado Livre CONNECTED"

# Deteccao de anomalia de venda -- Central de Acoes (Fase 6, D-064). Cadencia
# DIARIA, depois dos jobs acima: o diagnostico usa daily_sku_metrics/
# domain_events de ONTEM, que ja estao completos a qualquer hora do dia
# seguinte -- 8h so evita competir por recurso com reconcile-balances (6h) e
# verify-ledger-integrity (6h30). Por ORGANIZACAO (D-006).
upsert_job \
  "v3-detect-sales-anomalies" \
  "0 8 * * *" \
  "${API_URL}/internal/schedule/sales-anomaly-actions" \
  "Deteccao de anomalia de venda (baseline/desvio) e gravacao em actions, por organizacao"

# Memoria de decisoes operacionais -- Fase 6, ultimo item do checklist
# (PROMPT_MASTER secao 29). Cadencia DIARIA, depois de detect-sales-anomalies
# (8h): so precisa rodar depois que decisoes do dia ja foram tomadas, sem
# vantagem em rodar mais cedo -- mesmo raciocinio de dado de ONTEM ja
# completo. Por ORGANIZACAO (D-006).
upsert_job \
  "v3-measure-decision-outcomes" \
  "30 8 * * *" \
  "${API_URL}/internal/schedule/decision-outcomes" \
  "Medicao de resultado de decisoes (7/15/30 dias) contra o baseline_snapshot, por organizacao"

step "Concluído"
gc scheduler jobs list --location "${REGION}" --format="table(name.basename(),schedule,state)"
