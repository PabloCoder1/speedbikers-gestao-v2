import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { Voltar } from "../../../components/voltar";
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
 *
 * Lote 2 do pente fino (D-384, 18/09): os cartões soltos e estilizados à mão
 * viraram a faixa do design system, e os números de "agora" abrem a fila que
 * contam na Caixa de Entrada — a MESMA leitura, então lista e número batem.
 * As legendas perderam o jargão de desenvolvimento ("D-107", "due_at", o
 * caminho do documento): quem lê é o operador.
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

export default async function MetricasSacPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const result = await supabase.rpc("get_support_metrics", { p_days: PERIOD_DAYS }).single();
  const error = result.error;
  const data = result.data as SupportMetricsRow | null;

  const cabecalho = (
    <PageTitle
      eyebrow="ATENDIMENTO / OPERAÇÃO"
      title="Métricas de SAC"
      subtitle="O retrato da fila agora e o fluxo dos últimos 7 dias. O tempo de resolução ainda fica de fora: os relógios de abertura e de resolução não são comparáveis."
      aside={<Voltar href="/atendimento" rotulo="Caixa de Entrada" />}
      compacto
    />
  );

  if (error !== null || data === null) {
    return (
      <Shell>
        {cabecalho}
        <p role="alert" className="sb-inbox-note sb-inbox-note-danger">
          Não foi possível calcular as métricas agora. Tente recarregar a página.
        </p>
      </Shell>
    );
  }

  const agora: KpiCellData[] = [
    {
      label: "Atendimentos abertos",
      formula: "Atendimentos com status interno diferente de Resolvido.",
      value: formatCount(data.abertos_total),
      previous: null,
      ressalva: `perguntas ${formatCount(data.abertos_question)} · mensagens ${formatCount(data.abertos_message)} · reclamações ${formatCount(data.abertos_claim)}`,
      href: "/atendimento",
      tom: "neutro",
    },
    {
      label: "Aguardando a loja",
      formula: "Pergunta sem resposta, ou conversa/reclamação em que o cliente falou por último.",
      value: formatCount(data.aguardando_loja),
      previous: null,
      ressalva: "a próxima resposta é nossa",
      tom: "atencao",
      ...(data.aguardando_loja > 0 ? { destaque: "atencao" as const } : {}),
    },
    {
      label: "Em mediação",
      formula: "Reclamações abertas com mediação do Mercado Livre.",
      value: formatCount(data.mediacoes_abertas),
      previous: null,
      ressalva: "o Mercado Livre entrou no caso",
      href: "/atendimento?mediacao=1",
      tom: "perigo",
      ...(data.mediacoes_abertas > 0 ? { destaque: "perigo" as const } : {}),
    },
    {
      label: "Vence em 24 h",
      formula: "Prazos ativos do Mercado Livre que vencem nas próximas 24 horas.",
      value: formatCount(data.prazos_proximas_24h),
      previous: null,
      ressalva: "prazo informado pelo Mercado Livre",
      href: "/atendimento?prazo=24h",
      tom: "atencao",
    },
    {
      label: "Prazo vencido",
      formula: "Prazos ativos do Mercado Livre com a data no passado.",
      value: formatCount(data.prazos_vencidos),
      previous: null,
      ressalva: "prazo do Mercado Livre já passou",
      href: "/atendimento?prazo=vencido",
      tom: "perigo",
      ...(data.prazos_vencidos > 0 ? { destaque: "perigo" as const } : {}),
    },
  ];

  const periodo: KpiCellData[] = [
    {
      label: "Novas perguntas",
      formula: `Perguntas criadas nos últimos ${String(PERIOD_DAYS)} dias.`,
      value: formatCount(data.novos_question),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Novas conversas",
      formula: `Conversas pós-venda criadas nos últimos ${String(PERIOD_DAYS)} dias.`,
      value: formatCount(data.novos_message),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Novas reclamações",
      formula: `Reclamações criadas nos últimos ${String(PERIOD_DAYS)} dias.`,
      value: formatCount(data.novos_claim),
      previous: null,
      // O histórico anterior a 28/08 veio de carga retroativa, não do fluxo vivo.
      ressalva: "série confiável desde 28/08",
      tom: "neutro",
    },
    {
      label: "Resolvidos",
      formula: `Atendimentos marcados como resolvidos nos últimos ${String(PERIOD_DAYS)} dias.`,
      value: formatCount(data.resolvidos_periodo),
      previous: null,
      tom: "ok",
    },
    {
      label: "Primeira resposta (mediana)",
      formula: "Mediana do tempo entre a primeira mensagem do cliente e a primeira resposta da loja.",
      value:
        data.mediana_primeira_resposta_horas === null
          ? "—"
          : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(data.mediana_primeira_resposta_horas)} h`,
      previous: null,
      ressalva: "perguntas e mensagens; reclamações ficam fora",
      tom: "neutro",
    },
  ];

  return (
    <Shell>
      {cabecalho}

      <Panel title="Agora" subtitle="A fila neste momento, em todas as contas. Os números com link abrem a fila que contam.">
        <div className="sb-panel-body">
          <KpiStrip ancora cells={agora} />
        </div>
      </Panel>

      <div className="sb-inbox-section">
        <Panel title={`Últimos ${String(PERIOD_DAYS)} dias`} subtitle="O que entrou e o que saiu da fila no período.">
          <div className="sb-panel-body">
            <KpiStrip cells={periodo} />
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
