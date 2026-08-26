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
 * **O IP confiável é o ÚLTIMO da lista.** Medido contra o Cloud Run real em
 * 2026-08-26 (D-093), com duas chamadas ao endereço de produção:
 *
 * | Enviado pelo cliente | Header que a `api` recebeu |
 * |---|---|
 * | nada | `<ip-do-cliente>` |
 * | `X-Forwarded-For: 54.88.218.97` | `54.88.218.97,<ip-do-cliente>` |
 *
 * Os dois casos concordam: **o Cloud Run ACRESCENTA o IP real ao final**. O
 * cliente controla tudo que vem antes e não controla o que vem depois.
 *
 * **A regra anterior (penúltimo) era uma inversão perigosa**, e o `PENDENTE`
 * de D-045 avisava exatamente disso — a inferência vinha da documentação do
 * HTTPS Load Balancing (`<existing>,<client-ip>,<lb-ip>`), que descreve outra
 * topologia: lá o balanceador acrescenta o PRÓPRIO IP por último, aqui não.
 * Com a regra antiga, `X-Forwarded-For: <ip-da-allowlist>` forjado por
 * qualquer pessoa caía exatamente na posição lida como confiável — e a
 * verificação de 2026-08-26 confirmou a falha em produção: uma chamada com o
 * header forjado foi ACEITA (200) e atravessou a allowlist.
 *
 * Também não existe mais exigência de duas entradas: uma entrada só é o caso
 * NORMAL (cliente que não manda o header), e tratá-lo como "não deu para ler"
 * rejeitava toda notificação legítima do Mercado Livre.
 */
export function extractClientIp(forwardedFor: string | undefined | null): string | undefined {
  if (forwardedFor === undefined || forwardedFor === null) {
    return undefined;
  }

  const parts = forwardedFor
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return undefined;
  }

  return parts[parts.length - 1];
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
