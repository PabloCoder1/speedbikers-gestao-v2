/**
 * Rótulos em português para os códigos guardados no banco.
 *
 * O banco guarda o código em inglês (`PARSED`, `LINKS`) porque ele é contrato
 * entre `api`, `worker` e migrations. A tradução é da interface, e viver num
 * lugar só evita que a mesma coisa apareça com dois nomes em telas diferentes.
 */

const BATCH_STATUS: Record<string, string> = {
  UPLOADED: "Enviado",
  PARSING: "Lendo o arquivo",
  PARSED: "Aguardando conferência",
  APPLYING: "Aplicando",
  APPLIED: "Aplicado",
  FAILED: "Falhou",
  CANCELLED: "Cancelado",
};

const ROW_STATUS: Record<string, string> = {
  OK: "OK",
  SKIPPED: "Ignorada",
  INVALID: "Inválida",
};

/**
 * Desfecho da APLICAÇÃO de uma linha (`apply_status`), diferente de
 * `rowStatusLabel`, que traduz o desfecho da LEITURA (`status`). `NULL` no
 * banco significa "ainda não aplicada" e nunca chega aqui — a tela só chama
 * isto quando o valor existe.
 */
const APPLY_STATUS: Record<string, string> = {
  APPLIED: "Aplicada",
  UNRESOLVED: "Pendente",
  FAILED: "Falhou",
};

const KIND: Record<string, string> = {
  PRODUCTS: "Produtos",
  KITS: "Kits",
  LINKS: "Vínculos",
  STOCK: "Estoque",
};

/** `documents.operation_type` (docs/NFE.md secao 2.2) — nunca `ide/tpNF` sozinho, D-053. */
const OPERATION_TYPE: Record<string, string> = {
  ENTRADA: "Entrada",
  SAIDA: "Saída",
};

/** `purchase_orders.status` — ciclo DRAFT->APPROVED->ORDERED->RECEIVED, CANCELLED de qualquer estado não-terminal. */
const PURCHASE_ORDER_STATUS: Record<string, string> = {
  DRAFT: "Rascunho",
  APPROVED: "Aprovado",
  ORDERED: "Pedido enviado",
  RECEIVED: "Recebido",
  CANCELLED: "Cancelado",
};

/** `purchase_order_events.event_type`. */
const PURCHASE_ORDER_EVENT: Record<string, string> = {
  CREATED: "Criado",
  UPDATED: "Atualizado",
  APPROVED: "Aprovado",
  ORDERED: "Marcado como pedido",
  RECEIVED: "Recebido",
  CANCELLED: "Cancelado",
};

/** `stock_movements.location_kind` — Full (D-018) fica fora, é snapshot, não ledger. */
const LOCATION_KIND: Record<string, string> = {
  LOCAL: "Local",
  RESERVADO: "Reservado",
  TRANSITO: "Em trânsito",
};

/**
 * `listings.status` — só os dois valores confirmados nesta sessão
 * (`docs/MERCADO_LIVRE.md` secao 2, "Items & Searches": `?status=active` e a
 * menção a pausar um anúncio). Outros valores possíveis do Mercado Livre
 * (`closed`, `under_review`, `inactive`) caem no fallback de `lookup()` — o
 * código bruto aparece em vez de travar, mesmo raciocínio do resto do mapa.
 */
const LISTING_STATUS: Record<string, string> = {
  active: "Ativo",
  paused: "Pausado",
};

/**
 * `domain_events.event_type` (docs/API.md secao 4) — mesmo texto do catálogo,
 * só traduzido. Código sem tradução cai no fallback de `lookup()`: mostra o
 * `dominio.entidade.acao` bruto em vez de travar, mesmo raciocínio do resto
 * do mapa — um `event_type` novo aparece feio antes de aparecer quebrado.
 */
const EVENT_TYPE: Record<string, string> = {
  "listing.price.changed": "Preço do anúncio alterado",
  "listing.title.changed": "Título do anúncio alterado",
  "listing.picture.changed": "Foto do anúncio alterada",
  "listing.description.changed": "Descrição do anúncio alterada",
  "listing.available_quantity.changed": "Quantidade disponível alterada",
  "listing.status.paused": "Anúncio pausado",
  "listing.status.reactivated": "Anúncio reativado",
  "listing.promotion.started": "Promoção iniciada",
  "listing.promotion.ended": "Promoção encerrada",
  "listing.catalog.won": "Ganhou o catálogo (buy box)",
  "listing.catalog.lost": "Perdeu o catálogo (buy box)",
  "listing.fulfillment.entered": "Entrou no Full",
  "listing.fulfillment.exited": "Saiu do Full",
  "stock.depleted": "Estoque zerado",
  "stock.replenished": "Estoque reabastecido",
  "stock.balance.diverged": "Divergência de saldo de estoque",
  "order.cancelled": "Pedido cancelado",
  "order.returned": "Pedido devolvido",
  "sync.delayed": "Sincronização atrasada",
  "sync.failed": "Sincronização falhou",
};

/** `domain_events.severity` — três níveis fixos (docs/NOTIFICATIONS.md secao 2). */
const SEVERITY: Record<string, string> = {
  informativo: "Informativo",
  importante: "Importante",
  critico: "Crítico",
};

/** `feature_suggestions.status` — sete estados, ordem e nomes do requisito (docs/PRODUCT_REQUIREMENTS.md, D-079). */
const FEATURE_SUGGESTION_STATUS: Record<string, string> = {
  nova: "Nova",
  em_analise: "Em análise",
  aprovada: "Aprovada",
  planejada: "Planejada",
  em_desenvolvimento: "Em desenvolvimento",
  entregue: "Entregue",
  recusada: "Recusada",
};

/**
 * `support_cases.channel` — os três canais de D-084. Mediação e devolução NÃO
 * são canais: são facetas do CLAIM (`is_mediation`/`has_return`), e por isso
 * não aparecem aqui.
 */
const SUPPORT_CHANNEL: Record<string, string> = {
  QUESTION: "Pergunta",
  POST_SALE_MESSAGE: "Mensagem",
  CLAIM: "Reclamação",
};

/** `support_cases.internal_status` — cinco valores de D-084. Não existe `FECHADO` interno. */
const SUPPORT_INTERNAL_STATUS: Record<string, string> = {
  NOVO: "Novo",
  EM_ATENDIMENTO: "Em atendimento",
  AGUARDANDO_CLIENTE: "Aguardando cliente",
  AGUARDANDO_MERCADO_LIVRE: "Aguardando Mercado Livre",
  RESOLVIDO: "Resolvido",
};

/** `support_cases.priority` — separada da severidade da notificação (D-084). */
const SUPPORT_PRIORITY: Record<string, string> = {
  NORMAL: "Normal",
  ALTA: "Alta",
  CRITICA: "Crítica",
};

/**
 * `support_cases.remote_reply_state` — dica conservadora de D-086, nunca
 * autorização: mesmo `ALLOWED` continuará sujeito a refresh remoto na hora
 * de enviar.
 */
const SUPPORT_REPLY_STATE: Record<string, string> = {
  UNKNOWN: "Desconhecido",
  ALLOWED: "Pode responder",
  BLOCKED: "Bloqueado",
};

/**
 * `support_messages.body_state` (D-086) — o estado do CONTEÚDO, não da
 * mensagem. Texto vazio por moderação não é o mesmo que mensagem vazia, e a
 * tela precisa dizer qual dos dois é: o Mercado Livre devolve string vazia
 * em conteúdo banido, e tratar isso como "sem texto" apagaria a informação
 * de que existiu uma mensagem ali.
 */
const SUPPORT_BODY_STATE: Record<string, string> = {
  AVAILABLE: "Disponível",
  EMPTY: "Sem texto",
  BANNED: "Removido pelo Mercado Livre",
  MODERATED: "Em moderação",
  UNAVAILABLE: "Indisponível",
};

/** `support_messages.sender_kind` (D-084). */
const SUPPORT_SENDER_KIND: Record<string, string> = {
  CUSTOMER: "Cliente",
  SELLER: "Você (vendedor)",
  MERCADO_LIVRE_AGENT: "Agente do Mercado Livre",
  MEDIATOR: "Mediador",
  SYSTEM: "Sistema",
  UNKNOWN: "Desconhecido",
};

/**
 * `support_case_events.event_type` — vocabulário PRÓPRIO da auditoria de
 * atendimento, distinto de `domain_events.event_type` (`EVENT_TYPE` acima).
 * Só transições escolhidas viram `domain_events support.*` (D-084); aqui
 * entra tudo que o histórico registra, inclusive o que nunca notifica.
 */
const SUPPORT_CASE_EVENT: Record<string, string> = {
  "support.case.triaged": "Triagem alterada",
};

/** `support_case_deadlines.deadline_kind` (D-084). */
const SUPPORT_DEADLINE_KIND: Record<string, string> = {
  FIRST_RESPONSE: "Primeira resposta",
  NEXT_ACTION: "Próxima ação",
  RESOLUTION: "Resolução",
};

function lookup(table: Record<string, string>, code: string): string {
  return table[code] ?? code;
}

export const batchStatusLabel = (code: string): string => lookup(BATCH_STATUS, code);
export const rowStatusLabel = (code: string): string => lookup(ROW_STATUS, code);
export const applyStatusLabel = (code: string): string => lookup(APPLY_STATUS, code);
export const kindLabel = (code: string): string => lookup(KIND, code);
export const operationTypeLabel = (code: string): string => lookup(OPERATION_TYPE, code);
export const purchaseOrderStatusLabel = (code: string): string => lookup(PURCHASE_ORDER_STATUS, code);
export const purchaseOrderEventLabel = (code: string): string => lookup(PURCHASE_ORDER_EVENT, code);
export const locationKindLabel = (code: string): string => lookup(LOCATION_KIND, code);
export const listingStatusLabel = (code: string): string => lookup(LISTING_STATUS, code);
export const eventTypeLabel = (code: string): string => lookup(EVENT_TYPE, code);
export const severityLabel = (code: string): string => lookup(SEVERITY, code);
export const featureSuggestionStatusLabel = (code: string): string => lookup(FEATURE_SUGGESTION_STATUS, code);
export const supportChannelLabel = (code: string): string => lookup(SUPPORT_CHANNEL, code);
export const supportInternalStatusLabel = (code: string): string => lookup(SUPPORT_INTERNAL_STATUS, code);
export const supportPriorityLabel = (code: string): string => lookup(SUPPORT_PRIORITY, code);
export const supportReplyStateLabel = (code: string): string => lookup(SUPPORT_REPLY_STATE, code);
export const supportBodyStateLabel = (code: string): string => lookup(SUPPORT_BODY_STATE, code);
export const supportSenderKindLabel = (code: string): string => lookup(SUPPORT_SENDER_KIND, code);
export const supportDeadlineKindLabel = (code: string): string => lookup(SUPPORT_DEADLINE_KIND, code);
export const supportCaseEventLabel = (code: string): string => lookup(SUPPORT_CASE_EVENT, code);

/** Cor de destaque por estado. `null` = sem destaque, o padrão da tabela. */
export function statusTone(code: string): "ok" | "warn" | "bad" | null {
  if (code === "APPLIED" || code === "OK" || code === "RECEIVED" || code === "entregue" || code === "aprovada") {
    return "ok";
  }
  if (
    code === "PARSED" ||
    code === "SKIPPED" ||
    code === "PARSING" ||
    code === "UNRESOLVED" ||
    code === "DRAFT" ||
    code === "APPROVED" ||
    code === "ORDERED" ||
    code === "importante" ||
    code === "em_analise" ||
    code === "planejada" ||
    code === "em_desenvolvimento"
  ) {
    return "warn";
  }

  if (code === "active") return "ok";
  if (code === "paused") return "warn";

  // Atendimento (D-090). "NOVO" é warn, não bad: uma pergunta nova é o
  // estado NORMAL da caixa, não um problema — o que merece vermelho é
  // prioridade CRITICA e resposta bloqueada.
  if (code === "RESOLVIDO" || code === "ALLOWED") return "ok";
  if (code === "NOVO" || code === "AGUARDANDO_CLIENTE" || code === "AGUARDANDO_MERCADO_LIVRE") {
    return "warn";
  }
  if (code === "ALTA") return "warn";
  if (code === "CRITICA" || code === "BLOCKED") return "bad";
  if (
    code === "FAILED" ||
    code === "INVALID" ||
    code === "CANCELLED" ||
    code === "critico" ||
    code === "recusada"
  ) {
    return "bad";
  }

  // "informativo" cai no padrão (null, sem destaque) de propósito — é o
  // nível que não deve competir visualmente com importante/crítico.
  return null;
}
