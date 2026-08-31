/**
 * Máquina de estados da republicação oficial (Fase 9, D-159).
 *
 * A pesquisa oficial (`docs/MERCADO_LIVRE.md` secao 2.16) fixa o que este
 * modelo precisa carregar: o fluxo real é fechar o pai (`PUT status=closed`,
 * IRREVERSÍVEL) e só então `POST /items/{id}/relist` — e **a API não oferece
 * idempotência nenhuma** (busca literal por Idempotency em toda a doc: zero).
 * A proteção contra fechar um anúncio sem criar o filho, ou criar dois
 * filhos, é 100% nossa — e mora AQUI e nas constraints do banco, nunca em
 * boa vontade de handler.
 *
 * O desenho separa três famílias de estado:
 *
 * - **Seguros de reabrir** (`RELIST_REOPENABLE_STATES`): nada destrutivo
 *   aconteceu no Mercado Livre — preflight reprovou, ou o fechamento falhou
 *   com o pai conferido como ainda ativo. Uma NOVA operação para o mesmo pai
 *   é permitida (é o predicado do índice único parcial do banco).
 * - **Vivos**: a operação está no meio do caminho; o índice único garante
 *   que não existe uma segunda para o mesmo pai.
 * - **`RELIST_FAILED` — o estado que exige gente**: o pai está FECHADO e o
 *   filho não existe (ou não foi confirmado). É a janela perigosa que a
 *   pesquisa nomeou; não é terminal (o retry humano volta para RELISTING,
 *   depois de reconferir o remoto), e nunca é reaberto como operação nova —
 *   a existente precisa ser resolvida.
 */

export const RELIST_STATES = [
  /** Humano pediu; snapshot do pai capturado; nada remoto ainda. */
  "REQUESTED",
  /** Pré-condição crítica reprovou; NADA foi feito no ML. Terminal seguro. */
  "PREFLIGHT_FAILED",
  /** O comando de fechar o pai foi (ou está sendo) emitido. */
  "CLOSING",
  /** Pai confirmado fechado no remoto. Pronto para o POST /relist. */
  "CLOSED",
  /** Fechamento falhou E o pai foi reconferido como ainda ativo. Terminal seguro. */
  "CLOSE_FAILED",
  /** POST /relist emitido — a janela perigosa (sem idempotência remota). */
  "RELISTING",
  /** Filho existe (child_item_id confirmado, com parent_item_id apontando para o pai). */
  "RELISTED",
  /** Pai fechado SEM filho confirmado — exige decisão humana, nunca retry automático. */
  "RELIST_FAILED",
  /** Vínculos de variação/SKU remapeados para o filho. Terminal de sucesso. */
  "REMAPPED",
] as const;

export type RelistState = (typeof RELIST_STATES)[number];

const TRANSITIONS: Readonly<Record<RelistState, readonly RelistState[]>> = {
  REQUESTED: ["PREFLIGHT_FAILED", "CLOSING"],
  PREFLIGHT_FAILED: [],
  CLOSING: ["CLOSED", "CLOSE_FAILED"],
  CLOSED: ["RELISTING"],
  CLOSE_FAILED: [],
  RELISTING: ["RELISTED", "RELIST_FAILED"],
  // Só com autorização humana e depois de reconferir o remoto (um filho pode
  // ter nascido sem a resposta chegar) — a regra é do chamador; a máquina só
  // garante que o ÚNICO caminho de saída é tentar de novo, nunca "desistir
  // em silêncio" com um pai fechado.
  RELIST_FAILED: ["RELISTING"],
  RELISTED: ["REMAPPED"],
  REMAPPED: [],
};

export function canTransitionRelist(from: RelistState, to: RelistState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Estados sem transição de saída — a operação acabou (bem ou mal, mas acabou). */
export const RELIST_TERMINAL_STATES: readonly RelistState[] = ["PREFLIGHT_FAILED", "CLOSE_FAILED", "REMAPPED"];

/**
 * Estados em que uma NOVA operação para o MESMO pai é permitida — nada
 * destrutivo aconteceu no Mercado Livre. É o predicado do índice único
 * parcial `listing_relists_one_live_per_parent`; mudar aqui exige mudar lá
 * (o teste de integração fixa a equivalência dos dois lados).
 */
export const RELIST_REOPENABLE_STATES: readonly RelistState[] = ["PREFLIGHT_FAILED", "CLOSE_FAILED"];

/**
 * O estado que não pode esperar num backlog: pai fechado (irreversível) sem
 * filho confirmado. Consumidor futuro: severidade de notificação e a Central
 * de Ações.
 */
export function relistStateRequiresHuman(state: RelistState): boolean {
  return state === "RELIST_FAILED";
}
