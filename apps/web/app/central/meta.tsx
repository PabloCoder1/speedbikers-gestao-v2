import Link from "next/link";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { Panel } from "../../components/panel";
import { StatePill } from "../../components/state-pill";
import { TOM } from "../../components/tone";
import {
  ritmoDaMeta,
  rotuloDoDiaDaSemana,
  situacaoDaMeta,
  type MetaDoMes,
} from "../../lib/central-meta";
import { formatCount, formatCurrency, formatPercent } from "../../lib/format";
import { rotuloDoMes } from "../../lib/metas-imposto";

const FATOR = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function comSinal(valor: number): string {
  return `${valor > 0 ? "+" : valor < 0 ? "−" : ""}${formatCurrency(Math.abs(valor))}`;
}

/** "−R$ 12.700,00 até a meta" / "+R$ 3.000,00 acima da meta": a distância de um cenário até a meta, como ressalva. */
function contraAMeta(valor: number, meta: number | null): { ressalva?: string } {
  if (meta === null) return {};

  const diferenca = valor - meta;

  return { ressalva: diferenca >= 0 ? `${comSinal(diferenca)} acima da meta` : `${comSinal(diferenca)} até a meta` };
}

function celulasDaMeta(m: MetaDoMes): KpiCellData[] {
  const celulas: KpiCellData[] = [
    {
      label: "Meta do mês",
      formula: "monthly_goals.revenue_goal — cadastrada em Metas e imposto",
      value: m.meta === null ? "sem meta" : formatCurrency(m.meta),
      previous: null,
      ressalva: "da empresa inteira, todas as contas",
    },
    {
      metricId: "atingimento_meta",
      label: m.situacao === "encerrado" ? "Realizado no mês" : "Realizado até agora",
      formula: "receita bruta das vendas válidas do mês (hoje até a última atualização do resumo diário)",
      value: formatCurrency(m.realizado),
      previous: null,
      ressalva:
        m.atingimento === null
          ? m.situacao === "em_curso"
            ? `hoje: ${formatCurrency(m.realizado_hoje)} até a última atualização`
            : "sem meta para comparar"
          : `${formatPercent(m.atingimento)} da meta`,
    },
  ];

  if (m.faltam !== null) {
    celulas.push({
      metricId: "atingimento_meta",
      label: "Faltam",
      formula: "max(meta − realizado, 0)",
      value: formatCurrency(m.faltam),
      previous: null,
      ...(m.faltam === 0 ? { destaque: "ok" as const } : {}),
    });
  }

  if (m.situacao !== "em_curso") return celulas;

  const ritmo = ritmoDaMeta(m);

  if (m.esperado_ate_ontem !== null) {
    celulas.push({
      metricId: "esperado_meta",
      label: "Esperado até ontem",
      formula: "meta × fatores dos dias completos ÷ fatores do mês (o domingo fraco não conta como atraso)",
      value: formatCurrency(m.esperado_ate_ontem),
      previous: null,
      ...(ritmo === null ? {} : { ressalva: ritmo.texto, destaque: ritmo.tom }),
    });
  }

  celulas.push({
    metricId: "receita_media_diaria",
    label: "Média diária",
    formula: "realizado até ontem ÷ dias completos do mês",
    value: formatCurrency(m.media_diaria),
    previous: null,
    ressalva: `${formatCount(m.dias_completos)} dias completos`,
  });

  if (m.meta_diaria_necessaria !== null) {
    const aumento = m.aumento_necessario;

    celulas.push({
      metricId: "meta_diaria_necessaria",
      label: "Meta diária necessária",
      formula: "max(meta − realizado até ontem, 0) ÷ dias restantes, hoje incluído",
      value: formatCurrency(m.meta_diaria_necessaria),
      previous: null,
      ressalva: `${formatCount(m.dias_restantes)} dias restantes${
        aumento === null
          ? ""
          : aumento > 0
            ? ` · ${formatPercent(aumento)} acima da média atual`
            : ` · ${formatPercent(-aumento)} abaixo da média atual`
      }`,
      ...(aumento !== null && aumento > 0.1 ? { destaque: "perigo" as const } : {}),
    });
  }

  return celulas;
}

function celulasDaProjecao(m: MetaDoMes): KpiCellData[] {
  const p = m.projecao;

  if (p === null) return [];

  const celulas: KpiCellData[] = [
    {
      metricId: "projecao_fechamento_mes",
      label: "Conservador",
      formula: "realizado até ontem + o MENOR ritmo entre 7, 14 e 28 dias × fatores dos dias restantes",
      value: formatCurrency(p.conservador),
      previous: null,
      ...contraAMeta(p.conservador, m.meta),
    },
    {
      metricId: "projecao_fechamento_mes",
      label: "Ritmo atual",
      formula: "realizado até ontem + ritmo dos últimos 28 dias × fatores dos dias restantes",
      value: formatCurrency(p.ritmo),
      previous: null,
      ...contraAMeta(p.ritmo, m.meta),
      // A cor do cenário central é a do veredito: no caminho, em risco (só o
      // otimista alcança) ou improvável (nem ele).
      ...(m.meta === null
        ? {}
        : { destaque: p.ritmo >= m.meta ? ("ok" as const) : p.otimista >= m.meta ? ("atencao" as const) : ("perigo" as const) }),
    },
    {
      metricId: "projecao_fechamento_mes",
      label: "Otimista",
      formula: "realizado até ontem + o MAIOR ritmo entre 7, 14 e 28 dias × fatores dos dias restantes",
      value: formatCurrency(p.otimista),
      previous: null,
      ...contraAMeta(p.otimista, m.meta),
    },
  ];

  const ano = m.ano_anterior;

  if (ano !== null && ano.projecao_sazonal !== null) {
    celulas.push({
      metricId: "projecao_sazonal_mes",
      label: "Pelo mesmo mês do ano passado",
      formula: "realizado até ontem ÷ (fatia do mês do ano passado vendida até o mesmo dia)",
      value: formatCurrency(ano.projecao_sazonal),
      previous: null,
      ressalva: `o mesmo mês fechou em ${formatCurrency(ano.receita_mes)}${
        ano.crescimento === null
          ? ""
          : ` · até aqui ${ano.crescimento >= 0 ? "+" : "−"}${formatPercent(Math.abs(ano.crescimento))} sobre ele`
      }`,
    });
  }

  return celulas;
}

function BarraDaMeta({ m }: { m: MetaDoMes }): ReactNode {
  if (m.meta === null || m.realizado === null) return null;

  const feito = Math.min(1, Math.max(0, m.realizado / m.meta));
  const esperado = m.esperado_ate_ontem === null ? null : Math.min(1, Math.max(0, m.esperado_ate_ontem / m.meta));

  return (
    <div className="sb-meta-barra-bloco">
      <div
        className="sb-meta-barra"
        role="progressbar"
        aria-label="Realizado da meta do mês"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(feito * 100)}
      >
        <span className="sb-meta-barra-feito" style={{ width: `${(feito * 100).toFixed(1)}%` }} />
        {esperado !== null && (
          <span
            className="sb-meta-barra-esperado"
            style={{ left: `${(esperado * 100).toFixed(1)}%` }}
            title={`esperado até ontem: ${formatCurrency(m.esperado_ate_ontem)}`}
          />
        )}
      </div>
      <p className="sb-meta-barra-legenda">
        <strong>{formatPercent(m.atingimento)}</strong> — {formatCurrency(m.realizado)} de {formatCurrency(m.meta)}
        {esperado !== null && <span> · o traço marca o esperado até ontem</span>}
      </p>
    </div>
  );
}

/**
 * A meta do mês e a projeção de fechamento (D-395). Sempre o mês corrente e a
 * empresa inteira: a meta não é por conta e não muda com o período escolhido
 * na central — o subtítulo diz isso, para ninguém comparar a meta com um recorte.
 */
export function SecaoMeta({
  meta,
  indisponivel,
  podeEditar,
}: {
  meta: MetaDoMes | null;
  /** Texto do motivo quando a leitura não veio (função ausente, erro, contrato). */
  indisponivel: string | null;
  podeEditar: boolean;
}): ReactNode {
  const cabecalho = (
    <div className="sb-section-label">
      <span>Meta e projeção</span>
      <span className="sb-section-note">mês corrente, empresa inteira · não muda com o período escolhido acima</span>
    </div>
  );

  if (meta === null) {
    return (
      <section aria-label="Meta e projeção">
        {cabecalho}
        <p className="sb-empty">{indisponivel ?? "A meta do mês não carregou."}</p>
      </section>
    );
  }

  const leitura = situacaoDaMeta(meta);
  const ritmo = ritmoDaMeta(meta);
  const nomeDoMes = rotuloDoMes(meta.mes);
  const diaDoMes = meta.dias_completos === null ? null : meta.dias_completos + 1;
  const projecao = celulasDaProjecao(meta);

  return (
    <section aria-label="Meta e projeção">
      {cabecalho}

      <Panel
        title={`Meta de ${nomeDoMes}`}
        subtitle={
          meta.situacao === "em_curso" && diaDoMes !== null
            ? `Dia ${String(diaDoMes)} de ${String(meta.dias_no_mes)} — hoje entra pela média, não pelo parcial.`
            : `${String(meta.dias_no_mes)} dias.`
        }
        aside={<StatePill tone={{ tom: leitura.tom, label: leitura.rotulo }} />}
      >
        <div className="sb-panel-body sb-meta">
          <p className="sb-meta-frase">{leitura.frase}</p>

          <BarraDaMeta m={meta} />

          {ritmo !== null && (
            <p className="sb-meta-ritmo" style={{ color: TOM[ritmo.tom].color }}>
              {ritmo.texto}.
            </p>
          )}

          {meta.meta === null &&
            (podeEditar ? (
              <Link className="sb-button sb-button-primary" href="/central/metas">
                Definir a meta de {nomeDoMes}
              </Link>
            ) : (
              <p className="sb-texto-suave">Peça a um ADMIN ou GESTOR para cadastrar a meta em Metas e imposto.</p>
            ))}
        </div>
      </Panel>

      <div className="sb-central-bloco">
        <KpiStrip cells={celulasDaMeta(meta)} />
      </div>

      {meta.situacao === "em_curso" && (
        <div className="sb-central-bloco">
          {projecao.length === 0 ? (
            <p className="sb-empty">
              Sem histórico suficiente para projetar o fechamento: a projeção precisa de ao menos 7 dias completos de
              vendas.
            </p>
          ) : (
            <>
              <div className="sb-section-label">
                <span>Projeção de fechamento</span>
                <span className="sb-section-note">três cenários, pelo ritmo das últimas semanas</span>
              </div>
              <KpiStrip cells={projecao} />
            </>
          )}

          <div className="sb-note sb-central-bloco">
            <span>COMO A PROJEÇÃO É FEITA</span>
            <p>
              Cada dia da semana tem um peso, medido nas últimas 8 semanas completas
              {meta.perfil_semanal ? ":" : " — ainda sem histórico para isso, todos os dias pesam igual."}{" "}
              {meta.perfil_semanal &&
                meta.fatores.map((f) => `${rotuloDoDiaDaSemana(f.dia_semana)} ${FATOR.format(f.fator)}`).join(" · ")}
              {meta.perfil_semanal && "."} O ritmo atual é a venda das últimas 4 semanas ajustada por esses pesos;
              conservador e otimista são o menor e o maior ritmo entre 1, 2 e 4 semanas. O realizado até ontem mais o
              ritmo aplicado aos dias que faltam dá o fechamento.
            </p>
            <p>
              <strong>Não entram:</strong> datas comerciais (Black Friday, Dia dos Pais) — o sistema ainda não tem
              calendário de eventos — e o parcial de hoje, que entra pela média do dia da semana.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
