#!/usr/bin/env bash
# ============================================================
# Retenção de artefatos de build no GCP (I06 / L04 / D-836).
#
# Modo padrão (ou `--dry-run`): SOMENTE LEITURA — inspeciona as políticas
# vigentes no Artifact Registry (`describe`) e no bucket temporário
# `<PROJECT_ID>_cloudbuild` sem executar nenhum comando de escrita.
#
# Para gravar alterações, informe explicitamente `--apply`:
#   1. Aplica `infra/artifact-retention-policy.json` no Artifact Registry
#      (`keepCount: 10` + `DELETE > 30d`). Passe `--simulate` junto com
#      `--apply` somente se desejar ativar o modo de simulação do próprio
#      Artifact Registry (`--dry-run` no repositório).
#   2. Com `--cloudbuild-lifecycle`, lê as regras de lifecycle atuais do
#      bucket `<PROJECT_ID>_cloudbuild`, PRESERVA todas as regras já
#      existentes e adiciona (sem duplicar) a regra `Delete` após 30 dias,
#      sem tocar nos buckets de negócio.
#
# Uso:
#   ./infra/artifact-retention.sh --project speedbikers-prod
#   ./infra/artifact-retention.sh --project speedbikers-prod --apply
#   ./infra/artifact-retention.sh --project speedbikers-prod --apply --cloudbuild-lifecycle
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="${SCRIPT_DIR}/artifact-retention-policy.json"

PROJECT_ID="${GCP_PROJECT_ID:-}"
REGION="${GCP_REGION:-southamerica-east1}"
REPOSITORY="${ARTIFACT_REPOSITORY:-speedbikers-v3}"
APPLY="false"
SIMULATE="false"
APPLY_CLOUDBUILD_LIFECYCLE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --repository)
      REPOSITORY="$2"
      shift 2
      ;;
    --dry-run)
      APPLY="false"
      shift
      ;;
    --apply)
      APPLY="true"
      shift
      ;;
    --simulate)
      SIMULATE="true"
      shift
      ;;
    --cloudbuild-lifecycle)
      APPLY_CLOUDBUILD_LIFECYCLE="true"
      shift
      ;;
    -h|--help)
      sed -n '2,26p' "$0"
      exit 0
      ;;
    *)
      echo "Argumento desconhecido: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PROJECT_ID" ]]; then
  echo "Informe --project <GCP_PROJECT_ID> ou exporte GCP_PROJECT_ID." >&2
  exit 2
fi

if [[ ! -f "$POLICY_FILE" ]]; then
  echo "Arquivo de política não encontrado: $POLICY_FILE" >&2
  exit 1
fi

if [[ "$SIMULATE" == "true" && "$APPLY" != "true" ]]; then
  echo "--simulate exige --apply explícito (ativa simulação no próprio repositório Artifact Registry)." >&2
  exit 2
fi

CLOUDBUILD_BUCKET="gs://${PROJECT_ID}_cloudbuild"

if [[ "$APPLY" != "true" ]]; then
  echo "==> [prévia somente leitura] Artifact Registry: ${PROJECT_ID}/${REGION}/${REPOSITORY}"
  gcloud artifacts repositories describe "$REPOSITORY" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --format="yaml(cleanupPolicies,cleanupPolicyDryRun,sizeBytes)"

  if [[ "$APPLY_CLOUDBUILD_LIFECYCLE" == "true" ]]; then
    echo "==> [prévia somente leitura] Bucket: ${CLOUDBUILD_BUCKET}"
    gcloud storage buckets describe "$CLOUDBUILD_BUCKET" \
      --project="$PROJECT_ID" \
      --format="yaml(lifecycle_config)"
  fi

  echo "==> Nenhuma alteração gravada. Passe --apply para gravar."
  exit 0
fi

echo "==> Aplicando política no Artifact Registry: ${PROJECT_ID}/${REGION}/${REPOSITORY} (simulate=${SIMULATE})"
AR_ARGS=(
  artifacts repositories set-cleanup-policies "$REPOSITORY"
  --project="$PROJECT_ID"
  --location="$REGION"
  --policy="$POLICY_FILE"
)

if [[ "$SIMULATE" == "true" ]]; then
  AR_ARGS+=(--dry-run)
else
  AR_ARGS+=(--no-dry-run)
fi

gcloud "${AR_ARGS[@]}"

if [[ "$APPLY_CLOUDBUILD_LIFECYCLE" == "true" ]]; then
  TMP_CURRENT="$(mktemp)"
  TMP_MERGED="$(mktemp)"
  trap 'rm -f "$TMP_CURRENT" "$TMP_MERGED"' EXIT

  echo "==> Lendo lifecycle atual de ${CLOUDBUILD_BUCKET} para preservar regras existentes"
  gcloud storage buckets describe "$CLOUDBUILD_BUCKET" \
    --project="$PROJECT_ID" \
    --format="json" > "$TMP_CURRENT"

  node -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    const parsed = JSON.parse(raw);
    const existing = Array.isArray(parsed?.lifecycle_config?.rule)
      ? parsed.lifecycle_config.rule
      : Array.isArray(parsed?.lifecycle?.rule)
        ? parsed.lifecycle.rule
        : [];
    const target = { action: { type: "Delete" }, condition: { age: 30 } };
    const alreadyPresent = existing.some(
      (r) =>
        r?.action?.type === "Delete" &&
        r?.condition?.age === 30 &&
        Object.keys(r.condition ?? {}).length === 1,
    );
    const merged = alreadyPresent ? existing : [...existing, target];
    fs.writeFileSync(process.argv[2], JSON.stringify({ lifecycle: { rule: merged } }, null, 2) + "\n", "utf8");
  ' "$TMP_CURRENT" "$TMP_MERGED"

  echo "==> Atualizando lifecycle de ${CLOUDBUILD_BUCKET} preservando regras existentes"
  gcloud storage buckets update "$CLOUDBUILD_BUCKET" \
    --project="$PROJECT_ID" \
    --lifecycle-file="$TMP_MERGED"
fi

echo "==> Concluído."
