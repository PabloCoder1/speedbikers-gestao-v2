/**
 * Estilos de tabela e card compartilhados (D-232).
 *
 * `th`, `td`, `tdNumber` e `cardStyle` existiam copiados em `/saude`,
 * `/sincronizacao`, `/skus/[skuId]` e nasceram de novo em `/integracoes`. A
 * revisão de D-231 contou a terceira cópia; este módulo é o lugar único. As
 * telas novas importam daqui; migrar as antigas é uma linha por tela e está
 * registrado no HANDOFF — não foi feito na mesma fatia para o diff da fatia
 * continuar dizendo o que ela fez.
 */
/*
 * Cabeçalho e célula do `.table-wrap` do Figma. A família, o peso, o
 * `letter-spacing`, o caixa-alta e o fundo do cabeçalho vêm da regra global de
 * `th` em `globals.css` — ela alcança as 44 tabelas, e não só as duas que
 * importam este módulo. Aqui ficam o tamanho, o espaçamento e a borda, que o
 * inline de cada tela sobrescreveria de qualquer forma.
 *
 * O Figma usa `border-top` nas duas, não `border-bottom`: a linha separa a
 * célula da anterior, e o cabeçalho ganha a sua por cima. O tamanho caiu de
 * 12/14px para 9/11px — a escala dele é densa, e 9, 10 e 11px respondem por
 * 213 das ~300 regras de tamanho medidas no export.
 */
export const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5625rem 0.75rem",
  borderTop: "1px solid var(--sb-border)",
  fontSize: "0.5625rem",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

export const td: React.CSSProperties = {
  padding: "0.75rem",
  borderTop: "1px solid var(--sb-border)",
  fontSize: "0.6875rem",
  verticalAlign: "top",
};

export const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export const cardStyle: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  background: "var(--sb-surface)",
  padding: "var(--sb-space-3)",
  display: "grid",
  gap: "var(--sb-space-2)",
};
