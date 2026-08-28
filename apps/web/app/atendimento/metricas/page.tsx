import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { formatCount } from "../../../lib/format";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Métricas de SAC — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Métricas de SAC (Fase 7B, D-115) — espelho de `docs/METRICS.md` secao 5B,
 * que é normativo: se um número aqui discordar de lá, o número está errado.
 *
 * Tudo agregado em SQL (`get_support_metrics`, security invoker — a RLS
 * decide o escopo). Janela fixa de 7 dias nesta fatia, sem seletor.
 */

const PERIOD_DAYS = 7;

/**
 * O gerador de types não infere nulabilidade de coluna de retorno de RPC
 * (mesmo achado de `CoverageRow`, D-058): `mediana` vem `null` quando não
 * houve NENHUM par pergunta→resposta no período, e `data` vem `null` em
 * falha do `.single()`.
 */
interface SupportMetricsRow {
  abertos_total: number;
  abertos_question: number;
  abertos_message: number;
  abertos_claim: number;
  aguardando_loja: number;
  mediacoes_abertas: number;
  prazos_proximas_24h: number;
  prazos_vencidos: number;
  novos_question: number;
  novos_message: number;
  novos_claim: number;
  resolvidos_periodo: number;
  mediana_primeira_resposta_horas: number | null;
}

interface Tile {
  label: string;
  value: string;
  caption: string;
  emphasis?: boolean;
}

function MetricTile({ tile }: { tile: Tile }): ReactNode {
  return (
    <div
      style={{
        padding: "var(--sb-space-3)",
        borderRadius: "var(--sb-radius)",
        border: "1px solid var(--sb-border)",
        borderLeft: `3px solid ${tile.emphasis === true ? "var(--sb-danger)" : "var(--sb-primary)"}`,
        background: "var(--sb-surface)",
      }}
    >
      <div style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>{tile.label}</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0.125rem 0" }}>{tile.value}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>{tile.caption}</div>
    </div>
  );
}

export default async function MetricasSacPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const result = await supabase.rpc("get_support_metrics", { p_days: PERIOD_DAYS }).single();
  const error = result.error;
  const data = result.data as SupportMetricsRow | null;

  if (error !== null || data === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Métricas de SAC</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível calcular as métricas{error === null ? "" : `: ${error.message}`}.
        </p>
      </Shell>
    );
  }

  const agora: Tile[] = [
    { label: "Atendimentos abertos", value: formatCount(data.abertos_total), caption: `perguntas ${String(data.abertos_question)} · mensagens ${String(data.abertos_message)} · reclamações ${String(data.abertos_claim)}` },
    { label: "Aguardando a loja", value: formatCount(data.aguardando_loja), caption: "a bola está conosco", emphasis: data.aguardando_loja > 0 },
    { label: "Em mediação", value: formatCount(data.mediacoes_abertas), caption: "representante do ML no caso", emphasis: data.mediacoes_abertas > 0 },
    { label: "Prazos nas próximas 24h", value: formatCount(data.prazos_proximas_24h), caption: "prazo remoto real (D-107)", emphasis: data.prazos_proximas_24h > 0 },
    { label: "Prazos vencidos", value: formatCount(data.prazos_vencidos), caption: "ativos com due_at no passado", emphasis: data.prazos_vencidos > 0 },
  ];

  const periodo: Tile[] = [
    { label: "Novas perguntas", value: formatCount(data.novos_question), caption: `últimos ${String(PERIOD_DAYS)} dias` },
    { label: "Novas conversas", value: formatCount(data.novos_message), caption: `últimos ${String(PERIOD_DAYS)} dias` },
    { label: "Novas reclamações", value: formatCount(data.novos_claim), caption: "série confiável a partir de 28/08 — antes é backfill" },
    { label: "Resolvidos", value: formatCount(data.resolvidos_periodo), caption: `últimos ${String(PERIOD_DAYS)} dias` },
    {
      label: "Primeira resposta (mediana)",
      value: data.mediana_primeira_resposta_horas === null ? "—" : `${String(data.mediana_primeira_resposta_horas)} h`,
      caption: "perguntas e mensagens; reclamações fora (transcript é piso)",
    },
  ];

  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "var(--sb-space-3)",
    marginBottom: "var(--sb-space-4)",
  };

  return (
    <Shell>
      <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem" }}>
        <Link href="/atendimento" style={{ color: "var(--sb-secondary)" }}>
          ← Caixa de Entrada
        </Link>
      </p>

      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Métricas de SAC</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.875rem" }}>
        Definições canônicas em docs/METRICS.md §5B. Tempo de resolução fica de fora por enquanto:
        os relógios de criação e resolução não são comparáveis ainda.
      </p>

      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1rem" }}>Agora</h2>
      <div style={grid}>
        {agora.map((tile) => (
          <MetricTile key={tile.label} tile={tile} />
        ))}
      </div>

      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1rem" }}>Últimos {PERIOD_DAYS} dias</h2>
      <div style={grid}>
        {periodo.map((tile) => (
          <MetricTile key={tile.label} tile={tile} />
        ))}
      </div>
    </Shell>
  );
}
