#!/usr/bin/env bash
# Guarda do workflow `.github/workflows/migrations-producao.yml` (D-334).
#
# Até D-334, migration de produção não tinha caminho: o job `migrations` da CI
# faz `supabase link` no ref do Dev, fixo, e o resto seria alguém rodando
# `db push` do próprio computador — sem registro, sem aprovação e sem saber se
# aquele commit passou pela CI ou já foi aplicado no Dev.
#
# Toda a decisão de RECUSAR mora aqui, em bash puro e sem rede, para ser
# testável caso a caso (`infra/guarda-migrations-producao.test.sh`, na CI). O
# workflow só busca os valores na API do GitHub e os passa por variável.
#
# Uso:
#
#   bash infra/guarda-migrations-producao.sh origem
#     REF_DO_WORKFLOW   github.ref do disparo (tem de ser refs/heads/v3)
#     POLITICA_BRANCH   protegidas | personalizada | nenhuma | ausente
#     REVISORES         quantos revisores obrigatórios o ambiente `producao` tem
#     CI_CONCLUSAO      conclusão da CI (push ou dispatch na v3) deste commit
#     MIGRATIONS_DEV    conclusão do job que aplicou as migrations no Dev
#
#   bash infra/guarda-migrations-producao.sh alvo
#     SUPABASE_PROD_PROJECT_REF    variável do ambiente `producao`
#     SUPABASE_PROD_ACCESS_TOKEN   segredo do ambiente `producao`
#     SUPABASE_PROD_DB_PASSWORD    segredo do ambiente `producao`
#     CONFIRMACAO                  o ref digitado por quem disparou
#
# Os nomes têm `PROD` de propósito: os segredos do REPOSITÓRIO também chegam a
# um job com ambiente, e `SUPABASE_DB_PASSWORD` é a senha do Dev. Um segredo de
# produção esquecido não pode cair, em silêncio, no valor do Dev.

set -euo pipefail

fail() { printf '\n[ERRO] %s\n' "$*" >&2; exit 1; }
ok()   { printf '  [ok] %s\n' "$*"; }

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# O ref do Dev vem de lib.sh, que já é a fonte dele para os scripts de infra.
# Num bash isolado: lib.sh encerra quem o carrega se o ambiente estiver errado.
DEV_SUPABASE_PROJECT_REF="$(
  env -i PATH="${PATH}" GCLOUD_BIN=true bash -c \
    'source "$1"; printf "%s" "${DEV_SUPABASE_PROJECT_REF}"' _ "${LIB}"
)"
[ -n "${DEV_SUPABASE_PROJECT_REF}" ] || fail "Não consegui ler o ref do Dev em ${LIB}."

origem() {
  [ "${REF_DO_WORKFLOW:-}" = "refs/heads/v3" ] ||
    fail "As migrations de produção só rodam a partir da v3 (o disparo veio de '${REF_DO_WORKFLOW:-}')."
  ok "disparo a partir da v3"

  case "${POLITICA_BRANCH:-}" in
    ausente)
      fail "O ambiente 'producao' não existe no repositório. Crie-o com revisor obrigatório e restrição de branch antes (DEPLOYMENT.md 8.2)." ;;
    protegidas | personalizada) ;;
    *)
      fail "O ambiente 'producao' aceita qualquer branch ('${POLITICA_BRANCH:-}'). Um workflow alterado noutra branch receberia os segredos de produção sem passar por esta guarda." ;;
  esac
  ok "ambiente restrito a branches (${POLITICA_BRANCH})"

  case "${REVISORES:-}" in
    '' | *[!0-9]*) REVISORES=0 ;;
  esac
  [ "${REVISORES}" -ge 1 ] ||
    fail "O ambiente 'producao' está sem revisor obrigatório. Sem ele, qualquer disparo aplica migration em produção sem ninguém aprovar."
  ok "ambiente com ${REVISORES} revisor(es) obrigatório(s)"

  [ "${CI_CONCLUSAO:-}" = "success" ] ||
    fail "A CI deste commit na v3 não passou (conclusão: '${CI_CONCLUSAO:-}'). Migration de código que não passou na esteira não vai para produção."
  ok "CI deste commit verde"

  [ "${MIGRATIONS_DEV:-}" = "success" ] ||
    fail "As migrations deste commit não foram aplicadas no Dev (conclusão: '${MIGRATIONS_DEV:-}'). Produção só recebe o que o Dev já recebeu."
  ok "as mesmas migrations já aplicadas no Dev"
}

alvo() {
  [ -n "${SUPABASE_PROD_ACCESS_TOKEN:-}" ] ||
    fail "Falta o segredo SUPABASE_PROD_ACCESS_TOKEN no ambiente 'producao'."
  [ -n "${SUPABASE_PROD_DB_PASSWORD:-}" ] ||
    fail "Falta o segredo SUPABASE_PROD_DB_PASSWORD no ambiente 'producao'."
  [ -n "${SUPABASE_PROD_PROJECT_REF:-}" ] ||
    fail "Falta a variável SUPABASE_PROD_PROJECT_REF no ambiente 'producao'."
  ok "segredos e variável de produção presentes"

  case "${SUPABASE_PROD_PROJECT_REF}" in
    *[!a-z0-9]*)
      fail "SUPABASE_PROD_PROJECT_REF não parece um ref do Supabase (só letras minúsculas e dígitos, como em <ref>.supabase.co)." ;;
  esac
  [ "${#SUPABASE_PROD_PROJECT_REF}" -eq 20 ] ||
    fail "SUPABASE_PROD_PROJECT_REF não parece um ref do Supabase (tem ${#SUPABASE_PROD_PROJECT_REF} caracteres; um ref tem 20)."

  [ "${SUPABASE_PROD_PROJECT_REF}" != "${DEV_SUPABASE_PROJECT_REF}" ] ||
    fail "SUPABASE_PROD_PROJECT_REF é o Supabase do Dev (${DEV_SUPABASE_PROJECT_REF}). O ambiente 'producao' está configurado errado."
  ok "alvo não é o Dev"

  [ "${CONFIRMACAO:-}" = "${SUPABASE_PROD_PROJECT_REF}" ] ||
    fail "A confirmação digitada ('${CONFIRMACAO:-}') não confere com o ref do ambiente 'producao' (${SUPABASE_PROD_PROJECT_REF})."
  ok "confirmação confere: ${SUPABASE_PROD_PROJECT_REF}"
}

case "${1:-}" in
  origem) origem ;;
  alvo) alvo ;;
  *) fail "Modo '${1:-}' não existe. Use origem ou alvo." ;;
esac
