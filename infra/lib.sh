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
SA_API="sb-api"
SA_WORKER="sb-worker"
SA_TASKS="sb-tasks"

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

  local windows_path="/c/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"

  if [ -x "${windows_path}" ]; then
    echo "${windows_path}"
  elif command -v gcloud >/dev/null 2>&1; then
    command -v gcloud
  else
    fail "gcloud não encontrado. Instale o Google Cloud SDK ou defina GCLOUD_BIN."
  fi
}

GCLOUD="$(resolve_gcloud)"

gc() {
  "${GCLOUD}" "$@" --project "${PROJECT_ID}"
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
  gc projects describe --format='value(projectId)' >/dev/null 2>&1 \
    || fail "Sem acesso ao projeto ${PROJECT_ID}."

  info "projeto: ${PROJECT_ID}"
  info "região: ${REGION}"
}
