import type { ReactNode } from "react";

/**
 * Página de fundação da Fase 1.
 *
 * Não é a Home do produto. Existe para provar que o `web` builda, renderiza e
 * carrega a paleta oficial. A Home orientada a "o que precisa da minha atenção
 * hoje?" é assunto da Fase 5A, quando houver dado real para mostrar.
 */

interface FoundationItem {
  readonly label: string;
  readonly detail: string;
  readonly done: boolean;
}

const FOUNDATION: readonly FoundationItem[] = [
  { label: "Monorepo", detail: "pnpm + Turborepo", done: true },
  { label: "Contratos", detail: "@sb/contracts", done: true },
  { label: "Observabilidade", detail: "@sb/observability", done: true },
  { label: "API", detail: "apps/api no Cloud Run", done: true },
  { label: "Worker", detail: "apps/worker no Cloud Run", done: true },
  { label: "Web", detail: "apps/web na Vercel", done: true },
  { label: "Banco", detail: "Supabase V3 Dev", done: false },
  { label: "CI", detail: "GitHub Actions", done: false },
];

export default function Page(): ReactNode {
  return (
    <main
      style={{
        maxWidth: "48rem",
        margin: "0 auto",
        padding: "var(--sb-space-5) var(--sb-space-3)",
      }}
    >
      <p
        style={{
          margin: 0,
          color: "var(--sb-text-soft)",
          fontSize: "0.875rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Speed Bikers Gestão
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0 0", fontSize: "2rem", lineHeight: 1.2 }}>
        V3 — fundação técnica
      </h1>

      <p style={{ color: "var(--sb-text-soft)", marginTop: "var(--sb-space-2)" }}>
        Fase 1. Sem domínio, sem tabela de negócio, sem métrica. O que esta página prova é
        que a esteira está inteira.
      </p>

      <ul
        style={{
          listStyle: "none",
          padding: 0,
          marginTop: "var(--sb-space-4)",
          display: "grid",
          gap: "var(--sb-space-2)",
        }}
      >
        {FOUNDATION.map((item) => (
          <li
            key={item.label}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--sb-space-3)",
              padding: "var(--sb-space-3)",
              border: "1px solid var(--sb-border)",
              borderRadius: "var(--sb-radius)",
              borderLeft: `3px solid ${item.done ? "var(--sb-secondary)" : "var(--sb-muted)"}`,
            }}
          >
            <span style={{ fontWeight: 600, minWidth: "9rem" }}>{item.label}</span>
            <span style={{ color: "var(--sb-text-soft)", flex: 1 }}>{item.detail}</span>
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                letterSpacing: "0.04em",
                color: item.done ? "var(--sb-secondary)" : "var(--sb-supporting)",
              }}
            >
              {item.done ? "PRONTO" : "PENDENTE"}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
