#!/usr/bin/env bash
# A regra de build da Vercel (apps/web/scripts/vercel-ignore.sh), caso a caso.
# Lembrete: 0 = PULA, 1 = CONSTROI.
#
# Uso: bash apps/web/scripts/vercel-ignore.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vercel-ignore.sh"
PROD="prj_P0cBsZLO50eoZ2OIbjFP0vqV9k6p"
DEV="prj_outro_projeto_qualquer"
falhas=0

# caso <nome> <codigo esperado> <variaveis...>
caso() {
  local nome="$1" esperado="$2"
  shift 2
  env -i PATH="${PATH}" "$@" sh "${SCRIPT}" >/dev/null 2>&1
  local codigo=$?
  if [ "${codigo}" -eq "${esperado}" ]; then
    printf 'ok    %s\n' "${nome}"
  else
    printf 'FALHA %s (esperado %s, veio %s)\n' "${nome}" "${esperado}" "${codigo}"
    falhas=$((falhas + 1))
  fi
}

# O que PULA: so previa de feature no projeto de producao.
caso "producao, previa de feature: pula" 0 \
  VERCEL_PROJECT_ID="${PROD}" VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=feat/qualquer-coisa

# O que CONSTROI no projeto de producao.
caso "producao, previa da guardas: constroi (e a que o dono promove)" 1 \
  VERCEL_PROJECT_ID="${PROD}" VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=fix/guardas-prod-d348
caso "producao, previa da v3: constroi" 1 \
  VERCEL_PROJECT_ID="${PROD}" VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=v3
caso "producao, deploy de producao: constroi" 1 \
  VERCEL_PROJECT_ID="${PROD}" VERCEL_ENV=production VERCEL_GIT_COMMIT_REF=feat/qualquer-coisa
caso "producao, previa sem branch (deploy pela CLI): constroi" 1 \
  VERCEL_PROJECT_ID="${PROD}" VERCEL_ENV=preview

# Nome parecido nao passa por igual.
caso "producao, branch com prefixo da guardas: pula" 0 \
  VERCEL_PROJECT_ID="${PROD}" VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=fix/guardas-prod-d348-x
caso "producao, branch que so contem v3: pula" 0 \
  VERCEL_PROJECT_ID="${PROD}" VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=feat/v3

# Outro projeto (o Dev): sempre constroi.
caso "Dev, previa de feature: constroi" 1 \
  VERCEL_PROJECT_ID="${DEV}" VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=feat/qualquer-coisa

# Falha aberta: sem as variaveis de sistema, constroi como antes.
caso "sem variavel nenhuma: constroi" 1
caso "sem o id do projeto: constroi" 1 \
  VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=feat/qualquer-coisa

if [ "${falhas}" -gt 0 ]; then
  printf '\n%s caso(s) falharam\n' "${falhas}"
  exit 1
fi
printf '\ntodos os casos passaram\n'
