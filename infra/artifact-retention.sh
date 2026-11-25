#!/usr/bin/env bash
# ============================================================
# Retenção de artefatos de build no GCP (I06 / L04 / D-836).
#
# Configura de forma idempotente:
#   1. Política de limpeza no Artifact Registry (`speedbikers-v3`):
#      mantém sempre as 10 versões mais recentes de cada imagem (`api`,
#      `worker`) e remove versões mais antigas que 30 dias.
#   2. Opcionalmente (`--cloudbuild-lifecycle`), aplica lifecycle de
#      exclusão em 30 dias no bucket temporário `<PROJECT_ID>_cloudbuild`,
#      sem tocar nos buckets de negócio (`db-backups`, `documents`,
#      `erp-imports`, `raw-ml`).
#
# Uso:
#   ./infra/artifact-retention.sh --project speedbikers-prod --dry-run
#   ./infra/artifact-retention.sh --project speedbikers-prod
#   ./infra/artifact-retention.sh --project speedbikers-prod --cloudbuild-lifecycle
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="${SCRIPT_DIR}/artifact-retention-policy.json"

PROJECT_ID="${GCP_PROJECT_ID:-}"
REGION="${GCP_REGION:-southamerica-east1}"
REPOSITORY="${ARTIFACT_REPOSITORY:-speedbikers-v3}"
DRY_RUN="false"
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
      DRY_RUN="true"
      shift
      ;;
    --cloudbuild-lifecycle)
      APPLY_CLOUDBUILD_LIFECYCLE="true"
      shift
      ;;
    -h|--help)
      sed -n '2,22p' "$0"
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

echo "==> Artifact Registry: ${PROJECT_ID}/${REGION}/${REPOSITORY} (dry-run=${DRY_RUN})"
AR_ARGS=(
  artifacts repositories set-cleanup-policies "$REPOSITORY"
  --project="$PROJECT_ID"
  --location="$REGION"
  --policy="$POLICY_FILE"
)

if [[ "$DRY_RUN" == "true" ]]; then
  AR_ARGS+=(--dry-run)
else
  AR_ARGS+=(--no-dry-run)
fi

gcloud "${AR_ARGS[@]}"

if [[ "$APPLY_CLOUDBUILD_LIFECYCLE" == "true" ]]; then
  CLOUDBUILD_BUCKET="gs://${PROJECT_ID}_cloudbuild"
  TMP_LIFECYCLE="$(mktemp)"
  trap 'rm -f "$TMP_LIFECYCLE"' EXIT

  cat > "$TMP_LIFECYCLE" <<'EOF'
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "Delete" },
        "condition": { "age": 30 }
      }
    ]
  }
}
EOF

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "==> [dry-run] Lifecycle de 30 dias preparado para ${CLOUDBUILD_BUCKET} (não aplicado)."
  else
    echo "==> Aplicando lifecycle de 30 dias em ${CLOUDBUILD_BUCKET}"
    gcloud storage buckets update "$CLOUDBUILD_BUCKET" \
      --project="$PROJECT_ID" \
      --lifecycle-file="$TMP_LIFECYCLE"
  fi
fi

echo "==> Concluído."
