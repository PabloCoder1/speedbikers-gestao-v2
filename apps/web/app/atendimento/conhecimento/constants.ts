/**
 * Tipos e fontes de uma entrada da Base de Conhecimento — valores, sem servidor.
 *
 * **Por que este arquivo existe, e não vive em `actions.ts`.** Aquele módulo é
 * `"use server"`, e o contrato do Next é que TODO export de um módulo assim
 * seja função assíncrona: o bundler troca cada export por uma referência de
 * servidor. Uma constante exportada de lá chega ao componente cliente como
 * essa referência, e `.map(...)` deixa de existir.
 *
 * O `build` passa. O `typecheck` passa. A tela morre em runtime — a classe
 * D-131, "não quebra, mente". Medido: `/atendimento/conhecimento` devolvia HTTP 500 sempre, porque o formulário renderiza incondicionalmente.
 *
 * `scripts/check-server-actions.mjs` guarda contra a próxima.
 */

export const KNOWLEDGE_KINDS = ["COMPATIBILIDADE", "ESPECIFICACAO", "POLITICA", "OUTRO"] as const;
export const KNOWLEDGE_SOURCES = ["CONFIRMACAO_INTERNA", "FABRICANTE", "DOCUMENTACAO", "ATENDIMENTO"] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];
