#!/usr/bin/env bash
# Variáveis e helpers comuns aos scripts de infraestrutura.
#
# Carregado com `source`, nunca executado direto.

set -euo pipefail

# ---------------------------------------------------------------------------
# Saída — primeiro, porque a guarda de ambiente logo abaixo precisa de `fail`.
# ---------------------------------------------------------------------------

info()  { printf '  %s\n' "$*"; }
step()  { printf '\n== %s\n' "$*"; }
ok()    { printf '  [ok] %s\n' "$*"; }
skip()  { printf '  [ja existe] %s\n' "$*"; }
fail()  { printf '\n[ERRO] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# AMBIENTE (D-333)
#
# Até D-333 este arquivo tinha `PROJECT_ID` sobrescrevível e o Supabase FIXO no
# Dev: `PROJECT_ID=<produção> bash infra/deploy-cloud-run.sh` subiria o Cloud
# Run de produção com `SUPABASE_URL` apontando para o banco do Dev — e a chave
# de service role vinda do Secret Manager do projeto de produção. No melhor
# caso, tudo falhando com chave de outro banco; no pior, produção escrevendo no
# Dev. Nenhum aviso.
#
# Agora o ambiente é EXPLÍCITO:
#
# - `dev` (padrão) mantém exatamente o comportamento de antes, e recusa um
#   `PROJECT_ID` que não seja o do Dev;
# - `prod` NÃO TEM PADRÃO para nada que identifique ambiente — projeto, ref do
#   Supabase, chave publicável e origens do `web` vêm do ambiente, ou o script
#   para — e exige `CONFIRMO_PRODUCAO=sim`, para uma variável esquecida no shell
#   não mandar um deploy para produção por acidente;
# - a guarda recusa MISTURA nos dois sentidos, comparando com os valores do Dev.
#
# `infra/ambiente.test.sh` prova cada caso, e roda na CI.
# ---------------------------------------------------------------------------

# Os identificadores do Dev. Não são segredo — aparecem no dashboard, em
# hostnames públicos e no bundle do navegador. O segredo é a chave de service
# role, que vive no Secret Manager.
DEV_PROJECT_ID="speedbikers-gestao-v3"
DEV_SUPABASE_PROJECT_REF="nmgccyqquwxecqffsidr"
# Chave PUBLICÁVEL — a mesma que `apps/web` embute no bundle do navegador.
DEV_SUPABASE_PUBLISHABLE_KEY="sb_publishable_Ldlp0fb3PrvXn29XZ7cpag_Sqo121xo"
DEV_WEB_ORIGIN="https://speedbikers-gestao-v2-m71j.vercel.app"

AMBIENTE="${AMBIENTE:-dev}"

case "${AMBIENTE}" in
  dev)
    PROJECT_ID="${PROJECT_ID:-${DEV_PROJECT_ID}}"
    SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF:-${DEV_SUPABASE_PROJECT_REF}}"
    SUPABASE_PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-${DEV_SUPABASE_PUBLISHABLE_KEY}}"
    WEB_ORIGINS="${WEB_ORIGINS:-${DEV_WEB_ORIGIN}}"

    [ "${PROJECT_ID}" = "${DEV_PROJECT_ID}" ] ||
      fail "AMBIENTE=dev com PROJECT_ID=${PROJECT_ID}. O Dev é ${DEV_PROJECT_ID}; para outro projeto, use AMBIENTE=prod com os valores dele."
    [ "${SUPABASE_PROJECT_REF}" = "${DEV_SUPABASE_PROJECT_REF}" ] ||
      fail "AMBIENTE=dev com um Supabase que não é o do Dev (${SUPABASE_PROJECT_REF})."
    ;;
  prod)
    [ -n "${PROJECT_ID:-}" ] || fail "AMBIENTE=prod exige PROJECT_ID (sem padrão, de propósito)."
    [ -n "${SUPABASE_PROJECT_REF:-}" ] || fail "AMBIENTE=prod exige SUPABASE_PROJECT_REF do projeto de produção."
    [ -n "${SUPABASE_PUBLISHABLE_KEY:-}" ] || fail "AMBIENTE=prod exige SUPABASE_PUBLISHABLE_KEY do projeto de produção."
    [ -n "${WEB_ORIGINS:-}" ] || fail "AMBIENTE=prod exige WEB_ORIGINS com as origens do web de produção."

    [ "${PROJECT_ID}" != "${DEV_PROJECT_ID}" ] ||
      fail "AMBIENTE=prod apontando para o projeto do Dev (${DEV_PROJECT_ID})."
    [ "${SUPABASE_PROJECT_REF}" != "${DEV_SUPABASE_PROJECT_REF}" ] ||
      fail "AMBIENTE=prod apontando para o Supabase do Dev (${DEV_SUPABASE_PROJECT_REF})."
    [ "${SUPABASE_PUBLISHABLE_KEY}" != "${DEV_SUPABASE_PUBLISHABLE_KEY}" ] ||
      fail "AMBIENTE=prod com a chave publicável do Dev."
    case ",${WEB_ORIGINS}," in
      *"${DEV_WEB_ORIGIN}"*) fail "AMBIENTE=prod com a origem do web do Dev em WEB_ORIGINS (${DEV_WEB_ORIGIN})." ;;
    esac

    [ "${CONFIRMO_PRODUCAO:-}" = "sim" ] ||
      fail "AMBIENTE=prod exige CONFIRMO_PRODUCAO=sim — o gesto a mais que separa um deploy de produção de uma variável esquecida no shell."
    ;;
  *)
    fail "AMBIENTE=${AMBIENTE} não existe. Use dev ou prod."
    ;;
esac

# ---------------------------------------------------------------------------
# FORMATO do WEB_ORIGINS (D-348)
#
# A guarda acima decide QUAL ambiente; esta decide se o valor tem a forma que o
# navegador vai comparar. São problemas diferentes, e o segundo não falhava em
# lugar nenhum: `https://app.exemplo.com/` — uma barra a mais — passa por todas
# as comparações de ambiente, sobe no Cloud Run, e só aparece em produção como
# CORS negado. O navegador envia `Origin: https://app.exemplo.com`, sem barra e
# sem caminho, e a comparação do CORS é igualdade exata de string.
#
# A primeira origem da lista é também para onde o link do convite leva. Uma
# origem errada aqui manda TODO convite para o lugar errado — foi o que
# aconteceu em 2026-09-10, com o Auth caindo no `localhost:3000` do projeto.
#
# `http://` é aceito apenas em `localhost`/`127.0.0.1`, e apenas em `dev`.
# ---------------------------------------------------------------------------

case "${WEB_ORIGINS}" in
  "")    fail "WEB_ORIGINS vazia." ;;
  ,*|*,) fail "WEB_ORIGINS começa ou termina em vírgula: '${WEB_ORIGINS}'. São origens separadas por vírgula, sem vírgula solta na ponta." ;;
  *,,*)  fail "WEB_ORIGINS tem vírgula dupla: '${WEB_ORIGINS}'." ;;
esac

validar_origem() {
  local origem="$1" resto

  case "${origem}" in
    *[[:space:]]*)
      fail "WEB_ORIGINS: a origem '${origem}' tem espaço. Separe as origens por vírgula, sem espaço depois dela." ;;
    */)
      fail "WEB_ORIGINS: a origem '${origem}' termina em barra. O navegador envia 'Origin: esquema://host' sem barra, e a comparação do CORS é igualdade exata." ;;
  esac

  case "${origem}" in
    https://*)
      resto="${origem#https://}"
      ;;
    http://*)
      resto="${origem#http://}"
      case "${AMBIENTE}:${resto}" in
        dev:localhost|dev:localhost:*|dev:127.0.0.1|dev:127.0.0.1:*) ;;
        *) fail "WEB_ORIGINS: a origem '${origem}' usa http://. Só https:// é aceito — http:// apenas em localhost/127.0.0.1, e apenas em AMBIENTE=dev." ;;
      esac
      ;;
    *)
      fail "WEB_ORIGINS: a origem '${origem}' não começa com https://. É a ORIGEM completa, com esquema — não o host sozinho."
      ;;
  esac

  case "${resto}" in
    "")  fail "WEB_ORIGINS: a origem '${origem}' não tem host." ;;
    */*) fail "WEB_ORIGINS: a origem '${origem}' tem caminho. Origem é esquema + host + porta, e para aí." ;;
  esac
}

ORIGENS_WEB=()
IFS=',' read -r -a ORIGENS_WEB <<< "${WEB_ORIGINS}" || true

[ "${#ORIGENS_WEB[@]}" -gt 0 ] || fail "WEB_ORIGINS vazia."

for origem_web in "${ORIGENS_WEB[@]}"; do
  validar_origem "${origem_web}"
done

unset origem_web

REGION="${REGION:-southamerica-east1}"

# Origens do `web` liberadas no CORS de /v1 da api. Allowlist explicita: o
# upload da planilha sai do navegador direto para o Cloud Run, e e o CORS que
# decide de onde ele pode sair. Varias origens separadas por virgula.
# (Resolvida acima, por ambiente; o FORMATO é validado logo acima.)

# Service accounts. Uma identidade por responsabilidade — menor privilégio
# possível, conforme docs/PROMPT_MASTER.md secao 31.
#
# Estes nomes seguem a convenção JÁ EXISTENTE no projeto, criada junto com a
# fundação do Google Cloud. Não inventar nomes novos: identidade duplicada para
# o mesmo papel divide as permissões entre as duas e ninguém descobre qual vale.
# Os nomes são os mesmos em todo ambiente: service account é por PROJETO.
SA_API="v3-api-runtime"
SA_WORKER="v3-worker-runtime"
SA_TASKS="v3-tasks-invoker"
SA_SCHEDULER="v3-scheduler-invoker"

# Supabase do ambiente. O ref e a URL não são segredo; o segredo é a chave de
# service role, no Secret Manager DO PROJETO do ambiente.
SUPABASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"
SECRET_SUPABASE_KEY="SUPABASE_SERVICE_ROLE_KEY"

# A chave publicável é usada pela api desde D-077 (`createUserClient`, `@sb/db`):
# o Copiloto lê sob a RLS do usuário, não com service_role. (Resolvida acima.)

# OAuth do Mercado Livre (D-041, D-046). client_id e redirect_uri NÃO são
# segredo — vão em --set-env-vars, junto dos demais identificadores de
# recurso. client_secret e a chave de cifra dos tokens são segredo de
# verdade e vivem no Secret Manager, como SUPABASE_SERVICE_ROLE_KEY.
MERCADO_LIVRE_CLIENT_ID="${MERCADO_LIVRE_CLIENT_ID:-}"
MERCADO_LIVRE_REDIRECT_URI="${MERCADO_LIVRE_REDIRECT_URI:-}"
SECRET_ML_CLIENT_SECRET="MERCADO_LIVRE_CLIENT_SECRET"
SECRET_ML_TOKEN_KEY="ML_TOKEN_ENCRYPTION_KEY"

# Copiloto (D-082): Claude Haiku 4.5. Só a api consome — o Copiloto roda
# inteiro em apps/api (POST /v1/copilot/query), o worker nunca chama a
# Anthropic. Chave nova, provisionada direto no Secret Manager em
# 2026-08-25 — não reaproveita a ANTHROPIC_API_KEY herdada da V2 (projeto
# Vercel, sem consumidor, validade incerta).
SECRET_ANTHROPIC_KEY="ANTHROPIC_API_KEY"

# Teto mensal de gasto com LLM em USD (D-082/D-100), consumido pelo worker
# (maintenance.check-ai-budget). NÃO é segredo — vai em --set-env-vars.
# Default 18 = R$100/mês a ~5,5 R$/US$ (conversão administrativa fixa,
# documentada em D-100); o envSchema do worker tem o MESMO default, então
# esquecer esta variável não derruba o boot.
AI_MONTHLY_BUDGET_USD="${AI_MONTHLY_BUDGET_USD:-18}"

sa_email() {
  echo "${1}@${PROJECT_ID}.iam.gserviceaccount.com"
}

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

  info "ambiente: ${AMBIENTE}"
  info "projeto: ${PROJECT_ID}"
  info "supabase: ${SUPABASE_PROJECT_REF}"
  info "região: ${REGION}"
}
