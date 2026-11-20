#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud-tasks-queues.sh"
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/writes"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "$1 $2" in
  'auth list') echo runner@example.test; exit 0 ;;
  'projects describe') echo speedbikers-gestao-v3; exit 0 ;;
esac

case "$1 $2 $3" in
  'tasks queues describe') echo 'PERMISSION_DENIED simulado' >&2; exit 1 ;;
  'tasks queues list')
    if [ "${FALHA_LEITURA}" = sim ]; then
      echo 'PERMISSION_DENIED simulado' >&2
      exit 1
    fi
    printf '%s\r\n' 'analytics-recompute' 'backfill-copia' 'ml-sync-conta-teste' ;;
  'tasks queues create') printf 'create %s\n' "$4" >> "${WRITES_FIXTURE}" ;;
  'tasks queues add-iam-policy-binding') printf 'binding %s\n' "$4" >> "${WRITES_FIXTURE}" ;;
  *) echo "Comando inesperado: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${fixture}/gcloud"

rodar() {
  local falha="$1"
  shift
  env -i PATH="${PATH}" GCLOUD_BIN="${fixture}/gcloud" WRITES_FIXTURE="${fixture}/writes" \
    FALHA_LEITURA="${falha}" bash "${script}" "$@"
}

: > "${fixture}/writes"
if saida="$(rodar sim 2>&1)" || [ -s "${fixture}/writes" ] || [[ "${saida}" != *'PERMISSION_DENIED simulado'* ]]; then
  printf 'FALHA: listar filas deveria abortar antes de criação ou IAM\n%s\n' "${saida}" >&2
  exit 1
fi
printf 'ok    erro de listagem aborta antes de criação ou IAM\n'

rodar nao >/dev/null
esperado=$'binding analytics-recompute\nbinding analytics-recompute\ncreate backfill\nbinding backfill\nbinding backfill\ncreate maintenance\nbinding maintenance'
[ "$(cat "${fixture}/writes")" = "${esperado}" ]
printf 'ok    modo base preserva fila existente e bindings de API/worker\n'

: > "${fixture}/writes"
rodar nao conta-teste >/dev/null
[ "$(cat "${fixture}/writes")" = 'binding ml-sync-conta-teste' ]
printf 'ok    modo por conta preserva fila existente e aplica o binding\n'
