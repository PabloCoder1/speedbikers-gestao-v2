#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud-scheduler.sh"
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
  'run services describe') echo https://api.example.test ;;
  'scheduler jobs describe') echo 'PERMISSION_DENIED simulado' >&2; exit 1 ;;
  'scheduler jobs list')
    if [ "${FALHA_LEITURA}" = sim ]; then
      echo 'PERMISSION_DENIED simulado' >&2
      exit 1
    fi
    printf '\n%s\r\n' 'v3-heartbeat' 'v3-reconcile-orders-extra' ;;
  'scheduler jobs create'|'scheduler jobs update')
    printf '%s %s\n' "$3" "$5" >> "${WRITES_FIXTURE}" ;;
  *) echo "Comando inesperado: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${fixture}/gcloud"

rodar() {
  env -i PATH="${PATH}" GCLOUD_BIN="${fixture}/gcloud" WRITES_FIXTURE="${fixture}/writes" \
    FALHA_LEITURA="$1" SHOPEE_PARTNER_ID=ficticio bash "${script}"
}

: > "${fixture}/writes"
if saida="$(rodar sim 2>&1)" || [ -s "${fixture}/writes" ] || [[ "${saida}" != *'PERMISSION_DENIED simulado'* ]]; then
  printf 'FALHA: erro de listagem deveria abortar antes de create/update\n%s\n' "${saida}" >&2
  exit 1
fi
printf 'ok    falha de listagem interrompe antes de create/update\n'

rodar nao >/dev/null
grep -Fxq 'update v3-heartbeat' "${fixture}/writes"
grep -Fxq 'create v3-reconcile-orders' "${fixture}/writes"
grep -Fxq 'create v3-shopee-orders' "${fixture}/writes"
grep -Fxq 'create v3-low-margin-sales' "${fixture}/writes"
[ "$(grep -c '^update ' "${fixture}/writes")" -eq 1 ]
[ "$(grep -c '^create ' "${fixture}/writes")" -eq 18 ]
printf 'ok    inventário decide por nome completo, preservando os 19 jobs\n'
