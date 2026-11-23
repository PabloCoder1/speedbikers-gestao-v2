#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/storage-buckets.sh"
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/writes"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'auth list') echo runner@example.test; exit ;;
  'projects describe') echo speedbikers-gestao-v3; exit ;;
esac
case "$1 $2 $3" in
  'storage buckets list')
    if [[ "$SCENARIO" = list_denied ]]; then echo 'PERMISSION_DENIED na lista' >&2; exit 1; fi
    if [[ "$SCENARIO" != new ]]; then printf '%s\r\n' speedbikers-gestao-v3-raw-ml; fi
    printf '%s\r\n' speedbikers-gestao-v3-erp-imports speedbikers-gestao-v3-documents
    ;;
  'storage buckets describe')
    case "$SCENARIO" in
      describe_denied) echo 'PERMISSION_DENIED no describe' >&2; exit 1 ;;
      malformed) echo '{incompleto' ;;
      drift) echo '{"lifecycle_config":{"rule":[{"action":{"type":"Delete"},"condition":{"age":365}}]}}' ;;
      empty) echo '{}' ;;
      *) echo '{"lifecycle_config":{"rule":[{"condition":{"matchesStorageClass":["STANDARD"],"age":90},"action":{"type":"SetStorageClass","storageClass":"COLDLINE"}},{"action":{"type":"Delete"},"condition":{"age":365}}]}}' ;;
    esac
    ;;
  'storage buckets create')
    printf 'create %s\n' "$4" >> "$WRITES_FIXTURE"
    file=''
    for arg in "$@"; do
      if [[ "$arg" = --lifecycle-file=* ]]; then file="${arg#*=}"; fi
    done
    [[ "$4" = gs://speedbikers-gestao-v3-raw-ml && -n "$file" ]]
    node -e '
      const assert = require("node:assert/strict");
      const {readFileSync} = require("node:fs");
      assert.deepEqual(JSON.parse(readFileSync(process.argv[1], "utf8")), {
        rule: [{action: {type: "SetStorageClass", storageClass: "COLDLINE"},
          condition: {age: 90, matchesStorageClass: ["STANDARD"]}}],
      });
    ' "$file"
    ;;
  'storage buckets update') printf 'update %s\n' "$4" >> "$WRITES_FIXTURE" ;;
  'storage buckets add-iam-policy-binding') printf 'binding %s\n' "$4" >> "$WRITES_FIXTURE" ;;
  *) echo "Comando inesperado: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${fixture}/gcloud"

rodar() {
  : > "${fixture}/writes"
  env -i PATH="$PATH" GCLOUD_BIN="${fixture}/gcloud" WRITES_FIXTURE="${fixture}/writes" \
    SCENARIO="$1" bash "$script"
}

for scenario in list_denied describe_denied malformed drift empty; do
  if saida="$(rodar "$scenario" 2>&1)" || [[ -s "${fixture}/writes" ]]; then
    printf 'FALHA: %s deveria abortar antes de criar, atualizar ou conceder IAM\n%s\n' "$scenario" "$saida" >&2
    exit 1
  fi
  printf 'ok    %s bloqueia alterações\n' "$scenario"
done

rodar existing >/dev/null
[[ "$(grep -c '^binding ' "${fixture}/writes")" = 5 ]]
if grep -Eq '^(create|update) ' "${fixture}/writes"; then
  echo 'FALHA: lifecycle existente deve ser preservado' >&2
  exit 1
fi
printf 'ok    regra existente e regras adicionais foram preservadas\n'

rodar new >/dev/null
[[ "$(head -n 1 "${fixture}/writes")" = 'create gs://speedbikers-gestao-v3-raw-ml' ]]
[[ "$(grep -c '^binding ' "${fixture}/writes")" = 5 ]]
if grep -q '^update ' "${fixture}/writes"; then
  echo 'FALHA: lifecycle precisa ser instalado na criação do bucket' >&2
  exit 1
fi
printf 'ok    bucket novo recebe a regra na criação\n'
