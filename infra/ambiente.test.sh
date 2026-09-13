#!/usr/bin/env bash
# A guarda de ambiente de infra/lib.sh (D-333), caso a caso.
#
# Cada caso carrega lib.sh num bash PRÓPRIO — `fail` encerra o shell que o
# carregou, e um caso não pode derrubar o seguinte. `GCLOUD_BIN=true` troca o
# gcloud por um comando que não faz nada: nenhum caso chama a nuvem.
#
# Os valores de "produção" abaixo são FICTÍCIOS.
#
# Uso: bash infra/ambiente.test.sh

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
falhas=0

PROD_OK=(
  "AMBIENTE=prod"
  "PROJECT_ID=projeto-producao-ficticio"
  "SUPABASE_PROJECT_REF=refproducaoficticio00"
  "SUPABASE_PUBLISHABLE_KEY=sb_publishable_ficticio_de_producao"
  "WEB_ORIGINS=https://producao.exemplo.test"
  "CONFIRMO_PRODUCAO=sim"
)

# carregar <variáveis...> -- imprime a saída e devolve o código de saída de um
# bash que só carrega lib.sh e mostra o que resolveu.
carregar() {
  env -i PATH="${PATH}" GCLOUD_BIN=true "$@" bash -c '
    source "$1"
    printf "PROJECT_ID=%s\nSUPABASE_URL=%s\nWEB_ORIGINS=%s\n" "${PROJECT_ID}" "${SUPABASE_URL}" "${WEB_ORIGINS}"
  ' _ "${LIB}" 2>&1
}

passa() {
  local nome="$1" esperado="$2"
  shift 2

  local saida
  saida="$(carregar "$@")"
  local codigo=$?

  if [ "${codigo}" -eq 0 ] && printf '%s' "${saida}" | grep -qF "${esperado}"; then
    printf 'ok    %s\n' "${nome}"
  else
    printf 'FALHA %s (código %s)\n%s\n' "${nome}" "${codigo}" "${saida}"
    falhas=$((falhas + 1))
  fi
}

recusa() {
  local nome="$1" mensagem="$2"
  shift 2

  local saida
  saida="$(carregar "$@")"
  local codigo=$?

  if [ "${codigo}" -ne 0 ] && printf '%s' "${saida}" | grep -qF "${mensagem}"; then
    printf 'ok    %s\n' "${nome}"
  else
    printf 'FALHA %s (código %s — devia recusar com "%s")\n%s\n' "${nome}" "${codigo}" "${mensagem}" "${saida}"
    falhas=$((falhas + 1))
  fi
}

# --- dev: o comportamento de antes, sem nenhuma variável
passa "sem variáveis resolve para o Dev" "SUPABASE_URL=https://nmgccyqquwxecqffsidr.supabase.co"
passa "sem variáveis mantém o projeto do Dev" "PROJECT_ID=speedbikers-gestao-v3"
recusa "dev com outro projeto" "AMBIENTE=dev com PROJECT_ID=" "AMBIENTE=dev" "PROJECT_ID=projeto-producao-ficticio"
recusa "dev com outro Supabase" "AMBIENTE=dev com um Supabase" "SUPABASE_PROJECT_REF=refproducaoficticio00"

# --- prod: nada tem padrão
recusa "prod sem nenhuma variável" "AMBIENTE=prod exige PROJECT_ID" "AMBIENTE=prod"
recusa "prod sem o Supabase" "exige SUPABASE_PROJECT_REF" "AMBIENTE=prod" "PROJECT_ID=projeto-producao-ficticio"
recusa "prod sem confirmação" "exige CONFIRMO_PRODUCAO=sim" "${PROD_OK[@]:0:5}"

# --- prod: mistura com o Dev, nos quatro identificadores
recusa "prod no projeto do Dev" "apontando para o projeto do Dev" "${PROD_OK[@]}" "PROJECT_ID=speedbikers-gestao-v3"
recusa "prod no Supabase do Dev" "apontando para o Supabase do Dev" "${PROD_OK[@]}" "SUPABASE_PROJECT_REF=nmgccyqquwxecqffsidr"
recusa "prod com a chave publicável do Dev" "chave publicável do Dev" "${PROD_OK[@]}" "SUPABASE_PUBLISHABLE_KEY=sb_publishable_Ldlp0fb3PrvXn29XZ7cpag_Sqo121xo"
recusa "prod com a origem do web do Dev" "origem do web do Dev" "${PROD_OK[@]}" "WEB_ORIGINS=https://producao.exemplo.test,https://speedbikers-gestao-v2-m71j.vercel.app"

# --- prod completo e distinto
passa "prod completo resolve o Supabase de produção" "SUPABASE_URL=https://refproducaoficticio00.supabase.co" "${PROD_OK[@]}"

# --- valor que não existe
recusa "ambiente desconhecido" "AMBIENTE=staging não existe" "AMBIENTE=staging"

if [ "${falhas}" -eq 0 ]; then
  printf '\nambiente.test.sh: todos os casos passaram\n'
else
  printf '\nambiente.test.sh: %s caso(s) falharam\n' "${falhas}" >&2
  exit 1
fi
