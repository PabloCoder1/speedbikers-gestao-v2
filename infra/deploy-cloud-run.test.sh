#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/build-args"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "$1 $2" in
  'auth list') echo runner@example.test ;;
  'projects describe') echo speedbikers-gestao-v3 ;;
  'builds submit')
    printf '%s\n' "$@" > "${BUILD_ARGS_FIXTURE}"
    # Interrompe antes de qualquer chamada ao Cloud Run.
    exit 42 ;;
  *) echo "Comando inesperado: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${fixture}/gcloud"

capturar_build() {
  local codigo=0
  : > "${fixture}/build-args"
  env -i PATH="${PATH}" GCLOUD_BIN="${fixture}/gcloud" MERCADO_LIVRE_CLIENT_ID=123 \
    BUILD_ARGS_FIXTURE="${fixture}/build-args" "$@" bash infra/deploy-cloud-run.sh worker >/dev/null || codigo=$?
  [ "${codigo}" -eq 42 ]
  grep -Fxq 'submit' "${fixture}/build-args"
}

identidade='projects/speedbikers-gestao-v3/serviceAccounts/v3-builder@speedbikers-gestao-v3.iam.gserviceaccount.com'
capturar_build "CLOUD_BUILD_SERVICE_ACCOUNT=${identidade}"
if ! grep -Fxq -- "--service-account=${identidade}" "${fixture}/build-args"; then
  printf 'FALHA: o build não recebeu a identidade dedicada\n' >&2
  exit 1
fi
printf 'ok    build recebe a identidade dedicada como um argumento\n'

capturar_build
if grep -q '^--service-account' "${fixture}/build-args"; then
  printf 'FALHA: build sem configuração recebeu uma identidade explícita\n' >&2
  exit 1
fi
printf 'ok    build sem configuração segue a identidade padrão\n'
