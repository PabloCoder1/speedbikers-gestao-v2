import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A "pílula" de filtro, compartilhada por `/vendas`, `/anuncios`, `/estoque`,
 * `/curva-abc` e `/atendimento` (D-141).
 *
 * Era o MESMO `pillStyle` copiado em cinco arquivos — cinco lugares para
 * divergir em cor, raio de borda ou contraste, sem que nada quebre quando
 * divergissem. Continua Server Component: é um `Link` estilizado, sem estado.
 *
 * `aria-current` acompanha o estado ativo. Sem ele, a única pista de qual
 * filtro está aplicado é a cor — invisível para leitor de tela e para quem não
 * distingue os dois tons.
 */
/**
 * `tone` existe por um caso real, não por antecipação: em `/atendimento` o
 * filtro "⏱ Prazo em risco" fica VERMELHO quando ativo, porque ali "ligado"
 * significa risco, não seleção. Era a única das dezoito pílulas que divergia,
 * e apagar essa diferença na extração teria trocado um alerta por um filtro
 * comum.
 */
export function FilterPill({
  href,
  active,
  tone = "primary",
  children,
}: {
  href: string;
  active: boolean;
  tone?: "primary" | "danger";
  children: ReactNode;
}): ReactNode {
  const accent = tone === "danger" ? "var(--sb-danger)" : "var(--sb-primary)";

  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      style={{
        padding: "0.25rem 0.625rem",
        borderRadius: "var(--sb-radius)",
        border: `1px solid ${active ? accent : "var(--sb-border)"}`,
        background: active ? accent : "transparent",
        color: active ? "#fff" : "var(--sb-text-soft)",
        textDecoration: "none",
        fontSize: "0.8125rem",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </Link>
  );
}

/**
 * O gêmeo em `<button>` do `FilterPill`, para o submit nativo dos formulários
 * de busca — que precisa continuar sendo botão, não link. Mesmo desenho, para
 * a barra de filtros não ter duas aparências lado a lado.
 */
export const FILTER_SUBMIT_STYLE: React.CSSProperties = {
  padding: "0.25rem 0.625rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "transparent",
  color: "var(--sb-text-soft)",
  fontSize: "0.8125rem",
  cursor: "pointer",
};

/**
 * O rótulo de um grupo de filtros ("Conta", "Marca", "Critério"). Largura
 * mínima igual em todas as telas para os grupos alinharem verticalmente —
 * era o tipo de detalhe que divergia entre as cinco cópias.
 */
export function FilterGroup({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
      <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "5rem" }}>{label}</span>
      {children}
    </div>
  );
}
