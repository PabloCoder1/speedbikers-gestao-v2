#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud-nat.sh"
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/writes"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'auth list') echo runner@example.test ;;
  'projects describe') echo speedbikers-prod ;;
  'services list')
    case "$SCENARIO" in
      denied) echo 'PERMISSION_DENIED simulado' >&2; exit 1 ;;
      enabled) printf 'compute.googleapis.com\r\n' ;;
      absent) printf 'compute.googleapis.com.copia\r\n' ;;
    esac
    ;;
  'services enable')
    [[ "$3" = compute.googleapis.com ]]
    printf 'enable %s\n' "$3" >> "$WRITES_FIXTURE"
    ;;
  'compute networks'|'compute routers') ;;
  'compute addresses') echo '192.0.2.10' ;;
  *) echo "Comando inesperado: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${fixture}/gcloud"

rodar() {
  : > "${fixture}/writes"
  env -i PATH="$PATH" \
    AMBIENTE=prod PROJECT_ID=speedbikers-prod SUPABASE_PROJECT_REF=sentinel-test-prod \
    SUPABASE_PUBLISHABLE_KEY=fixture-placeholder WEB_ORIGINS=https://example.invalid \
    CONFIRMO_PRODUCAO=sim GCLOUD_BIN="${fixture}/gcloud" WRITES_FIXTURE="${fixture}/writes" \
    SCENARIO="$1" bash "$script"
}

if saida="$(rodar denied 2>&1)" || [[ -s "${fixture}/writes" ]]; then
  printf 'FALHA: erro de listagem deve abortar antes de habilitar a API\n%s\n' "$saida" >&2
  exit 1
fi
printf 'ok    falha de listagem não habilita API\n'

rodar enabled >/dev/null
[[ ! -s "${fixture}/writes" ]]
printf 'ok    API já habilitada é preservada\n'

rodar absent >/dev/null
[[ "$(cat "${fixture}/writes")" = 'enable compute.googleapis.com' ]]
printf 'ok    apenas ausência confirmada habilita a API\n'
