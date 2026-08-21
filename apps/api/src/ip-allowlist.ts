/**
 * Validação de origem do webhook do Mercado Livre.
 *
 * Allowlist de IP é o ÚNICO mecanismo documentado para este produto (D-043,
 * `docs/MERCADO_LIVRE.md` secao 2.6). Não existe assinatura HMAC para o
 * Mercado Livre — só para o Mercado Pago, produto diferente.
 */

/** Confirmado em `developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes` (2026-08-21). */
export const MERCADO_LIVRE_IPS: readonly string[] = [
  "54.88.218.97",
  "18.215.140.160",
  "18.213.114.129",
  "18.206.34.84",
  "35.236.253.169",
  "35.245.91.34",
  "35.245.20.104",
  "35.186.182.146",
];

export interface IpAllowlistResult {
  ok: boolean;
  ip?: string | undefined;
}

export interface IpAllowlistVerifier {
  verify: (forwardedFor: string | undefined | null) => IpAllowlistResult;
}

/**
 * Extrai o IP do cliente de `X-Forwarded-For`.
 *
 * Confirmado na documentação oficial do Google Cloud HTTPS Load Balancing —
 * mesma infraestrutura de front-end que atende o Cloud Run: "If the incoming
 * request already includes an X-Forwarded-For header, the load balancer
 * appends its values to the existing header" no formato
 * `<existing-value>,<client-ip>,<load-balancer-ip>`, e "does not verify any
 * IP addresses that precede <client-ip>,<load-balancer-ip> in this header".
 *
 * Ou seja, o IP confiável é o PENÚLTIMO da lista — nunca o primeiro, que o
 * próprio cliente controla e pode forjar livremente.
 *
 * PENDENTE: o texto confirmado é da documentação de HTTPS Load Balancing, não
 * de uma página específica do Cloud Run. Verificar contra o log real do Cloud
 * Run em Dev (inspecionar o header recebido numa chamada de teste) antes de
 * depender disto para bloquear tráfego em produção.
 */
export function extractClientIp(forwardedFor: string | undefined | null): string | undefined {
  if (forwardedFor === undefined || forwardedFor === null) {
    return undefined;
  }

  const parts = forwardedFor
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    return undefined;
  }

  return parts[parts.length - 2];
}

export function createIpAllowlistVerifier(
  allowedIps: readonly string[] = MERCADO_LIVRE_IPS,
): IpAllowlistVerifier {
  const allowed = new Set(allowedIps);

  return {
    verify: (forwardedFor) => {
      const ip = extractClientIp(forwardedFor);

      if (ip === undefined || !allowed.has(ip)) {
        return { ok: false, ip };
      }

      return { ok: true, ip };
    },
  };
}
