#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-dev.sh"
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/writes"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
readable() {
  if [[ "$SCENARIO" = "$1" ]]; then echo "PERMISSION_DENIED simulado: $1" >&2; exit 1; fi
}
case "$1 $2" in
  'auth list') echo runner@example.test; exit ;;
  'projects describe') echo "$PROJECT_ID"; exit ;;
  'billing projects') printf 'True\r\n'; exit ;;
  'services list')
    readable apis_denied
    printf '%s\r\n' run.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com \
      secretmanager.googleapis.com storage.googleapis.com artifactregistry.googleapis.com \
      cloudbuild.googleapis.com logging.googleapis.com
    exit
    ;;
  'secrets list'|'secrets describe')
    readable secrets_denied
    if [[ "$2" = describe ]]; then exit 0; fi
    printf '%s\r\n' SUPABASE_SERVICE_ROLE_KEY MERCADO_LIVRE_CLIENT_SECRET ML_TOKEN_ENCRYPTION_KEY
    if [[ "$SCENARIO" != missing_secret ]]; then printf '%s\r\n' ANTHROPIC_API_KEY; fi
    exit
    ;;
  'secrets add-iam-policy-binding')
    printf 'secret-binding %s\n' "$3" >> "$WRITES_FIXTURE"
    exit
    ;;
esac
case "$1 $2 $3" in
  'artifacts repositories list'|'artifacts repositories describe')
    readable artifact_denied
    if [[ "$SCENARIO" = partial ]]; then printf 'speedbikers-v3-copia\r\n'
    else printf 'speedbikers-v3\r\n'; fi
    ;;
  'iam service-accounts list'|'iam service-accounts describe')
    readable iam_denied
    for sa in v3-api-runtime v3-worker-runtime v3-tasks-invoker v3-scheduler-invoker; do
      if [[ "$SCENARIO" = partial && "$sa" = v3-worker-runtime ]]; then continue; fi
      printf '%s@%s.iam.gserviceaccount.com\r\n' "$sa" "$PROJECT_ID"
    done
    ;;
  'artifacts repositories create') printf 'create-repo %s\n' "$4" >> "$WRITES_FIXTURE" ;;
  'iam service-accounts create') printf 'create-account %s\n' "$4" >> "$WRITES_FIXTURE" ;;
  'iam service-accounts add-iam-policy-binding') printf 'act-as %s\n' "$4" >> "$WRITES_FIXTURE" ;;
  *) echo "Comando inesperado: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${fixture}/gcloud"

rodar() {
  local scenario="$1"
  shift
  : > "${fixture}/writes"
  env -i PATH="$PATH" PROJECT_ID=speedbikers-gestao-v3 GCLOUD_BIN="${fixture}/gcloud" \
    WRITES_FIXTURE="${fixture}/writes" SCENARIO="$scenario" "$@" bash "$script"
}

for scenario in apis_denied artifact_denied iam_denied secrets_denied; do
  if saida="$(rodar "$scenario" 2>&1)" || [[ -s "${fixture}/writes" ]] || [[ "$saida" != *'Não foi possível listar'* ]]; then
    printf 'FALHA: %s deve abortar com diagnóstico antes de criar ou conceder IAM\n%s\n' "$scenario" "$saida" >&2
    exit 1
  fi
  printf 'ok    %s aborta antes de alterar recursos\n' "$scenario"
done

rodar existing >/dev/null
[[ "$(grep -c '^act-as ' "${fixture}/writes")" = 2 ]]
[[ "$(grep -c '^secret-binding ' "${fixture}/writes")" = 7 ]]
if grep -q '^create-' "${fixture}/writes"; then exit 1; fi
printf 'ok    recursos existentes são reutilizados com os bindings esperados\n'

rodar partial >/dev/null
[[ "$(grep '^create-' "${fixture}/writes")" = $'create-repo speedbikers-v3\ncreate-account v3-worker-runtime' ]]
printf 'ok    retomada cria só o repositório e a conta ausentes\n'

saida="$(rodar missing_secret 2>&1)"
[[ "$saida" = *'AVISO: ANTHROPIC_API_KEY ainda não existe'* ]]
if grep -q 'secret-binding ANTHROPIC_API_KEY' "${fixture}/writes"; then exit 1; fi
printf 'ok    segredo ausente no Dev mantém aviso e evita binding daquele segredo\n'

if saida="$(rodar missing_secret AMBIENTE=prod PROJECT_ID=speedbikers-prod \
  SUPABASE_PROJECT_REF=sentinel-test-prod SUPABASE_PUBLISHABLE_KEY=fixture-placeholder \
  WEB_ORIGINS=https://example.invalid CONFIRMO_PRODUCAO=sim 2>&1)" ||
  [[ "$saida" != *'segredo(s) ausente(s) em speedbikers-prod: ANTHROPIC_API_KEY'* ]]; then
  printf 'FALHA: segredo ausente deve bloquear a conclusão em produção\n%s\n' "$saida" >&2
  exit 1
fi
printf 'ok    segredo ausente em produção continua bloqueando a conclusão\n'
