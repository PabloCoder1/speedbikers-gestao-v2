#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/build-args" "${fixture}/deploy-args" "${fixture}/git" "${fixture}/.env.deploy.yaml" "${fixture}/nested-args" "${fixture}/nested-build"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "$1 $2" in
  'auth list') echo runner@example.test ;;
  'projects describe') echo speedbikers-gestao-v3 ;;
  'secrets list')
    case "${SMTP_FIXTURE:-}" in
      required|full|disabled) printf 'SMTP_HOST\r\nSMTP_USER\r\nSMTP_PASSWORD\r\n' ;;
      incomplete) printf 'SMTP_HOST\r\nSMTP_USER\r\nSMTP_PASSWORD-copy\r\n' ;;
    esac
    if [[ "${SMTP_FIXTURE:-}" = full ]]; then printf 'SMTP_PORT\r\nALERT_EMAIL_FROM\r\n'; fi
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
  'secrets versions')
    [[ "$3 $4" = 'describe latest' && "$6" = "--format=csv[no-heading](name.basename(),state)" ]]
    if [[ "$5" = --secret=SMTP_PASSWORD && "${SMTP_FIXTURE:-}" = disabled ]]; then
      printf '7,DISABLED\r\n'
    else
      printf '7,ENABLED\r\n'
    fi
    ;;
  'run services')
    inventory="${RUN_INVENTORY:-existing}"
    if [[ "$inventory" = denied ]]; then echo 'PERMISSION_DENIED Cloud Run simulado' >&2; exit 1; fi
    case "$3" in
      list)
        case "$inventory" in
          existing|success|binding_denied|displaced|tagged) printf 'api\thttps://api.example.invalid\r\nworker\thttps://worker.example.invalid\r\n' ;;
          api_missing) printf 'worker\thttps://worker.example.invalid\r\n' ;;
          worker_missing) printf 'api\thttps://api.example.invalid\r\n' ;;
          worker_pending) printf 'worker\t\r\n' ;;
          empty) ;;
          combined)
            if grep -Fxq worker "${DEPLOY_ARGS_FIXTURE}"; then
              printf 'worker\thttps://worker.example.invalid\r\n'
            fi
            ;;
          *) exit 1 ;;
        esac
        ;;
      add-iam-policy-binding)
        if [[ "$inventory" = binding_denied ]]; then echo 'PERMISSION_DENIED no binding simulado' >&2; exit 1; fi
        ;;
      describe)
        case "$*" in
          *env.name*)
            if [[ "${SMTP_FIXTURE:-}" = deployed ]]; then printf 'SMTP_PASSWORD\r\n'; fi
            ;;
          *latestCreatedRevisionName*) echo worker-00001-fixture ;;
          *status.traffic*)
            suffix="$(sed -n 's/^--revision-suffix=//p' "${DEPLOY_ARGS_FIXTURE}")"
            revision=worker-00001-fixture
            if [[ -n "$suffix" ]]; then revision="$4-$suffix"; fi
            case "$inventory" in
              displaced) printf 'worker-00001-fixture,100\r\n' ;;
              tagged) printf '%s,100\r\n%s,0\r\n' "$revision" "$revision" ;;
              *) printf '%s,100\r\n' "${revision%-}" ;;
            esac
            ;;
          *--format=*) printf 'https://worker.example.invalid
' ;;
          *) if [[ "$inventory" = binding_denied ]]; then echo 'PERMISSION_DENIED no describe simulado' >&2; exit 1; fi ;;
        esac
        ;;
      *) exit 1 ;;
    esac
    ;;
  'run deploy')
    printf '%s\n' "$@" > "${DEPLOY_ARGS_FIXTURE}"
    if [[ "$3" = api ]]; then
      while [[ "$1" != --env-vars-file ]]; do shift; done
      config="$2"
      grep -E '^(API_URL|WORKER_URL):' "$config" >> "${DEPLOY_ARGS_FIXTURE}"
      if [[ -n "${NESTED_DEPLOY_SCRIPT:-}" ]]; then
        nested=0
        NESTED_DEPLOY_SCRIPT='' DEPLOY_ARGS_FIXTURE="$PWD/nested-args" BUILD_ARGS_FIXTURE="$PWD/nested-build" \
          bash "$NESTED_DEPLOY_SCRIPT" api >/dev/null || nested=$?
        [[ "$nested" = 43 && -f "$config" ]]
      fi
    fi
    if [[ "${RUN_INVENTORY:-}" = combined && "$3" = worker ]]; then exit 0; fi
    case "${RUN_INVENTORY:-}" in success|binding_denied|displaced|tagged) exit 0 ;; esac
    exit 43
    ;;
  'builds submit')
    printf '%s\n' "$@" >> "${BUILD_ARGS_FIXTURE}"
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
    MARGIN_ALERT_EMAIL_ENABLED="${MARGIN_ALERT_EMAIL_ENABLED:-}" SMTP_FIXTURE="${SMTP_FIXTURE:-}" \
    NESTED_DEPLOY_SCRIPT="${NESTED_DEPLOY_SCRIPT:-}" \
    RUN_INVENTORY="${RUN_INVENTORY:-existing}" DEPLOY_ARGS_FIXTURE="${fixture}/deploy-args" bash "$script" "$@"
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

for smtp_fixture in required full; do
  codigo=0
  MARGIN_ALERT_EMAIL_ENABLED=sim SMTP_FIXTURE="$smtp_fixture" rodar_push present worker >/dev/null || codigo=$?
  [[ "$codigo" = 43 ]]
  grep -Fq 'WEB_APP_URL=http://localhost:3000' "${fixture}/deploy-args"
  grep -Fq 'SMTP_HOST=SMTP_HOST:7,SMTP_USER=SMTP_USER:7,SMTP_PASSWORD=SMTP_PASSWORD:7' "${fixture}/deploy-args"
  if [[ "$smtp_fixture" = full ]]; then
    grep -Fq 'SMTP_PORT=SMTP_PORT:7,ALERT_EMAIL_FROM=ALERT_EMAIL_FROM:7' "${fixture}/deploy-args"
  else
    if grep -Eq 'SMTP_PORT=|ALERT_EMAIL_FROM=' "${fixture}/deploy-args"; then exit 1; fi
  fi
done
printf 'ok    worker fixa versões SMTP e aceita o padrão sem porta ou remetente\n'

for target in worker api; do
  enabled=nao
  if [[ "$target" = api ]]; then enabled=sim; fi
  codigo=0
  MARGIN_ALERT_EMAIL_ENABLED="$enabled" SMTP_FIXTURE=full rodar_push present "$target" >/dev/null || codigo=$?
  [[ "$codigo" = 43 ]]
  if grep -Eq 'SMTP_|ALERT_EMAIL_FROM|WEB_APP_URL' "${fixture}/deploy-args"; then exit 1; fi
done
printf 'ok    SMTP desligado no worker e ausente no deploy isolado da API\n'

if saida="$(SMTP_FIXTURE=deployed rodar_push present worker 2>&1)" ||
  [[ -s "${fixture}/build-args" || "$saida" != *'O worker já tem SMTP'* ]]; then
  printf 'FALHA: configuração SMTP existente exige uma escolha explícita antes do build\n%s\n' "$saida" >&2
  exit 1
fi
printf 'ok    SMTP existente não é removido por omissão da configuração\n'

for smtp_fixture in incomplete disabled; do
  if saida="$(MARGIN_ALERT_EMAIL_ENABLED=sim SMTP_FIXTURE="$smtp_fixture" rodar_push present 2>&1)" ||
    [[ -s "${fixture}/build-args" || -s "${fixture}/deploy-args" || "$saida" != *'SMTP_PASSWORD'* ]]; then
    printf 'FALHA: SMTP %s deve parar antes do build combinado\n%s\n' "$smtp_fixture" "$saida" >&2
    exit 1
  fi
done
printf 'ok    SMTP obrigatório ausente ou desabilitado bloqueia o build combinado\n'

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

for inventory in denied worker_pending worker_missing; do
  if saida="$(RUN_INVENTORY="$inventory" rodar_push missing api 2>&1)" ||
    [[ -s "${fixture}/build-args" || -s "${fixture}/deploy-args" ]]; then
    printf 'FALHA: %s deve abortar antes do build da API\n%s\n' "$inventory" "$saida" >&2
    exit 1
  fi
done
printf 'ok    inventário ilegível, worker ausente e URL pendente bloqueiam o build da API\n'

for target in api worker; do
  inventory=api_missing
  if [[ "$target" = worker ]]; then inventory=empty; fi
  codigo=0
  RUN_INVENTORY="$inventory" rodar_push missing "$target" >/dev/null || codigo=$?
  [[ "$codigo" = 43 && -s "${fixture}/build-args" ]]
  grep -Fq 'https://placeholder.invalid' "${fixture}/deploy-args"
done
printf 'ok    ausência confirmada do próprio serviço preserva o bootstrap em duas etapas\n'

codigo=0
RUN_INVENTORY=combined rodar_push missing >/dev/null || codigo=$?
[[ "$codigo" = 43 ]]
grep -Fq '_APP=worker,' "${fixture}/build-args"
grep -Fq '_APP=api,' "${fixture}/build-args"
grep -Fxq 'WORKER_URL: "https://worker.example.invalid"' "${fixture}/deploy-args"
printf 'ok    deploy combinado relê a URL do worker recém-criado\n'

printf 'arquivo preexistente\n' > "${fixture}/.env.deploy.yaml"
codigo=0
NESTED_DEPLOY_SCRIPT="$script" rodar_push present api >/dev/null || codigo=$?
[[ "$codigo" = 43 ]]
[[ "$(cat "${fixture}/.env.deploy.yaml")" = 'arquivo preexistente' ]]
outer="$(grep -A1 -Fx -- --env-vars-file "${fixture}/deploy-args" | tail -n1)"
inner="$(grep -A1 -Fx -- --env-vars-file "${fixture}/nested-args" | tail -n1)"
[[ "$outer" != "$inner" && ! -e "${fixture}/$outer" && ! -e "${fixture}/$inner" ]]
outer_revision="$(sed -n 's/^--revision-suffix=//p' "${fixture}/deploy-args")"
inner_revision="$(sed -n 's/^--revision-suffix=//p' "${fixture}/nested-args")"
[[ "$outer_revision" =~ ^sentinel-[0-9a-f]{16}$ &&
   "$inner_revision" =~ ^sentinel-[0-9a-f]{16}$ && "$outer_revision" != "$inner_revision" ]]
printf 'ok    execuções sobrepostas isolam e limpam somente seus arquivos de configuração\n'

RUN_INVENTORY=success rodar_push present api >/dev/null
success_file="$(grep -A1 -Fx -- --env-vars-file "${fixture}/deploy-args" | tail -n1)"
[[ -n "$success_file" && ! -e "${fixture}/$success_file" ]]
[[ "$(cat "${fixture}/.env.deploy.yaml")" = 'arquivo preexistente' ]]
printf 'ok    deploy bem-sucedido remove seu temporário e preserva o arquivo preexistente\n'

if saida="$(RUN_INVENTORY=binding_denied rodar_push present api 2>&1)" ||
  [[ "$saida" != *'PERMISSION_DENIED no binding simulado'* || "$saida" = *'== Concluído'* ||
    -s "${fixture}/build-args" || -s "${fixture}/deploy-args" ]]; then
  printf 'FALHA: ausência da confirmação de run.invoker deve impedir sucesso\n%s\n' "$saida" >&2
  exit 1
fi
printf 'ok    erro na concessão de run.invoker impede o build da API isolada\n'

if saida="$(RUN_INVENTORY=binding_denied rodar_push present 2>&1)" ||
  [[ "$saida" != *'PERMISSION_DENIED no binding simulado'* || "$saida" = *'== Concluído'* ]] ||
  ! grep -Fq '_APP=worker,' "${fixture}/build-args" ||
  grep -Fq '_APP=api,' "${fixture}/build-args"; then
  printf 'FALHA: o deploy combinado deve parar no binding do worker\n%s\n' "$saida" >&2
  exit 1
fi
printf 'ok    deploy combinado bloqueia a API se o worker não receber run.invoker\n'

assert_invalid_target() {
  local saida
  if saida="$(rodar_push present "$@" 2>&1)" ||
    [[ "$saida" != *'Uso: bash infra/deploy-cloud-run.sh [api|worker]'* || "$saida" = *'Pré-condições'* ||
       -s "${fixture}/build-args" || -s "${fixture}/deploy-args" ]]; then
    printf 'FALHA: argumento inválido deve ser rejeitado antes de consultar o projeto\n%s\n' "$saida" >&2
    exit 1
  fi
}

assert_invalid_target typo
assert_invalid_target ''
assert_invalid_target api worker
printf 'ok    alvo desconhecido, vazio e argumentos excedentes não chegam ao gcloud\n'

if saida="$(RUN_INVENTORY=displaced rodar_push present worker 2>&1)" ||
  [[ "$saida" != *'serve 0% do tráfego'* || "$saida" = *'== Concluído'* ]]; then
  printf 'FALHA: tráfego de uma revisão concorrente não confirma o deploy atual\n%s\n' "$saida" >&2
  exit 1
fi
printf 'ok    revisão concorrente com 100%% não confirma o deploy atual\n'

RUN_INVENTORY=tagged rodar_push present api >/dev/null
printf 'ok    tráfego zero de uma tag da mesma revisão não apaga a alocação efetiva\n'
