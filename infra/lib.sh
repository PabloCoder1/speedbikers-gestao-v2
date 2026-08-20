#!/usr/bin/env bash
# Variáveis e helpers comuns aos scripts de infraestrutura.
#
# Carregado com `source`, nunca executado direto.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constantes do ambiente de desenvolvimento
# ---------------------------------------------------------------------------

PROJECT_ID="${PROJECT_ID:-speedbikers-gestao-v3}"
REGION="${REGION:-southamerica-east1}"

# Service accounts. Uma identidade por responsabilidade — menor privilégio
# possível, conforme docs/PROMPT_MASTER.md secao 31.
#
# Estes nomes seguem a convenção JÁ EXISTENTE no projeto, criada junto com a
# fundação do Google Cloud. Não inventar nomes novos: identidade duplicada para
# o mesmo papel divide as permissões entre as duas e ninguém descobre qual vale.
SA_API="v3-api-runtime"
SA_WORKER="v3-worker-runtime"
SA_TASKS="v3-tasks-invoker"
SA_SCHEDULER="v3-scheduler-invoker"

# Supabase Dev. O ref e a URL não são segredo — aparecem no dashboard e em
# hostnames públicos. O segredo é a chave, que vive no Secret Manager.
SUPABASE_PROJECT_REF="nmgccyqquwxecqffsidr"
SUPABASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"
SECRET_SUPABASE_KEY="SUPABASE_SERVICE_ROLE_KEY"

sa_email() {
  echo "${1}@${PROJECT_ID}.iam.gserviceaccount.com"
}

# ---------------------------------------------------------------------------
# Saída
# ---------------------------------------------------------------------------

info()  { printf '  %s\n' "$*"; }
step()  { printf '\n== %s\n' "$*"; }
ok()    { printf '  [ok] %s\n' "$*"; }
skip()  { printf '  [ja existe] %s\n' "$*"; }
fail()  { printf '\n[ERRO] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# gcloud
#
# Chamado pelo caminho completo do wrapper .cmd no Windows: o wrapper .ps1
# esbarra na política de execução do PowerShell, e o .cmd não.
# ---------------------------------------------------------------------------

resolve_gcloud() {
  if [ -n "${GCLOUD_BIN:-}" ]; then
    echo "${GCLOUD_BIN}"
    return
  fi

  # Preferir o wrapper POSIX (sem extensão) ao `.cmd`.
  #
  # O `.cmd` é interpretado pelo cmd.exe, que trata `>`, `<`, `|`, `&` e a
  # combinação de espaços com `*` como sintaxe — mesmo dentro de aspas. Isso
  # destrói argumentos legítimos, como o cron `"0 * * * *"` do Cloud Scheduler,
  # e a mensagem de erro fala de 'C:\Program', sem relação aparente com a causa.
  #
  # O wrapper POSIX roda direto no Git Bash e não tem essa camada.
  #
  # Testar com -f, não com -x: no MSYS nenhum dos dois carrega bit de execução.
  local candidates=(
    "/c/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin/gcloud"
    "/c/Program Files/Google/Cloud SDK/google-cloud-sdk/bin/gcloud"
    "${LOCALAPPDATA:-}/Google/Cloud SDK/google-cloud-sdk/bin/gcloud"
    "/c/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"
    "/c/Program Files/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "${candidate}" ]; then
      echo "${candidate}"
      return
    fi
  done

  if command -v gcloud >/dev/null 2>&1; then
    command -v gcloud
    return
  fi

  fail "gcloud não encontrado. Instale o Google Cloud SDK ou defina GCLOUD_BIN."
}

GCLOUD="$(resolve_gcloud)"

# Comandos que aceitam o projeto como FLAG.
gc() {
  "${GCLOUD}" "$@" --project "${PROJECT_ID}"
}

# Comandos que recebem o projeto como ARGUMENTO POSICIONAL — `projects
# describe` e `billing projects describe` são os casos. Passar `--project` para
# eles falha com "argument PROJECT_ID_OR_NUMBER: Must be specified", que é
# facilmente confundido com falta de permissão.
gc_positional() {
  local group=("$@")

  "${GCLOUD}" "${group[@]}" "${PROJECT_ID}"
}

# ---------------------------------------------------------------------------
# Pré-condições
# ---------------------------------------------------------------------------

require_auth() {
  local account
  account="$("${GCLOUD}" auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"

  [ -n "${account}" ] || fail "Nenhuma conta autenticada. Rode: gcloud auth login"

  info "conta: ${account}"
}

require_project() {
  local output

  # Nunca descartar stderr numa pré-condição: a mensagem do gcloud é o
  # diagnóstico. Capturar e reexibir em caso de falha.
  if ! output="$(gc_positional projects describe --format='value(projectId)' 2>&1)"; then
    printf '%s\n' "${output}" >&2
    fail "Não foi possível descrever o projeto ${PROJECT_ID}. Mensagem do gcloud acima."
  fi

  info "projeto: ${PROJECT_ID}"
  info "região: ${REGION}"
}
