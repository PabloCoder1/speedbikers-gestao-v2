import type { Tom } from "../components/tone";

/**
 * Veredito de saúde das lojas TikTok Shop em `/sincronizacao` (D-824, M04).
 *
 * Espelha `saude-loja-shopee.ts`, com aviso oficial de 30 dias
 * (`UPCOMING_AUTHORIZATION_EXPIRATION`, `docs/TIKTOK_SHOP.md` §4) e sem
 * declarar verde (`ok`) antes de haver sincronização transacional observada.
 */

export interface LojaTikTokSaude {
  readonly status: string;
  readonly auth_expires_at: string | null;
}

export interface VereditoDaLojaTikTok {
  readonly tom: Tom;
  readonly rotulo: string;
  readonly orientacao: string;
}

const DIAS_AVISO_TIKTOK = 30;
const DIA_MS = 86_400_000;

export function avisoDaAutorizacaoTikTok(loja: LojaTikTokSaude, agora: Date): VereditoDaLojaTikTok | null {
  if (loja.auth_expires_at === null) return null;

  const agoraMs = agora.getTime();
  const venceMs = Date.parse(loja.auth_expires_at);

  if (!Number.isFinite(agoraMs) || !Number.isFinite(venceMs)) return null;

  const restanteMs = venceMs - agoraMs;

  if (restanteMs <= 0) {
    return {
      tom: "perigo",
      rotulo: "Autorização vencida",
      orientacao: "Reautorize a loja em Contas e lojas com a conta titular (owner) do TikTok Shop.",
    };
  }

  const dias = Math.ceil(restanteMs / DIA_MS);

  if (dias <= DIAS_AVISO_TIKTOK) {
    return {
      tom: "atencao",
      rotulo: `Autorização vence em ${String(dias)} dia${dias === 1 ? "" : "s"}`,
      orientacao: "Reautorize a loja em Contas e lojas antes do vencimento para não interromper as leituras.",
    };
  }

  return null;
}

export function vereditoDaLojaTikTok(loja: LojaTikTokSaude, agora: Date): VereditoDaLojaTikTok {
  if (loja.status !== "CONNECTED") {
    return {
      tom: "perigo",
      rotulo: "Conexão em erro",
      orientacao: "Reconecte a loja em Contas e lojas com a conta titular (owner) do TikTok Shop.",
    };
  }

  const autorizacao = avisoDaAutorizacaoTikTok(loja, agora);

  if (autorizacao !== null) {
    return autorizacao;
  }

  return {
    tom: "neutro",
    rotulo: "Conectada (aguardando sync)",
    orientacao: "OAuth conectado; aguardando ativação dos agendamentos e handlers transacionais do TikTok Shop.",
  };
}
