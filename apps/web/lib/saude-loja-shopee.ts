/**
 * A SAÚDE DE UMA LOJA SHOPEE em `/sincronizacao` (D-438, etapa T3 da frente
 * multicanal), lida de `marketplace_accounts` (C-52, D-435).
 *
 * **Os limiares são os do vigia, não os da cadência.** O vigia da loja
 * (`private.avisar_loja_shopee_parada`, D-435) mede a idade da última leitura
 * de pedidos que terminou — ou da conexão, se nunca houve uma — e avisa com
 * `sync.delayed` a partir de 3 h e `sync.failed` a partir de 12 h. A tela usa
 * os mesmos números: uma loja "atrasada" aqui é a mesma que gerou o aviso no
 * sino. Com a cadência de `/saude` (2 e 4 ciclos de 60 min), as duas telas
 * discordariam por horas sobre a mesma loja.
 *
 * A loja de TESTE recebe o veredito, mas o vigia não a vigia: a tela diz isso.
 */

import type { Tom } from "../components/tone";

export interface LojaNaSaude {
  readonly connection_status: string | null;
  readonly environment: string | null;
  /** A última leitura de pedidos que TERMINOU (`orders_last_success_at`). */
  readonly orders_synced_at: string | null;
  readonly connected_at: string | null;
  readonly authorization_expires_at: string | null;
}

export interface Veredito {
  readonly tom: Tom;
  readonly rotulo: string;
  readonly orientacao: string;
}

const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;

/** Os limiares do vigia (D-435): atrasada e parada. */
export const LIMIAR_ATRASO_H = 3;
export const LIMIAR_PARADA_H = 12;

/** A partir de quantos dias a tela avisa que a autorização vai vencer. */
export const AVISO_AUTORIZACAO_DIAS = 30;

export function lojaDeTeste(loja: Pick<LojaNaSaude, "environment">): boolean {
  return loja.environment !== "live";
}

/**
 * O veredito dos PEDIDOS da loja. A conexão vem primeiro: loja em ERROR não é
 * lida (a leitura de hora em hora só visita loja conectada), e o conserto é
 * reautorizar — não esperar.
 */
export function vereditoDaLoja(loja: LojaNaSaude, agora: Date): Veredito {
  if (loja.connection_status !== "CONNECTED") {
    return {
      tom: "perigo",
      rotulo: "Conexão em erro",
      orientacao: "A Shopee recusou a autorização e nada desta loja é lido. Reautorize em Contas e lojas.",
    };
  }

  if (loja.orders_synced_at === null) {
    if (loja.connected_at === null) {
      return { tom: "neutro", rotulo: "Nunca lida", orientacao: "Nenhuma leitura de pedidos registrada." };
    }

    const desdeConexao = (agora.getTime() - new Date(loja.connected_at).getTime()) / HORA_MS;

    if (desdeConexao < LIMIAR_ATRASO_H) {
      return {
        tom: "neutro",
        rotulo: "Primeira leitura",
        orientacao: "A loja acabou de ser conectada; os pedidos são lidos de hora em hora.",
      };
    }
  }

  const referencia = loja.orders_synced_at ?? loja.connected_at;
  const horas = referencia === null ? 0 : (agora.getTime() - new Date(referencia).getTime()) / HORA_MS;
  const inteiras = Math.floor(horas);

  if (horas >= LIMIAR_PARADA_H) {
    return {
      tom: "perigo",
      rotulo: "Pedidos parados",
      orientacao: `Nenhuma leitura de pedidos terminou há ${String(inteiras)} h. Os números da Shopee estão velhos.`,
    };
  }

  if (horas >= LIMIAR_ATRASO_H) {
    return {
      tom: "atencao",
      rotulo: "Pedidos atrasados",
      orientacao: `A última leitura de pedidos que terminou foi há ${String(inteiras)} h; o esperado é de hora em hora.`,
    };
  }

  return { tom: "ok", rotulo: "Pedidos em dia", orientacao: "A leitura de pedidos de hora em hora está terminando." };
}

/**
 * A autorização da loja (a Shopee pede de novo no prazo escolhido nela, até
 * 365 dias). Não há aviso no sino para isto (D-435): é esta tela que lembra.
 * `null` = nada a dizer.
 */
export function avisoDaAutorizacao(loja: LojaNaSaude, agora: Date): Veredito | null {
  if (loja.authorization_expires_at === null) return null;

  const dias = Math.floor((new Date(loja.authorization_expires_at).getTime() - agora.getTime()) / DIA_MS);

  if (dias < 0) {
    return {
      tom: "perigo",
      rotulo: "Autorização vencida",
      orientacao: "A Shopee não aceita mais a autorização desta loja. Reautorize em Contas e lojas.",
    };
  }

  if (dias <= AVISO_AUTORIZACAO_DIAS) {
    return {
      tom: "atencao",
      rotulo: dias === 0 ? "Autorização vence hoje" : `Autorização vence em ${String(dias)} ${dias === 1 ? "dia" : "dias"}`,
      orientacao: "Reautorize em Contas e lojas antes do vencimento, ou a leitura para.",
    };
  }

  return null;
}
