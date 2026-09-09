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

/**
 * Rótulos humanos dos três vocabulários desta tela.
 *
 * **Moraram no `knowledge-row.tsx` até D-268, e o formulário não os tinha** —
 * ele mapeava as constantes acima direto para `<option>`, então o operador
 * escolhia entre `COMPATIBILIDADE` e `CONFIRMACAO_INTERNA`. A tabela mostrava o
 * mesmo enum cru na coluna Fonte.
 *
 * Ficam aqui porque agora há DOIS consumidores, e duas cópias do mesmo mapa é
 * como a auditoria de D-246 achou cinco do mapa de tom. Este módulo já era o
 * lugar certo: é o único desta tela que não é `"use server"` nem cliente.
 *
 * Totais por desenho: valor fora da lista volta cru, nunca inventado.
 */
export const KNOWLEDGE_KIND_LABEL: Record<string, string> = {
  COMPATIBILIDADE: "Compatibilidade",
  ESPECIFICACAO: "Especificação",
  POLITICA: "Política",
  OUTRO: "Outro",
};

export const KNOWLEDGE_SOURCE_LABEL: Record<string, string> = {
  CONFIRMACAO_INTERNA: "Confirmação interna",
  FABRICANTE: "Fabricante",
  DOCUMENTACAO: "Documentação",
  ATENDIMENTO: "Atendimento",
};

export const KNOWLEDGE_STATUS_LABEL: Record<string, string> = {
  SUGERIDO: "Sugerido",
  VALIDADO: "Validado",
  REJEITADO: "Rejeitado",
  OBSOLETO: "Obsoleto",
};
