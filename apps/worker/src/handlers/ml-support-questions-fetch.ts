import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { fetchReceivedQuestionsPage, mapQuestionToSupportProjection } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import { persistSupportQuestion } from "./persist-support-question.js";

/**
 * Reconciliação de Perguntas (D-089, Fase 7B) — a peça de fetch+persist,
 * mesmo split de `ml-listing-visits-fetch.ts`.
 *
 * **Por que ela existe:** desde D-088 o webhook `questions` é o ÚNICO caminho
 * de ingestão. Uma notificação que o Mercado Livre não entregue é uma pergunta
 * que a V3 nunca vê — e a própria documentação oficial recomenda a busca como
 * redundância do webhook (a mesma lógica que `/messages/unread` cumpre para
 * mensagens). Esta é a rede de segurança.
 *
 * **Por que só `UNANSWERED`:** a leitura oficial de 2026-08-25 confirmou que
 * `/my/received_questions/search` NÃO tem filtro por data (`available_filters`
 * são `item`, `from`, `totalDivisions`, `division` e `status`) e que a
 * ordenação padrão não é documentada (`"sorts": []`). Sem data e sem ordem
 * garantida, "reconciliar os últimos N dias" é impossível de expressar — a
 * única alternativa seria varrer o histórico inteiro da conta a cada rodada.
 * `status=UNANSWERED` recorta exatamente o conjunto que importa
 * operacionalmente (alguém esperando resposta que nós nunca vimos), é
 * naturalmente pequeno numa conta atendida, e o Mercado Livre ainda o limita
 * sozinho removendo perguntas sem resposta há mais de 7 meses
 * (`docs/MERCADO_LIVRE.md` secao 2.12).
 *
 * **Lacuna conhecida, registrada e não escondida:** uma pergunta que o webhook
 * perdeu E que alguém respondeu pelo app do Mercado Livre nunca chega à V3 —
 * ela não está mais `UNANSWERED` e esta varredura não a alcança. É buraco de
 * histórico, não de operação; fechá-lo exigiria varrer os sete status a cada
 * rodada, custo que só se justifica com evidência real de que acontece.
 *
 * A varredura é IDEMPOTENTE por construção: `persistSupportQuestion` (D-086)
 * faz UPSERT por chave remota e preserva triagem humana, então reconciliar uma
 * pergunta que o webhook já trouxe não duplica nem sobrescreve decisão de
 * ninguém.
 */

/** Máximo documentado por página em buscas do Mercado Livre. */
const PAGE_LIMIT = 100;

/**
 * Teto de páginas por execução. Sem ele, uma conta com um número absurdo de
 * perguntas em aberto varreria a API até o rate limit. 20 x 100 = 2.000
 * perguntas por rodada — ordens de grandeza acima do esperado para perguntas
 * NÃO RESPONDIDAS de uma conta atendida. Estourar o teto não é erro: é sinal,
 * e sai no log e no resultado para quem for investigar.
 */
const MAX_PAGES = 20;

export interface FetchSupportQuestionsParams {
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  /** `seller_id` da conta conectada — a mesma checagem de identidade de D-087. */
  sellerId: number;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  logger: Logger;
  now?: () => Date;
}

export interface FetchSupportQuestionsResult {
  itemsProcessed: number;
  /** Perguntas que falharam ao persistir. Uma falha não aborta a varredura inteira. */
  itemsFailed: number;
  /** Perguntas recusadas por `seller_id` divergente — nunca escritas sob a conta errada. */
  itemsRejected: number;
  /** `total` relatado pelo Mercado Livre na primeira página. */
  remoteTotal: number;
  /** `true` quando o teto de páginas foi atingido antes de esgotar o `total`. */
  truncated: boolean;
}

export async function fetchSupportQuestions(
  params: FetchSupportQuestionsParams,
): Promise<FetchSupportQuestionsResult> {
  const observedAt = params.now?.() ?? new Date();

  let itemsProcessed = 0;
  let itemsFailed = 0;
  let itemsRejected = 0;
  let remoteTotal = 0;
  let offset = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Erro de rede/HTTP aqui NÃO é engolido: sobe para o job, que classifica
    // e decide o retry. Uma reconciliação que falha no meio e reporta sucesso
    // parcial silencioso seria pior que não ter reconciliação nenhuma.
    const result = await fetchReceivedQuestionsPage({
      mercadoLivre: params.mercadoLivre,
      accessToken: params.accessToken,
      status: "UNANSWERED",
      offset,
      limit: PAGE_LIMIT,
    });

    if (page === 0) {
      remoteTotal = result.total;
    }

    if (result.questions.length === 0) {
      return { itemsProcessed, itemsFailed, itemsRejected, remoteTotal, truncated: false };
    }

    for (const question of result.questions) {
      // Mesma checagem de identidade de D-087: um `seller_id` diferente do da
      // conta conectada nunca pode virar linha sob esta conta. Aqui ela é
      // ainda mais barata que lá — o payload já está em mãos.
      if (question.seller_id !== params.sellerId) {
        itemsRejected += 1;
        params.logger.warn("support_questions_seller_mismatch", {
          ml_account_id: params.mlAccountId,
          question_id: question.id,
        });
        continue;
      }

      try {
        await persistSupportQuestion(
          params.db,
          { organizationId: params.organizationId, mlAccountId: params.mlAccountId, source: "RECONCILIATION" },
          mapQuestionToSupportProjection(question, observedAt),
        );
        itemsProcessed += 1;
      } catch (error) {
        // Uma pergunta que falha ao persistir não pode derrubar a varredura
        // das outras — mesmo tratamento item-a-item de Full/listings/visitas.
        // O conteúdo da pergunta nunca entra no log.
        itemsFailed += 1;
        params.logger.error("support_question_persist_failed", {
          ml_account_id: params.mlAccountId,
          question_id: question.id,
          reason: error instanceof Error ? error.message : "erro desconhecido",
        });
      }
    }

    offset += result.questions.length;

    // A página veio menor que o limite: acabou. Não depende de `total`, que
    // pode se mover entre páginas enquanto perguntas novas chegam.
    if (result.questions.length < PAGE_LIMIT) {
      return { itemsProcessed, itemsFailed, itemsRejected, remoteTotal, truncated: false };
    }

    truncated = page === MAX_PAGES - 1;
  }

  if (truncated) {
    params.logger.warn("support_questions_scan_truncated", {
      ml_account_id: params.mlAccountId,
      pages: MAX_PAGES,
      items_processed: itemsProcessed,
      remote_total: remoteTotal,
    });
  }

  return { itemsProcessed, itemsFailed, itemsRejected, remoteTotal, truncated };
}
