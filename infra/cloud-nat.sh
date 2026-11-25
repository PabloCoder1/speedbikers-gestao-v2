#!/usr/bin/env bash
# IP fixo de saída do Cloud Run (D-457): rede VPC, sub-rede, IP reservado,
# Cloud Router e Cloud NAT — a receita da documentação do Cloud Run ("Static
# outbound IP address", saída VPC direta). Idempotente.
#
# Só produção precisa dele: a Shopee exige a lista de IPs que chamam a API.
# Depois dele, `infra/deploy-cloud-run.sh` publica api e worker com
# `--network/--subnet --vpc-egress all-traffic`.
#
# Custo (preços de 15/10/2026 e o uso de 30 dias): gateway US$ 0,0014 por
# instância-hora (~3,5 instâncias), IP US$ 0,005/h e US$ 0,045 por GiB
# (~18 GiB/mês) — uns US$ 8 por mês.
#
# Uso:  AMBIENTE=prod CONFIRMO_PRODUCAO=sim ... bash infra/cloud-nat.sh

source "$(dirname "$0")/lib.sh"

step "Pré-condições"
require_auth
require_project
[ "${AMBIENTE}" = "prod" ] || fail "o IP fixo é de produção (AMBIENTE=prod); o Dev segue saindo pelo pool dinâmico."

step "API do Compute Engine"
if ! compute_services="$(gc services list --enabled --filter=config.name=compute.googleapis.com --format='value(config.name)' | tr -d '\r')"; then
  fail "Não foi possível verificar se compute.googleapis.com está habilitada em ${PROJECT_ID}."
fi
if grep -Fxq -- compute.googleapis.com <<< "${compute_services}"; then
  skip compute.googleapis.com
else
  gc services enable compute.googleapis.com
  ok compute.googleapis.com
fi

list_names() {
  local label="$1" names
  shift
  if ! names="$(gc "$@" --format='value(name)' | tr -d '\r')"; then
    fail "Não foi possível listar ${label} para o Cloud NAT."
  fi
  printf '%s\n' "${names}"
}

# Inventarie todos os recursos acessíveis antes de criar qualquer um deles.
# Um NAT só pode preexistir quando o roteador já consta no inventário.
step "Inventário de rede"
networks="$(list_names redes compute networks list)"
subnets="$(list_names sub-redes compute networks subnets list --regions "${REGION}")"
addresses="$(list_names endereços compute addresses list --regions "${REGION}")"
routers="$(list_names roteadores compute routers list --regions "${REGION}")"
nats=''
if grep -Fxq -- "${NAT_ROUTER}" <<< "${routers}"; then
  nats="$(list_names gateways compute routers nats list --router "${NAT_ROUTER}" --region "${REGION}")"
fi

step "Rede"
if grep -Fxq -- "${VPC_NETWORK}" <<< "${networks}"; then
  skip "${VPC_NETWORK}"
else
  gc compute networks create "${VPC_NETWORK}" --subnet-mode=custom >/dev/null
  ok "${VPC_NETWORK}"
fi

# Acesso privado aos serviços do Google: Cloud Tasks, Secret Manager e
# Logging não precisam passar pelo NAT (nem pagar o processamento dele).
if grep -Fxq -- "${VPC_SUBNET}" <<< "${subnets}"; then
  skip "${VPC_SUBNET}"
else
  gc compute networks subnets create "${VPC_SUBNET}" --network "${VPC_NETWORK}" --region "${REGION}" \
    --range "${VPC_SUBNET_RANGE}" --enable-private-ip-google-access >/dev/null
  ok "${VPC_SUBNET} (${VPC_SUBNET_RANGE})"
fi

step "IP reservado"
if grep -Fxq -- "${NAT_IP_NAME}" <<< "${addresses}"; then
  skip "${NAT_IP_NAME}"
else
  gc compute addresses create "${NAT_IP_NAME}" --region "${REGION}" >/dev/null
  ok "${NAT_IP_NAME}"
fi

step "Cloud Router e Cloud NAT"
if grep -Fxq -- "${NAT_ROUTER}" <<< "${routers}"; then
  skip "${NAT_ROUTER}"
else
  gc compute routers create "${NAT_ROUTER}" --network "${VPC_NETWORK}" --region "${REGION}" >/dev/null
  ok "${NAT_ROUTER}"
fi

# 1024 portas por instância: o worker abre várias conexões ao mesmo destino
# (Supabase, Mercado Livre); as 64 do padrão acabariam numa rajada. Um IP
# tem ~64 mil portas — 63 instâncias, contra o teto de 15 (api 10 + worker
# 5). Log só de erro: a falta de porta aparece como OUT_OF_RESOURCES.
if grep -Fxq -- "${NAT_GATEWAY}" <<< "${nats}"; then
  skip "${NAT_GATEWAY}"
else
  gc compute routers nats create "${NAT_GATEWAY}" --router "${NAT_ROUTER}" --region "${REGION}" \
    --nat-custom-subnet-ip-ranges "${VPC_SUBNET}" --nat-external-ip-pool "${NAT_IP_NAME}" \
    --min-ports-per-vm 1024 --enable-logging --log-filter ERRORS_ONLY >/dev/null
  ok "${NAT_GATEWAY}"
fi

step "O IP para a lista da Shopee"
ip="$(gc compute addresses describe "${NAT_IP_NAME}" --region "${REGION}" --format="value(address)" | tr -d '\r')"
[[ -n "${ip}" ]] || fail "Endereço reservado ${NAT_IP_NAME} sem IP para a lista da Shopee."
ok "IP de saída de api e worker: ${ip}"
info "Próximo: publicar api e worker (infra/deploy-cloud-run.sh), que agora saem por ele."
