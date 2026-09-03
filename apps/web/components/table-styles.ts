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
export const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

export const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

export const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export const cardStyle: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  padding: "var(--sb-space-3)",
  display: "grid",
  gap: "var(--sb-space-2)",
};
