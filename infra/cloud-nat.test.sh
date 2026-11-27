#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud-nat.sh"
fixture="$(mktemp -d)"
trap 'rm -f "${fixture}/gcloud" "${fixture}/writes"; rmdir "${fixture}"' EXIT

cat > "${fixture}/gcloud" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

resource() {
  local kind="$1" name="$2" verb="$3"
  shift 3
  case "$verb" in
    list|describe)
      if [[ "$SCENARIO" = "${kind}_denied" || ( "$SCENARIO" = nat_denied_late && "$kind" = nat ) ]]; then
        echo "PERMISSION_DENIED simulado: $kind" >&2
        exit 1
      fi
      if [[ "$verb" = list ]]; then
        case "$kind" in
          subnet|address|router) [[ " $* " = *' --regions southamerica-east1 '* ]] ;;
          nat)
            [[ " $* " = *' --router v3-router '* && " $* " = *' --region southamerica-east1 '* ]]
            [[ "$SCENARIO" != all_missing ]]
            ;;
        esac
        if [[ "$SCENARIO" = all_missing || "$SCENARIO" = "${kind}_missing" || ( "$SCENARIO" = nat_denied_late && "$kind" = network ) ]]; then
          printf '%s-copia\r\n' "$name"
        else
          printf '%s\r\n' "$name"
        fi
      elif [[ "$kind" = address && "$SCENARIO" != address_empty ]]; then
        echo '192.0.2.10'
      fi
      ;;
    create)
      [[ "$1" = "$name" ]]
      printf 'create %s\n' "$kind" >> "$WRITES_FIXTURE"
      ;;
    *) exit 1 ;;
  esac
}

case "$1 $2" in
  'auth list') echo runner@example.test ;;
  'projects describe') echo speedbikers-prod ;;
  'services list')
    case "$SCENARIO" in
      denied) echo 'PERMISSION_DENIED simulado' >&2; exit 1 ;;
      absent) printf 'compute.googleapis.com.copia\r\n' ;;
      *) printf 'compute.googleapis.com\r\n' ;;
    esac
    ;;
  'services enable')
    [[ "$3" = compute.googleapis.com ]]
    printf 'enable %s\n' "$3" >> "$WRITES_FIXTURE"
    ;;
  'compute networks')
    if [[ "$3" = subnets ]]; then resource subnet v3-run-egress "${@:4}"
    else resource network v3-vpc "${@:3}"; fi
    ;;
  'compute addresses') resource address v3-nat-ip "${@:3}" ;;
  'compute routers')
    if [[ "$3" = nats ]]; then resource nat v3-nat "${@:4}"
    else resource router v3-router "${@:3}"; fi
    ;;
  *) echo "Comando inesperado: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${fixture}/gcloud"

rodar() {
  : > "${fixture}/writes"
  env -i PATH="$PATH" \
    AMBIENTE=prod PROJECT_ID=speedbikers-prod SUPABASE_PROJECT_REF=sentinel-test-prod \
    SUPABASE_PUBLISHABLE_KEY=fixture-placeholder WEB_ORIGINS=https://example.invalid \
    CONFIRMO_PRODUCAO=sim GCLOUD_BIN="${fixture}/gcloud" WRITES_FIXTURE="${fixture}/writes" \
    SCENARIO="$1" bash "$script"
}

for scenario in denied network_denied subnet_denied address_denied router_denied nat_denied nat_denied_late; do
  if saida="$(rodar "$scenario" 2>&1)" || [[ -s "${fixture}/writes" ]]; then
    printf 'FALHA: %s deve abortar antes da criação de recursos\n%s\n' "$scenario" "$saida" >&2
    exit 1
  fi
  printf 'ok    %s não provoca escrita\n' "$scenario"
done

rodar enabled >/dev/null
[[ ! -s "${fixture}/writes" ]]
printf 'ok    API e recursos já existentes são preservados\n'

rodar absent >/dev/null
[[ "$(cat "${fixture}/writes")" = 'enable compute.googleapis.com' ]]
printf 'ok    ausência confirmada habilita apenas a API\n'

rodar all_missing >/dev/null
[[ "$(cat "${fixture}/writes")" = $'create network\ncreate subnet\ncreate address\ncreate router\ncreate nat' ]]
printf 'ok    recursos ausentes são criados na ordem de dependência\n'

rodar nat_missing >/dev/null
[[ "$(cat "${fixture}/writes")" = 'create nat' ]]
printf 'ok    retomada cria só o NAT ausente em roteador existente\n'

if saida="$(rodar address_empty 2>&1)" || [[ -s "${fixture}/writes" ]] || [[ "$saida" = *'IP de saída de api e worker:'* ]]; then
  printf 'FALHA: endereço vazio não deve ser anunciado como IP de saída\n%s\n' "$saida" >&2
  exit 1
fi
printf 'ok    endereço vazio aborta sem anunciar sucesso\n'
