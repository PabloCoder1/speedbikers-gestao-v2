#!/usr/bin/env bash
# Constrói e publica `apps/api` e `apps/worker` no Cloud Run.
#
# A imagem é construída pelo Cloud Build, não na máquina local: o build roda em
# 4 vCPU na nuvem em vez de disputar os 3 GB do WSL.
#
# Uso:  bash infra/deploy-cloud-run.sh          # api e worker
#       bash infra/deploy-cloud-run.sh api      # só um serviço

source "$(dirname "$0")/lib.sh"

REPO="speedbikers-v3"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"

# Tag pelo commit: dá para responder "qual código está no ar" sem adivinhar.
TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  TAG="${TAG}-dirty"
fi

service_url() {
  gc run services describe "$1" --region "${REGION}" --format='value(status.url)' 2>/dev/null || true
}

build_and_deploy() {
  local app="$1"
  local image="${REGISTRY}/${app}:${TAG}"

  step "Build da imagem: ${app}"
  info "${image}"
  gc builds submit \
    --config infra/cloudbuild.yaml \
    --substitutions "_APP=${app},_IMAGE=${image}" \
    .

  step "Deploy: ${app}"

  # Os dois serviços chamam o Mercado Livre (api troca o code; worker renova
  # com refresh_token) — checar aqui, para os DOIS ramos, e não só dentro do
  # `if [ "${app}" = "api" ]`. É exatamente o tipo de vácuo que já causou
  # incidente real neste projeto: ERP_IMPORTS_BUCKET setada só no ramo da api
  # deixou o worker subir sem a variável, falhando em silêncio até alguém ler
  # o Cloud Logging (ver docs/HANDOFF.md, achado registrado nesta sessão).
  [ -n "${MERCADO_LIVRE_CLIENT_ID}" ] || fail "MERCADO_LIVRE_CLIENT_ID não definida. Ver .env.example."

  if [ "${app}" = "api" ]; then
    # A api precisa conhecer a própria URL (audience do OIDC) e a do worker.
    # Ambas são estáveis por serviço; na primeira criação a de si mesma ainda
    # não existe, então o deploy roda em duas fases.
    local api_url worker_url
    api_url="$(service_url api)"
    worker_url="$(service_url worker)"

    # URL vazia viraria variável vazia no container, o Zod recusaria no boot e
    # o Cloud Run reportaria apenas "failed to start" — erro caro de diagnosticar.
    # Falhar aqui, com a causa explícita, custa muito menos.
    [ -n "${worker_url}" ] || fail "worker ainda não existe. Rode: bash infra/deploy-cloud-run.sh worker"

    if [ -z "${api_url}" ]; then
      info "api ainda não existe; primeiro deploy define a URL e o segundo a injeta"
      api_url="https://placeholder.invalid"
    fi

    # Precisa bater exatamente com o cadastrado no painel de aplicações do
    # Mercado Livre. Vazio antes do primeiro cadastro é aceitável no
    # placeholder acima; falhar aqui de verdade quando a api_url real existir
    # e a variável ainda não tiver sido configurada.
    local ml_redirect_uri="${MERCADO_LIVRE_REDIRECT_URI:-${api_url}/oauth/mercado-livre/callback}"

    # Arquivo em vez de `--set-env-vars`: no Windows o wrapper gcloud.cmd é
    # interpretado pelo cmd, que trata `^` como escape e engole o delimitador.
    # O arquivo elimina a camada de quoting inteira.
    #
    # Nenhum segredo aqui — só identificadores de recurso. Segredo vai para o
    # Secret Manager (docs/DEPLOYMENT.md secao 5).
    # Caminho no diretório do repositório, não em /tmp: o gcloud.cmd é um
    # programa Windows nativo e não entende o caminho MSYS `/tmp/...`.
    # O nome casa com `.env.*` do .gitignore, então não há risco de versionar.
    local env_file=".env.deploy.yaml"
    trap 'rm -f "${env_file}"' RETURN

    cat > "${env_file}" <<YAML
NODE_ENV: production
GCP_PROJECT_ID: "${PROJECT_ID}"
GCP_REGION: "${REGION}"
WORKER_URL: "${worker_url}"
API_URL: "${api_url}"
TASKS_INVOKER_SERVICE_ACCOUNT: "$(sa_email "${SA_TASKS}")"
SCHEDULER_INVOKER_SERVICE_ACCOUNT: "$(sa_email "${SA_SCHEDULER}")"
SUPABASE_URL: "${SUPABASE_URL}"
ERP_IMPORTS_BUCKET: "${PROJECT_ID}-erp-imports"
WEB_ORIGINS: "${WEB_ORIGINS}"
MERCADO_LIVRE_CLIENT_ID: "${MERCADO_LIVRE_CLIENT_ID}"
MERCADO_LIVRE_REDIRECT_URI: "${ml_redirect_uri}"
YAML

    # A `api` é superfície pública: o webhook do Mercado Livre precisa alcançá-la
    # e não envia credencial do Google. A autenticação é própria da rota
    # (docs/API.md secao 2).
    #
    # min-instances=1 não é otimização prematura: cold start atrasa o ACK do
    # webhook e provoca reentrega.
    gc run deploy "${app}" \
      --image "${image}" \
      --region "${REGION}" \
      --service-account "$(sa_email "${SA_API}")" \
      --allow-unauthenticated \
      --min-instances 1 \
      --max-instances 10 \
      --concurrency 80 \
      --timeout 60s \
      --cpu 1 --memory 512Mi \
      --env-vars-file "${env_file}" \
      --set-secrets "SUPABASE_SERVICE_ROLE_KEY=${SECRET_SUPABASE_KEY}:latest,MERCADO_LIVRE_CLIENT_SECRET=${SECRET_ML_CLIENT_SECRET}:latest,ML_TOKEN_ENCRYPTION_KEY=${SECRET_ML_TOKEN_KEY}:latest" \
      --quiet
  else
    # O worker NÃO tem rota pública. Só o Cloud Tasks o invoca, com OIDC (D-024).
    # Timeout longo e concorrência baixa: perfil oposto ao da api, que é a razão
    # de serem dois serviços (D-013).
    gc run deploy "${app}" \
      --image "${image}" \
      --region "${REGION}" \
      --service-account "$(sa_email "${SA_WORKER}")" \
      --no-allow-unauthenticated \
      --min-instances 0 \
      --max-instances 5 \
      --concurrency 4 \
      --timeout 900s \
      --cpu 1 --memory 512Mi \
      --set-env-vars "NODE_ENV=production,SUPABASE_URL=${SUPABASE_URL},ERP_IMPORTS_BUCKET=${PROJECT_ID}-erp-imports,MERCADO_LIVRE_CLIENT_ID=${MERCADO_LIVRE_CLIENT_ID}" \
      --set-secrets "SUPABASE_SERVICE_ROLE_KEY=${SECRET_SUPABASE_KEY}:latest,MERCADO_LIVRE_CLIENT_SECRET=${SECRET_ML_CLIENT_SECRET}:latest,ML_TOKEN_ENCRYPTION_KEY=${SECRET_ML_TOKEN_KEY}:latest" \
      --quiet
  fi

  local url
  url="$(gc run services describe "${app}" --region "${REGION}" --format='value(status.url)')"
  ok "${app}: ${url}"
}

step "Pré-condições"
require_auth
require_project
info "registry: ${REGISTRY}"
info "tag: ${TAG}"

if [ -n "$(git status --porcelain)" ]; then
  info "AVISO: árvore de trabalho suja; a tag recebe o sufixo -dirty"
fi

if [ "$#" -gt 0 ]; then
  build_and_deploy "$1"
else
  build_and_deploy api
  build_and_deploy worker
fi

step "Permissão de invocação do worker"
# Menor privilégio: só o Cloud Tasks invoca o worker, e a permissão é dada no
# serviço, não no projeto.
if gc run services describe worker --region "${REGION}" >/dev/null 2>&1; then
  binding="$(gc run services add-iam-policy-binding worker \
    --region "${REGION}" \
    --member "serviceAccount:$(sa_email "${SA_TASKS}")" \
    --role roles/run.invoker 2>&1)" || {
    printf '%s\n' "${binding}" >&2
    fail "Falha ao conceder run.invoker no worker. Mensagem do gcloud acima."
  }
  ok "worker: run.invoker -> ${SA_TASKS}"
fi

step "Concluído"
gc run services list --region "${REGION}" \
  --format="table(metadata.name,status.url,status.conditions[0].status)"
