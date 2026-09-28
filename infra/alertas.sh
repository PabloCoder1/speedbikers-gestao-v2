#!/usr/bin/env bash
# Alertas mínimos de produção no Cloud Monitoring (auditoria de 2026-09-28).
#
# Até aqui a produção não tinha nenhum: 0 canais, 0 uptime checks, 0 políticas.
# A parada de 27/09 (D-414) durou ~27 h com o Scheduler verde. Estes três
# cobrem o que teria avisado:
#
#   1. canal de e-mail do dono;
#   2. uptime check da api (`/health`, a cada 5 min) + política "api fora do
#      ar por 10 min";
#   3. política por log: 403 do Mercado Livre no worker (`ml_http_failure`
#      com status 403, ou a recusa na troca de token) -- o sinal do bloqueio
#      por instância da D-414. No máximo um e-mail por hora.
#
# Idempotente: procura cada recurso pelo nome antes de criar.
#
# Uso (o dono roda; criar alerta é configuração permanente da conta):
#   PROJECT_ID=speedbikers-prod ALERT_EMAIL=voce@exemplo.com bash infra/alertas.sh
#
# No Git Bash do Windows o `gcloud logging`/`monitoring` quebra com filtro que
# tem espaço; por isso tudo vai pela API REST com o token do gcloud.
set -euo pipefail

: "${PROJECT_ID:?defina PROJECT_ID (ex.: speedbikers-prod)}"
: "${ALERT_EMAIL:?defina ALERT_EMAIL}"
REGION="${REGION:-southamerica-east1}"

GCLOUD="$(command -v gcloud || command -v gcloud.cmd)"
TOKEN="$("${GCLOUD}" auth print-access-token 2>/dev/null | tr -d '\r')"
API="https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}"

rest() { # método caminho [arquivo-json]
  if [ -n "${3:-}" ]; then
    curl -sS -X "$1" "${API}$2" -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d @"$3"
  else
    curl -sS -X "$1" "${API}$2" -H "Authorization: Bearer ${TOKEN}"
  fi
}

# Primeiro `name` cujo displayName é o pedido, na listagem do recurso.
achar() { # recurso displayName
  rest GET "/$1" | python -c "
import json,sys
d=json.load(sys.stdin)
for x in d.get('$1', []):
    if x.get('displayName') == sys.argv[1]:
        print(x['name']); break" "$2"
}

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

API_HOST="$("${GCLOUD}" run services describe api --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)' 2>/dev/null | tr -d '\r' | sed 's#https://##')"
[ -n "${API_HOST}" ] || { echo "serviço api não encontrado em ${PROJECT_ID}"; exit 1; }

# 1. Canal
CANAL="$(achar notificationChannels 'Dono - e-mail')"
if [ -z "${CANAL}" ]; then
  printf '{"type":"email","displayName":"Dono - e-mail","labels":{"email_address":"%s"}}' "${ALERT_EMAIL}" > "${tmp}/canal.json"
  CANAL="$(rest POST /notificationChannels "${tmp}/canal.json" | python -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
  echo "canal criado: ${CANAL}"
else
  echo "canal já existe: ${CANAL}"
fi

# 2. Uptime check + política
UPTIME="$(achar uptimeCheckConfigs 'api /health')"
if [ -z "${UPTIME}" ]; then
  cat > "${tmp}/uptime.json" <<JSON
{"displayName":"api /health",
 "monitoredResource":{"type":"uptime_url","labels":{"project_id":"${PROJECT_ID}","host":"${API_HOST}"}},
 "httpCheck":{"path":"/health","port":443,"useSsl":true,"validateSsl":true},
 "period":"300s","timeout":"10s"}
JSON
  UPTIME="$(rest POST /uptimeCheckConfigs "${tmp}/uptime.json" | python -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
  echo "uptime check criado: ${UPTIME}"
else
  echo "uptime check já existe: ${UPTIME}"
fi
CHECK_ID="${UPTIME##*/}"

if [ -z "$(achar alertPolicies 'api fora do ar')" ]; then
  cat > "${tmp}/p-uptime.json" <<JSON
{"displayName":"api fora do ar","combiner":"OR","notificationChannels":["${CANAL}"],
 "documentation":{"content":"A api de produção não respondeu ao /health em mais de uma região por 10 minutos. Conferir revisão e logs do Cloud Run (docs/DEPLOYMENT.md).","mimeType":"text/markdown"},
 "conditions":[{"displayName":"uptime /health falhando",
   "conditionThreshold":{
     "filter":"metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${CHECK_ID}\" AND resource.type=\"uptime_url\"",
     "aggregations":[{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_NEXT_OLDER","crossSeriesReducer":"REDUCE_COUNT_FALSE","groupByFields":["resource.label.*"]}],
     "comparison":"COMPARISON_GT","thresholdValue":1,"duration":"600s",
     "trigger":{"count":1}}}]}
JSON
  rest POST /alertPolicies "${tmp}/p-uptime.json" | python -c 'import json,sys; print("política criada:", json.load(sys.stdin)["name"])'
else
  echo "política 'api fora do ar' já existe"
fi

# 3. Política por log: 403 do Mercado Livre no worker
if [ -z "$(achar alertPolicies 'Mercado Livre 403 no worker')" ]; then
  cat > "${tmp}/p-403.json" <<'JSON'
{"displayName":"Mercado Livre 403 no worker","combiner":"OR","notificationChannels":["__CANAL__"],
 "documentation":{"content":"O Mercado Livre recusou uma chamada do worker com 403 (D-414: bloqueio por instância/IP de saída). Ver instanceId no Cloud Logging; se for uma instância só, revisão nova do worker com a mesma imagem.","mimeType":"text/markdown"},
 "alertStrategy":{"notificationRateLimit":{"period":"3600s"},"autoClose":"3600s"},
 "conditions":[{"displayName":"ml_http_failure 403 ou recusa na troca de token",
   "conditionMatchedLog":{"filter":"resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"worker\" AND ((jsonPayload.message=\"ml_http_failure\" AND jsonPayload.status=403) OR \"403 na troca de token\")"}}]}
JSON
  sed -i "s#__CANAL__#${CANAL}#" "${tmp}/p-403.json"
  rest POST /alertPolicies "${tmp}/p-403.json" | python -c 'import json,sys; print("política criada:", json.load(sys.stdin)["name"])'
else
  echo "política 'Mercado Livre 403 no worker' já existe"
fi
