#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/alertas.sh"
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/curl" "${fixture}/requests"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  'auth print-access-token') echo token-ficticio ;;
  'run services') echo https://api.example.test ;;
  *) exit 1 ;;
esac
SH

cat > "${fixture}/curl" <<'SH'
#!/usr/bin/env bash
fail=0
page=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -f|-fsS|--fail) fail=1 ;;
    https://*)
      endpoint="${1##*/}"
      resource="${endpoint%%\?*}"
      if [[ "${endpoint}" == *\?pageToken=* ]]; then page="${endpoint#*=}"; fi ;;
  esac
  shift
done
printf '%s %s\n' "${method}" "${resource}" >> "${REQUESTS_FIXTURE}"
if [ "${method}" = POST ]; then
  echo '{"name":"canal-criado"}'
  exit 0
fi
if [ "${resource}" = "${LISTAGEM_COM_ERRO}" ]; then
  if [ "${fail}" -eq 1 ]; then
    echo 'HTTP 403 simulado' >&2
    exit 22
  fi
  echo '{"error":{"code":403}}'
  exit 0
fi
if [ "${resource}" = "${PAGINADO:-}" ]; then
  case "${page}" in
    '')
      if [ "${SEGUNDA_PAGINA:-}" = duplicada ]; then
        echo '{"notificationChannels":[{"displayName":"Dono - e-mail","name":"canal-antigo"}],"nextPageToken":"p+/="}'
      else
        echo '{"nextPageToken":"p+/="}'
      fi
      exit 0 ;;
    p%2B%2F%3D)
      case "${SEGUNDA_PAGINA:-}" in
        erro) echo 'HTTP 403 simulado na segunda página' >&2; exit 22 ;;
        repetida) echo '{"nextPageToken":"p+/="}'; exit 0 ;;
      esac ;;
    *) echo 'token codificado incorretamente' >&2; exit 1 ;;
  esac
fi

case "${resource}" in
  notificationChannels)
    if [ "${CANAL_AUSENTE}" = sim ]; then echo '{}'; else
      echo '{"notificationChannels":[{"displayName":"Dono - e-mail","name":"canal"}]}'
    fi ;;
  uptimeCheckConfigs) echo '{"uptimeCheckConfigs":[{"displayName":"api /health","name":"uptime"}]}' ;;
  alertPolicies) echo '{"alertPolicies":[{"displayName":"api fora do ar","name":"p1"},{"displayName":"Mercado Livre 403 no worker","name":"p2"}]}' ;;
  *) exit 1 ;;
esac
SH
chmod +x "${fixture}/gcloud" "${fixture}/curl"

export PATH="${fixture}:${PATH}" PROJECT_ID=projeto-ficticio ALERT_EMAIL=dono@example.test
export REQUESTS_FIXTURE="${fixture}/requests"

for recurso in notificationChannels uptimeCheckConfigs alertPolicies; do
  : > "${REQUESTS_FIXTURE}"
  if saida="$(LISTAGEM_COM_ERRO="${recurso}" CANAL_AUSENTE=nao bash "${script}" 2>&1)" ||
    grep -q '^POST ' "${REQUESTS_FIXTURE}" || [[ "${saida}" != *'HTTP 403 simulado'* ]]; then
    printf 'FALHA: listagem de %s deveria abortar antes da criação\n%s\n' "${recurso}" "${saida}" >&2
    exit 1
  fi
  printf 'ok    erro ao listar %s aborta\n' "${recurso}"
done

: > "${REQUESTS_FIXTURE}"
LISTAGEM_COM_ERRO=nenhuma CANAL_AUSENTE=sim bash "${script}" >/dev/null
[ "$(grep '^POST ' "${REQUESTS_FIXTURE}")" = 'POST notificationChannels' ]
printf 'ok    listagem bem-sucedida permite criar o canal ausente\n'

for recurso in notificationChannels uptimeCheckConfigs alertPolicies; do
  : > "${REQUESTS_FIXTURE}"
  LISTAGEM_COM_ERRO=nenhuma CANAL_AUSENTE=nao PAGINADO="${recurso}" bash "${script}" >/dev/null
  if grep -q '^POST ' "${REQUESTS_FIXTURE}" || [ "$(grep -c "^GET ${recurso}$" "${REQUESTS_FIXTURE}")" -lt 2 ]; then
    printf 'FALHA: %s deveria localizar o recurso na segunda página\n' "${recurso}" >&2
    exit 1
  fi
  printf 'ok    %s reutiliza o recurso na segunda página\n' "${recurso}"
done

for caso in erro repetida duplicada; do
  : > "${REQUESTS_FIXTURE}"
  if LISTAGEM_COM_ERRO=nenhuma CANAL_AUSENTE=nao PAGINADO=notificationChannels SEGUNDA_PAGINA="${caso}" bash "${script}" >/dev/null 2>&1 ||
    grep -q '^POST ' "${REQUESTS_FIXTURE}" ||
    [ "$(grep -c '^GET notificationChannels$' "${REQUESTS_FIXTURE}")" -ne 2 ]; then
    printf 'FALHA: segunda página %s deveria abortar sem POST\n' "${caso}" >&2
    exit 1
  fi
  printf 'ok    segunda página %s aborta sem POST\n' "${caso}"
done
