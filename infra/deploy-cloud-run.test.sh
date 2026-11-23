#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/build-args" "${fixture}/deploy-args" "${fixture}/git" "${fixture}/.env.deploy.yaml"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "$1 $2" in
  'auth list') echo runner@example.test ;;
  'projects describe') echo speedbikers-gestao-v3 ;;
  'secrets list')
    case "${PUSH_INVENTORY:-unexpected}" in
      denied) echo 'PERMISSION_DENIED simulado' >&2; exit 1 ;;
      present) printf 'SHOPEE_TEST_PUSH_PARTNER_KEY\r\n' ;;
      missing) printf 'SHOPEE_TEST_PUSH_PARTNER_KEY-copia\r\n' ;;
      *) exit 1 ;;
    esac
    ;;
  'secrets describe')
    [[ "${PUSH_INVENTORY:-}" = present ]]
    ;;
  'run services') printf 'https://service.example.invalid\r\n' ;;
  'run deploy')
    printf '%s\n' "$@" > "${DEPLOY_ARGS_FIXTURE}"
    exit 43
    ;;
  'builds submit')
    printf '%s\n' "$@" > "${BUILD_ARGS_FIXTURE}"
    # Só os testes da montagem da chave seguem até o deploy simulado.
    if [ "${PUSH_INVENTORY:-}" = present ] || [ "${PUSH_INVENTORY:-}" = missing ]; then exit 0; fi
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

cat > "${fixture}/git" <<'SH'
#!/usr/bin/env bash
case "$1" in
  rev-parse) echo 0123456 ;;
  status) ;;
  *) exit 1 ;;
esac
SH
chmod +x "${fixture}/git"
script="$PWD/infra/deploy-cloud-run.sh"

rodar_push() (
  local_inventory="$1"
  shift
  : > "${fixture}/build-args"
  : > "${fixture}/deploy-args"
  cd "${fixture}"
  env -i PATH="${fixture}:$PATH" GCLOUD_BIN="${fixture}/gcloud" MERCADO_LIVRE_CLIENT_ID=123 \
    SHOPEE_PARTNER_ID=456 PUSH_INVENTORY="$local_inventory" BUILD_ARGS_FIXTURE="${fixture}/build-args" \
    DEPLOY_ARGS_FIXTURE="${fixture}/deploy-args" bash "$script" "$@"
)

for target in api both; do
  args=("$target")
  if [[ "$target" = both ]]; then args=(); fi
  if saida="$(rodar_push denied "${args[@]}" 2>&1)" || [[ -s "${fixture}/build-args" ]] || [[ "$saida" != *'PERMISSION_DENIED simulado'* ]]; then
    printf 'FALHA: %s deve abortar antes do build quando a lista de segredos falha\n%s\n' "$target" "$saida" >&2
    exit 1
  fi
done
printf 'ok    erro ao listar segredos aborta antes de build isolado ou combinado\n'

codigo=0
rodar_push denied worker >/dev/null || codigo=$?
[[ "$codigo" = 42 && -s "${fixture}/build-args" && ! -s "${fixture}/deploy-args" ]]
printf 'ok    worker isolado não depende da chave de push da API
'

for inventory in present missing; do
  codigo=0
  rodar_push "$inventory" api >/dev/null || codigo=$?
  [[ "$codigo" = 43 && -s "${fixture}/build-args" ]]
  if [[ "$inventory" = present ]]; then
    grep -Fq 'SHOPEE_PUSH_PARTNER_KEY=SHOPEE_TEST_PUSH_PARTNER_KEY:latest' "${fixture}/deploy-args"
  elif grep -Fq 'SHOPEE_PUSH_PARTNER_KEY=' "${fixture}/deploy-args"; then
    echo 'FALHA: nome semelhante não deve ativar o segredo de push' >&2
    exit 1
  fi
done
printf 'ok    somente o segredo confirmado entra na revisão simulada\n'
