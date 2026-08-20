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

step "Concluído"
gc scheduler jobs list --location "${REGION}" --format="table(name.basename(),schedule,state)"
