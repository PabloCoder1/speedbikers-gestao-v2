/**
 * Estados de uma sugestão de melhoria — valores, sem servidor.
 *
 * **Por que este arquivo existe, e não vive em `actions.ts`.** Aquele módulo é
 * `"use server"`, e o contrato do Next é que TODO export de um módulo assim
 * seja função assíncrona: o bundler troca cada export por uma referência de
 * servidor. Uma constante exportada de lá chega ao componente cliente como
 * essa referência, e `.map(...)` deixa de existir.
 *
 * O `build` passa. O `typecheck` passa. A tela morre em runtime — a classe
 * D-131, "não quebra, mente". Medido: `/sugestoes` devolvia HTTP 500 assim que existia UMA sugestão no banco (com a tabela vazia a linha nunca renderizava, então o defeito ficou latente).
 *
 * `scripts/check-server-actions.mjs` guarda contra a próxima.
 */

export const SUGGESTION_STATUS_VALUES = [
  "nova",
  "em_analise",
  "aprovada",
  "planejada",
  "em_desenvolvimento",
  "entregue",
  "recusada",
] as const;

export type SuggestionStatus = (typeof SUGGESTION_STATUS_VALUES)[number];
