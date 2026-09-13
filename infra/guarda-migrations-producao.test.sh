#!/usr/bin/env bash
# A guarda das migrations de produção (D-334), caso a caso.
#
# Cada caso roda a guarda num processo PRÓPRIO e com ambiente limpo (`env -i`):
# `fail` encerra o shell, e uma variável do shell de quem roda o teste não pode
# decidir um caso. Nenhum caso chama a rede.
#
# O ref, o token e a senha de "produção" abaixo são FICTÍCIOS.
#
# Uso: bash infra/guarda-migrations-producao.test.sh

set -uo pipefail

GUARDA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guarda-migrations-producao.sh"
falhas=0

REF_FICTICIO="refproducaoficticio0"
DEV_REF="nmgccyqquwxecqffsidr"

ORIGEM_OK=(
  "REF_DO_WORKFLOW=refs/heads/v3"
  "POLITICA_BRANCH=protegidas"
  "REVISORES=1"
  "CI_CONCLUSAO=success"
  "MIGRATIONS_DEV=success"
)

ALVO_OK=(
  "SUPABASE_PROD_PROJECT_REF=${REF_FICTICIO}"
  "SUPABASE_PROD_ACCESS_TOKEN=token-ficticio-que-nao-pode-vazar"
  "SUPABASE_PROD_DB_PASSWORD=senha-ficticia-que-nao-pode-vazar"
  "CONFIRMACAO=${REF_FICTICIO}"
)

# rodar <modo> <variáveis...> -- imprime a saída e devolve o código da guarda.
rodar() {
  local modo="$1"
  shift
  env -i PATH="${PATH}" "$@" bash "${GUARDA}" "${modo}" 2>&1
}

passa() {
  local nome="$1" modo="$2" esperado="$3"
  shift 3

  local saida
  saida="$(rodar "${modo}" "$@")"
  local codigo=$?

  if [ "${codigo}" -eq 0 ] && printf '%s' "${saida}" | grep -qF "${esperado}"; then
    printf 'ok    %s\n' "${nome}"
  else
    printf 'FALHA %s (código %s)\n%s\n' "${nome}" "${codigo}" "${saida}"
    falhas=$((falhas + 1))
  fi
}

recusa() {
  local nome="$1" modo="$2" mensagem="$3"
  shift 3

  local saida
  saida="$(rodar "${modo}" "$@")"
  local codigo=$?

  if [ "${codigo}" -ne 0 ] && printf '%s' "${saida}" | grep -qF "${mensagem}"; then
    printf 'ok    %s\n' "${nome}"
  else
    printf 'FALHA %s (código %s — devia recusar com "%s")\n%s\n' "${nome}" "${codigo}" "${mensagem}" "${saida}"
    falhas=$((falhas + 1))
  fi
}

# --- origem: o caminho feliz
passa "origem completa" origem "as mesmas migrations já aplicadas no Dev" "${ORIGEM_OK[@]}"
passa "origem com política de branch personalizada" origem "restrito a branches (personalizada)" "${ORIGEM_OK[@]}" "POLITICA_BRANCH=personalizada"

# --- origem: de onde veio o disparo
recusa "origem sem nenhuma variável" origem "só rodam a partir da v3"
recusa "disparo a partir da main" origem "só rodam a partir da v3" "${ORIGEM_OK[@]}" "REF_DO_WORKFLOW=refs/heads/main"
recusa "disparo a partir de outra branch" origem "só rodam a partir da v3" "${ORIGEM_OK[@]}" "REF_DO_WORKFLOW=refs/heads/v3-experimento"

# --- origem: o ambiente é a trava de verdade
recusa "ambiente inexistente" origem "não existe no repositório" "${ORIGEM_OK[@]}" "POLITICA_BRANCH=ausente" "REVISORES=0"
recusa "ambiente aceitando qualquer branch" origem "aceita qualquer branch" "${ORIGEM_OK[@]}" "POLITICA_BRANCH=nenhuma"
recusa "ambiente sem revisor" origem "sem revisor obrigatório" "${ORIGEM_OK[@]}" "REVISORES=0"
recusa "revisores ilegível" origem "sem revisor obrigatório" "${ORIGEM_OK[@]}" "REVISORES=null"

# --- origem: o commit
recusa "CI falhou" origem "A CI deste commit na v3 não passou" "${ORIGEM_OK[@]}" "CI_CONCLUSAO=failure"
recusa "CI ainda rodando" origem "A CI deste commit na v3 não passou" "${ORIGEM_OK[@]}" "CI_CONCLUSAO=pendente"
recusa "commit sem CI" origem "A CI deste commit na v3 não passou" "${ORIGEM_OK[@]}" "CI_CONCLUSAO=ausente"
recusa "Dev não migrado" origem "não foram aplicadas no Dev" "${ORIGEM_OK[@]}" "MIGRATIONS_DEV=skipped"

# --- alvo: o caminho feliz, sem vazar segredo
passa "alvo completo" alvo "confirmação confere: ${REF_FICTICIO}" "${ALVO_OK[@]}"

saida_alvo="$(rodar alvo "${ALVO_OK[@]}")"
if printf '%s' "${saida_alvo}" | grep -qE "token-ficticio|senha-ficticia"; then
  printf 'FALHA a guarda imprimiu token ou senha\n%s\n' "${saida_alvo}"
  falhas=$((falhas + 1))
else
  printf 'ok    %s\n' "a guarda não imprime token nem senha"
fi

# --- alvo: segredo ausente não cai no valor do Dev
recusa "alvo sem token" alvo "SUPABASE_PROD_ACCESS_TOKEN" "${ALVO_OK[@]}" "SUPABASE_PROD_ACCESS_TOKEN="
recusa "alvo sem senha" alvo "SUPABASE_PROD_DB_PASSWORD" "${ALVO_OK[@]}" "SUPABASE_PROD_DB_PASSWORD="
recusa "alvo sem ref" alvo "Falta a variável SUPABASE_PROD_PROJECT_REF" "${ALVO_OK[@]}" "SUPABASE_PROD_PROJECT_REF="

# --- alvo: o ref
recusa "ref colado como URL" alvo "não parece um ref" "${ALVO_OK[@]}" "SUPABASE_PROD_PROJECT_REF=https://${REF_FICTICIO}.supabase.co"
recusa "ref curto" alvo "tem 7 caracteres" "${ALVO_OK[@]}" "SUPABASE_PROD_PROJECT_REF=refcurt" "CONFIRMACAO=refcurt"
recusa "ref do Dev" alvo "é o Supabase do Dev" "${ALVO_OK[@]}" "SUPABASE_PROD_PROJECT_REF=${DEV_REF}" "CONFIRMACAO=${DEV_REF}"

# --- alvo: a confirmação digitada
recusa "confirmação diferente" alvo "não confere" "${ALVO_OK[@]}" "CONFIRMACAO=outrorefdeprojeto000"
recusa "confirmação vazia" alvo "não confere" "${ALVO_OK[@]}" "CONFIRMACAO="

# --- modo
recusa "modo desconhecido" aplicar "Modo 'aplicar' não existe"

if [ "${falhas}" -eq 0 ]; then
  printf '\nguarda-migrations-producao.test.sh: todos os casos passaram\n'
else
  printf '\nguarda-migrations-producao.test.sh: %s caso(s) falharam\n' "${falhas}" >&2
  exit 1
fi
