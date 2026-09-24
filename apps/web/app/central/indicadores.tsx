import Link from "next/link";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { Panel } from "../../components/panel";
import { StatePill } from "../../components/state-pill";
import type { Tom } from "../../components/tone";
import { lerMetaDoMes, situacaoDaMeta, type MetaDoMes } from "../../lib/central-meta";
import { lerVisaoAds, type VisaoAds } from "../../lib/ads";
import {
  entradaDaCentral,
  formatRoas,
  montarIndicadores,
  montarResumo,
  type Formato,
  type GrupoIndicador,
  type Indicador,
  type Sinal,
} from "../../lib/central-indicadores";
import type { PeriodoCentral } from "../../lib/central-periodo";
import { lerFaturamento } from "../../lib/faturamento";
import { formatCount, formatCurrency, formatPercent } from "../../lib/format";
import type { LimitesDaCentral } from "../../lib/limites-central";
import { textoDaVariacao } from "../../lib/variacao";
import { AVISO, type RespostaRpc } from "../faturamento/numeros";
import { SecaoMeta } from "./meta";

function formatar(valor: number | null, formato: Formato): string {
  switch (formato) {
    case "moeda":
      return formatCurrency(valor);
    case "contagem":
      return formatCount(valor);
    case "percentual":
      return formatPercent(valor);
    case "razao":
      return formatRoas(valor);
  }
}

const PONTOS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const RAZAO = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A diferença com sinal explícito, na unidade do comparado: "+R$ 21.000,00", "−38", "−0,8 p.p.", "+0,45x". */
function formatarDiferenca(diferenca: number, formato: Formato): string {
  const sinal = diferenca > 0 ? "+" : diferenca < 0 ? "−" : "";
  const abs = Math.abs(diferenca);

  switch (formato) {
    case "moeda":
      return `${sinal}${formatCurrency(abs)}`;
    case "contagem":
      return `${sinal}${formatCount(abs)}`;
    case "percentual":
      return `${sinal}${PONTOS.format(abs * 100)} p.p.`;
    case "razao":
      return `${sinal}${RAZAO.format(abs)}x`;
  }
}

function anteriorDe(i: Indicador): string | null {
  const v = i.variacao;

  if (v === null) return null;

  const c = i.comparado;
  const rotulo = c.rotulo === null ? "" : ` ${c.rotulo}`;
  const diferenca = c.escala === "valor" && v.diferenca !== 0 ? ` (${formatarDiferenca(v.diferenca, c.formato)})` : "";

  return `${formatar(v.anterior, c.formato)}${rotulo}${diferenca}`;
}

function celula(i: Indicador): KpiCellData {
  const v = i.variacao;
  const c = i.comparado;
  const notas = [
    // Comissão e custo aparecem em reais e são comparados pela participação:
    // a participação atual fica à vista, ou o chip "↓ 0,8 p.p." não teria base.
    c.rotulo === null || c.atual === null ? null : `${formatPercent(c.atual)} ${c.rotulo}`,
    i.ressalva,
    i.semComparacao === null ? null : `sem comparação: ${i.semComparacao}`,
  ].filter((n): n is string => n !== null);

  return {
    metricId: i.metricId,
    label: i.label,
    formula: i.formula,
    value: formatar(i.valor, i.formato),
    previous: anteriorDe(i),
    ...(notas.length > 0 ? { ressalva: notas.join(" · ") } : {}),
    ...(v === null
      ? {}
      : {
          variacao: {
            texto: textoDaVariacao(v, c.escala),
            tom: v.tom,
            titulo:
              c.escala === "fracao"
                ? "variacao_pontos_percentuais: diferença em pontos percentuais contra o período anterior"
                : "variacao_percentual_periodo: (atual − anterior) ÷ anterior",
          },
        }),
  };
}

const GRUPOS: readonly { readonly id: GrupoIndicador; readonly titulo: string; readonly nota: string }[] = [
  { id: "vendas", titulo: "Vendas", nota: "todos os pedidos válidos do período" },
  {
    id: "resultado",
    titulo: "Resultado e lucro",
    nota: "nos pedidos cobertos: frete observado, custo conhecido e um produto; imposto pela alíquota do dia",
  },
  { id: "custos", titulo: "Custos da venda", nota: "comissão e custo comparados pela participação na receita" },
  { id: "ads", titulo: "Mercado Ads", nota: "Product Ads, pela atribuição do Mercado Livre" },
];

const ROTULO_DO_TOM: Readonly<Record<Tom, string>> = {
  perigo: "piora forte",
  atencao: "atenção",
  ok: "melhora",
  info: "info",
  neutro: "estável",
};

function ListaDeSinais({ titulo, sinais, vazio }: { titulo: string; sinais: readonly Sinal[]; vazio: string }): ReactNode {
  return (
    <div className="sb-central-sinais">
      <h3>{titulo}</h3>
      {sinais.length === 0 ? (
        <p className="sb-texto-suave">{vazio}</p>
      ) : (
        <ul>
          {sinais.map((s) => (
            <li key={s.indicador}>
              <StatePill tone={{ tom: s.tom, label: ROTULO_DO_TOM[s.tom] }} />
              <span>{s.texto}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TabelaDeComparacao({ indicadores }: { indicadores: readonly Indicador[] }): ReactNode {
  return (
    <div className="sb-central-tabela">
      <table className="sb-table">
        <thead>
          <tr>
            <th>Indicador</th>
            <th className="sb-num">Atual</th>
            <th className="sb-num">Anterior</th>
            <th className="sb-num">Diferença</th>
            <th className="sb-num">Variação</th>
          </tr>
        </thead>
        <tbody>
          {indicadores.map((i) => {
            const c = i.comparado;
            const v = i.variacao;

            return (
              <tr key={i.id}>
                <td>
                  <strong>{i.label}</strong>
                  {c.rotulo !== null && <span className="sb-texto-suave"> (participação {c.rotulo})</span>}
                  {i.semComparacao !== null && <span className="sb-central-motivo">{i.semComparacao}</span>}
                </td>
                <td className="sb-num">{formatar(c.atual, c.formato)}</td>
                <td className="sb-num">{v === null ? "—" : formatar(v.anterior, c.formato)}</td>
                <td className="sb-num">{v === null ? "—" : formatarDiferenca(v.diferenca, c.formato)}</td>
                <td className="sb-num">
                  {v === null ? "—" : <StatePill tone={{ tom: v.tom, label: textoDaVariacao(v, c.escala) }} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A resposta da RPC com o código do PostgREST, para distinguir "função ausente" de erro. */
export interface RespostaComCodigo {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/**
 * A meta lida, ou o motivo de não ter meta. PGRST202 (função ausente) não é
 * erro: a web da `main` chega à produção antes de a migration passar pelo
 * workflow, e a tela diz que a meta está sendo ativada — o precedente de D-363.
 */
function lerMeta(resposta: RespostaComCodigo | null): { meta: MetaDoMes | null; indisponivel: string | null } {
  if (resposta === null) return { meta: null, indisponivel: "Sessão sem organização: a meta não pode ser lida." };

  if (resposta.error !== null) {
    return {
      meta: null,
      indisponivel:
        resposta.error.code === "PGRST202"
          ? "A meta e a projeção estão sendo ativadas neste ambiente."
          : `Não foi possível carregar a meta: ${resposta.error.message}`,
    };
  }

  const meta = lerMetaDoMes(resposta.data);

  return meta === null
    ? { meta: null, indisponivel: "A meta veio num formato que esta tela não reconhece — nada foi mostrado." }
    : { meta, indisponivel: null };
}

/** A meta vira sinal no resumo: em risco ou improvável pede atenção; no caminho, melhora. */
function sinalDaMeta(meta: MetaDoMes | null, atrasoDaMeta: number): Sinal | null {
  if (meta?.situacao !== "em_curso" || meta.meta === null) return null;

  const leitura = situacaoDaMeta(meta, atrasoDaMeta);

  if (leitura.tom !== "perigo" && leitura.tom !== "atencao" && leitura.tom !== "ok") return null;

  return { tom: leitura.tom, texto: `Meta do mês — ${leitura.rotulo}`, indicador: "meta" };
}

/**
 * Tudo que depende das leituras — fora da página para ela só cuidar de
 * filtro e streaming, como `faturamento/numeros.tsx`.
 */
export async function Indicadores({
  leituras,
  leituraMeta,
  leituraLimites,
  periodo,
  podeEditar,
}: {
  leituras: Promise<readonly [RespostaRpc, RespostaRpc, RespostaRpc, RespostaRpc]>;
  leituraMeta: Promise<RespostaComCodigo> | null;
  leituraLimites: Promise<LimitesDaCentral>;
  periodo: PeriodoCentral;
  podeEditar: boolean;
}): Promise<ReactNode> {
  const [[atualResult, anteriorResult, adsResult, adsAnteriorResult], respostaMeta, limites] = await Promise.all([
    leituras,
    leituraMeta,
    leituraLimites,
  ]);
  const { meta, indisponivel } = lerMeta(respostaMeta);

  if (atualResult.error !== null) {
    return (
      <p role="alert" style={AVISO}>
        Não foi possível carregar o período: {atualResult.error.message}
      </p>
    );
  }

  const atual = lerFaturamento(atualResult.data);

  if (atual === null) {
    return (
      <p role="alert" style={AVISO}>
        A resposta do faturamento veio num formato que esta tela não reconhece — nenhum número foi mostrado para não
        mostrar número errado.
      </p>
    );
  }

  // Falha do período anterior ou do Ads não vira zero (D-067): a comparação
  // sai, e cada indicador diz por quê.
  const faturamentoAnterior = anteriorResult.error === null ? lerFaturamento(anteriorResult.data) : null;
  const anterior = faturamentoAnterior?.resumo ?? null;
  const ads: VisaoAds | null = adsResult.error === null ? lerVisaoAds(adsResult.data) : null;
  const adsAnterior: VisaoAds | null = adsAnteriorResult.error === null ? lerVisaoAds(adsAnteriorResult.data) : null;

  const entrada = entradaDaCentral(atual, faturamentoAnterior, ads, adsAnterior, periodo);

  const indicadores = montarIndicadores(entrada, limites);
  const resumo = montarResumo(indicadores, entrada, periodo.preset);
  const sinalMeta = sinalDaMeta(meta, limites.atrasoDaMeta);
  const atencao = sinalMeta !== null && sinalMeta.tom !== "ok" ? [sinalMeta, ...resumo.atencao] : resumo.atencao;
  const melhoras = sinalMeta !== null && sinalMeta.tom === "ok" ? [sinalMeta, ...resumo.melhoras] : resumo.melhoras;

  return (
    <>
      {anterior === null && (
        <p role="alert" style={AVISO}>
          O período anterior não carregou — a comparação foi omitida, e isso não é zero.
        </p>
      )}

      <Panel
        id="resumo-do-periodo"
        title="Resumo do período"
        subtitle="Montado a partir dos números abaixo; cada frase só afirma o que eles sustentam."
      >
        <div className="sb-panel-body sb-central-resumo">
          <div className="sb-central-frases">
            {resumo.frases.map((frase) => (
              <p key={frase}>{frase}</p>
            ))}
          </div>

          <div className="sb-central-listas">
            <ListaDeSinais
              titulo="Pede atenção"
              sinais={atencao}
              vazio="Nenhum indicador piorou além da zona neutra."
            />
            <ListaDeSinais titulo="Melhorou" sinais={melhoras} vazio="Nenhum indicador melhorou além da zona neutra." />
          </div>
        </div>
      </Panel>

      <SecaoMeta meta={meta} indisponivel={indisponivel} podeEditar={podeEditar} atrasoDaMeta={limites.atrasoDaMeta} />

      {GRUPOS.map((grupo, indice) => (
        <section key={grupo.id} aria-label={grupo.titulo}>
          <div className="sb-section-label">
            <span>{grupo.titulo}</span>
            <span className="sb-section-note">{grupo.nota}</span>
          </div>

          <KpiStrip ancora={indice === 0} cells={indicadores.filter((i) => i.grupo === grupo.id).map(celula)} />
        </section>
      ))}

      <div className="sb-central-bloco">
        <Panel
          title="Comparação completa"
          subtitle="Atual, anterior, diferença e variação de cada indicador. Comissão e custo são comparados pela participação na receita."
        >
          <TabelaDeComparacao indicadores={indicadores} />
        </Panel>
      </div>

      <div className="sb-central-bloco">
        <div className="sb-note">
          <span>COMO LER</span>
          <p>
            <strong>A cor depende do indicador:</strong> faturamento que sobe é bom; frete, comissão, custo, ACOS e TACoS
            que sobem são ruins; investimento em Ads não é julgado sozinho — quem julga é o ROAS e o TACoS.
          </p>
          <p>
            Movimentos menores que {formatPercent(limites.variacao.valor.neutro)} (ou{" "}
            {PONTOS.format(limites.variacao.fracao.neutro * 100)} p.p. nas porcentagens) são tratados como estáveis.
            Contra o indicador, até {formatPercent(limites.variacao.valor.forte)} (
            {PONTOS.format(limites.variacao.fracao.forte * 100)} p.p.) é atenção; acima disso, piora forte. Margens e
            médias só se comparam com {formatCount(limites.amostraMinima)} pedidos ou mais nos dois períodos.{" "}
            {limites.personalizados ? "Limites da empresa" : "Limites padrão"} —{" "}
            <Link href="/central/limites">ver e ajustar</Link>.
          </p>
          <p>
            Resultado e margem só existem nos pedidos com frete gravado (desde 14/09/2026), custo conhecido e um produto.
            Quando a cobertura dos dois períodos é muito diferente, a comparação do resultado em reais é omitida — ela
            compararia a captura do frete, não o negócio.
          </p>
        </div>
      </div>
    </>
  );
}
