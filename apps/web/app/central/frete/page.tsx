import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../components/carregando";
import { FilterPill } from "../../../components/filter-pill";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatePill } from "../../../components/state-pill";
import {
  diasEntre,
  lerDetectorFrete,
  motivosDoAlerta,
  NIVEL,
  ROTULO_DA_FAIXA,
  sugestaoDoAlerta,
  type AlertaDeFrete,
  type DetectorDeFrete,
  type NivelFrete,
} from "../../../lib/detector-frete";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../../lib/format";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { AVISO } from "../../faturamento/numeros";

export const metadata = { title: "Detector de frete — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

/**
 * Detector de frete possivelmente errado (D-397) — os anúncios cujo frete
 * destoa do próprio histórico, dos outros anúncios do mesmo produto, dos pares
 * da categoria ou do preço, com o motivo escrito.
 *
 * **Uma RPC, `get_detector_frete`,** que já devolve pontos, níveis e as
 * referências de cada comparação; a tela só escreve os motivos
 * (`lib/detector-frete.ts`). A organização inteira, sem filtro de conta: os
 * pares e a faixa de preço valem para todas as contas, e o mesmo produto em
 * duas contas é justamente a comparação mais forte.
 */

type Consulta = Record<string, string | string[] | undefined>;

const NIVEIS_DA_LISTA: readonly NivelFrete[] = ["forte", "provavel", "atencao"];

function nivelDaUrl(query: Consulta): NivelFrete | null {
  const valor = typeof query.nivel === "string" ? query.nivel : null;

  return NIVEIS_DA_LISTA.find((n) => n === valor) ?? null;
}

function hrefDoNivel(nivel: NivelFrete | null): string {
  return nivel === null ? "/central/frete" : `/central/frete?nivel=${nivel}`;
}

export default function DetectorDeFretePage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <Shell>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando o detector de frete" />}>
        <DetectorContent {...props} />
      </Suspense>
    </Shell>
  );
}

function Titulo({ subtitle }: { subtitle: ReactNode }): ReactNode {
  return (
    <PageTitle
      eyebrow="COMERCIAL / CENTRAL"
      title="Detector de frete"
      subtitle={subtitle}
      aside={
        <Link className="sb-button" href="/central">
          Voltar à central
        </Link>
      }
    />
  );
}

async function DetectorContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const query = await searchParams;
  const nivel = nivelDaUrl(query);
  const membership = await currentMembership();

  if (membership.organizationId === null) {
    return (
      <>
        <Titulo subtitle="Frete que destoa do histórico, do mesmo produto, da categoria ou do preço." />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </>
    );
  }

  const supabase = await createClient();
  const resposta = await supabase.rpc("get_detector_frete", { p_organization_id: membership.organizationId });

  // Função ausente (PGRST202) não é erro: a web da `main` chega à produção
  // antes de a migration passar pelo workflow — o precedente de D-363.
  if (resposta.error !== null) {
    return (
      <>
        <Titulo subtitle="Frete que destoa do histórico, do mesmo produto, da categoria ou do preço." />
        {resposta.error.code === "PGRST202" ? (
          <div className="sb-note">
            <span>SENDO ATIVADO</span>
            <p>
              O detector de frete está sendo ativado neste ambiente: o banco ainda não recebeu a função de D-397. Assim
              que a migração for aplicada, esta tela passa a listar os anúncios.
            </p>
          </div>
        ) : (
          <p role="alert" style={AVISO}>
            Não foi possível carregar o detector: {resposta.error.message}
          </p>
        )}
      </>
    );
  }

  const detector = lerDetectorFrete(resposta.data);

  if (detector === null) {
    return (
      <>
        <Titulo subtitle="Frete que destoa do histórico, do mesmo produto, da categoria ou do preço." />
        <p role="alert" style={AVISO}>
          O detector respondeu num formato que esta tela não reconhece — nada foi mostrado.
        </p>
      </>
    );
  }

  const { janela } = detector;
  const alertas = nivel === null ? detector.alertas : detector.alertas.filter((a) => a.nivel === nivel);

  return (
    <>
      <Titulo
        subtitle={
          <>
            Últimos 14 dias ({formatBusinessDate(janela.corte)} a {formatBusinessDate(janela.fim)}) contra os{" "}
            {diasEntre(janela.inicio, janela.corte)} dias anteriores. Todas as contas do Mercado Livre; pedidos de uma
            unidade com frete observado, fora do Flex.
          </>
        }
      />

      <KpiStrip cells={celulasDoResumo(detector)} />

      <Panel
        title="Anúncios para revisar"
        subtitle={
          nivel === null
            ? "Do mais forte para o mais fraco; dentro do nível, o que mais pagou de frete a mais primeiro."
            : `Só ${NIVEL[nivel].rotulo.toLowerCase()}.`
        }
      >
        <div className="sb-panel-body">
          <div className="sb-sinal-filtros">
            <FilterPill href={hrefDoNivel(null)} active={nivel === null}>
              Todos ({formatCount(detector.alertas.length)})
            </FilterPill>
            {NIVEIS_DA_LISTA.map((n) => (
              <FilterPill key={n} href={hrefDoNivel(n)} active={nivel === n}>
                {NIVEL[n].rotulo} ({formatCount(detector.resumo[n])})
              </FilterPill>
            ))}
          </div>

          {detector.alertas.length === 200 && (
            <p className="sb-central-motivo">A lista mostra os 200 primeiros; os totais acima contam todos.</p>
          )}

          {alertas.length === 0 ? (
            <p className="sb-empty">
              {nivel === null
                ? "Nenhum anúncio destoa: o frete de todos está dentro do próprio histórico, do mesmo produto, da categoria e da faixa de preço."
                : "Nenhum anúncio neste nível."}
            </p>
          ) : (
            <ol className="sb-sinal-lista">
              {alertas.map((alerta) => (
                <CartaoDoAlerta key={`${alerta.anuncio}:${alerta.faixa}`} alerta={alerta} janela={janela} />
              ))}
            </ol>
          )}
        </div>
      </Panel>

      <ComoDecide detector={detector} />
    </>
  );
}

function celulasDoResumo(d: DetectorDeFrete): KpiCellData[] {
  const r = d.resumo;

  return [
    {
      metricId: "nivel_anomalia_frete",
      label: NIVEL.forte.rotulo,
      formula: "5 pontos ou mais somando os cinco sinais",
      value: formatCount(r.forte),
      previous: null,
      href: hrefDoNivel("forte"),
      tom: NIVEL.forte.tom,
      ...(r.forte > 0 ? { destaque: NIVEL.forte.tom } : {}),
    },
    {
      metricId: "nivel_anomalia_frete",
      label: NIVEL.provavel.rotulo,
      formula: "3 ou 4 pontos",
      value: formatCount(r.provavel),
      previous: null,
      href: hrefDoNivel("provavel"),
      tom: NIVEL.provavel.tom,
      ...(r.provavel > 0 ? { destaque: NIVEL.provavel.tom } : {}),
    },
    {
      metricId: "nivel_anomalia_frete",
      label: NIVEL.atencao.rotulo,
      formula: "1 ou 2 pontos",
      value: formatCount(r.atencao),
      previous: null,
      href: hrefDoNivel("atencao"),
      tom: NIVEL.atencao.tom,
    },
    {
      label: "Analisados",
      formula: "anúncio × faixa de preço com 3 pedidos ou mais nos últimos 14 dias",
      value: formatCount(r.analisados),
      previous: null,
      ressalva: `${formatCount(r.com_historico)} com histórico · ${formatCount(r.com_irmaos)} com outro anúncio do mesmo produto · ${formatCount(r.com_pares)} com pares`,
    },
    {
      metricId: "frete_excedente_estimado",
      label: "Frete a mais (14 dias)",
      formula: "Σ frete − referência × pedidos, nos alertas provável e forte",
      value: r.excesso_14_dias === null ? "—" : formatCurrency(r.excesso_14_dias),
      previous: null,
      ressalva: "contra a referência de cada alerta",
    },
  ];
}

function CartaoDoAlerta({ alerta: a, janela }: { alerta: AlertaDeFrete; janela: DetectorDeFrete["janela"] }): ReactNode {
  const nivel = NIVEL[a.nivel];
  const motivos = motivosDoAlerta(a, janela);

  return (
    <li className="sb-sinal-alerta">
      <div className="sb-sinal-cabeca">
        <StatePill tone={{ tom: nivel.tom, label: nivel.rotulo }} />
        <div className="sb-sinal-titulo">
          <strong>{a.titulo}</strong>
          <span>
            {a.sku ?? "sem SKU vinculado"} · <Link href={`/anuncios/${a.anuncio}`}>{a.anuncio}</Link> · {a.conta} ·
            preço {ROTULO_DA_FAIXA[a.faixa]}
          </span>
        </div>
        <span className="sb-sinal-pontos" title="soma dos pontos dos cinco sinais">
          {a.pontos} {a.pontos === 1 ? "ponto" : "pontos"}
        </span>
      </div>

      <dl className="sb-sinal-numeros">
        <div>
          <dt>Preço</dt>
          <dd>{formatCurrency(a.preco_atual)}</dd>
        </div>
        <div>
          <dt>Frete mediano</dt>
          <dd>
            {formatCurrency(a.frete_atual)} <small>{formatPercent(a.razao)} do preço</small>
          </dd>
        </div>
        <div>
          <dt>Referência</dt>
          <dd>{referencia(a)}</dd>
        </div>
        <div>
          <dt>Margem</dt>
          <dd>
            {a.margem_antes === null ? "" : `${formatPercent(a.margem_antes)} → `}
            {formatPercent(a.margem_atual)}
          </dd>
        </div>
        <div>
          <dt>Frete a mais</dt>
          <dd>{a.excesso === null || a.excesso <= 0 ? "—" : formatCurrency(a.excesso)}</dd>
        </div>
        <div>
          <dt>Pedidos</dt>
          <dd>
            {formatCount(a.pedidos_atual)} <small>em 14 dias · {formatCount(a.pedidos_antes)} antes</small>
          </dd>
        </div>
      </dl>

      <details className="sb-sinal-porque">
        <summary>Por que o sistema apontou</summary>
        <ul>
          {motivos.map((m) => (
            <li key={m.sinal}>
              <span className="sb-sinal-peso">+{m.pontos}</span>
              <span>{m.texto}</span>
            </li>
          ))}
        </ul>
        <p className="sb-sinal-sugestao">{sugestaoDoAlerta(a)}</p>
      </details>
    </li>
  );
}

/** A comparação mais direta que existe para o anúncio — a mesma ordem da referência do "frete a mais". */
function referencia(a: AlertaDeFrete): string {
  if (a.sinais.historico > 0 && a.frete_antes !== null) return `${formatCurrency(a.frete_antes)} antes`;
  if (a.sinais.irmaos > 0 && a.frete_irmaos !== null) return `${formatCurrency(a.frete_irmaos)} no mesmo produto`;
  if (a.sinais.pares > 0 && a.frete_pares !== null) return `${formatCurrency(a.frete_pares)} nos pares`;
  if (a.frete_antes !== null) return `${formatCurrency(a.frete_antes)} antes`;
  if (a.frete_irmaos !== null) return `${formatCurrency(a.frete_irmaos)} no mesmo produto`;
  if (a.frete_pares !== null) return `${formatCurrency(a.frete_pares)} nos pares`;

  return "—";
}

function ComoDecide({ detector: d }: { detector: DetectorDeFrete }): ReactNode {
  return (
    <Panel
      title="Como o detector decide"
      subtitle="Cinco comparações, cada uma de 0 a 3 pontos; o nível é a soma. Os números de cada motivo são os da própria comparação."
    >
      <div className="sb-panel-body sb-sinal-metodo">
        <ul>
          <li>
            <strong>Histórico do anúncio</strong> — frete mediano dos últimos 14 dias contra o dos dias anteriores, na
            mesma faixa de preço. Pontua a partir de 15% (ou 3 vezes a variação normal do próprio anúncio) e R$ 1.
          </li>
          <li>
            <strong>Mesmo produto</strong> — contra os outros anúncios do mesmo SKU na mesma faixa: 15%, 40% e 80%.
          </li>
          <li>
            <strong>Pares</strong> — contra a mediana de 6 produtos ou mais da mesma categoria do Mercado Livre e faixa:
            50%, 100% e 200% acima, e fora da dispersão da categoria.
          </li>
          <li>
            <strong>Proporção do preço</strong> — frete ÷ preço acima do que 95% dos anúncios da faixa pagam.
          </li>
          <li>
            <strong>Margem</strong> — deixou de dar resultado com o frete explicando a queda, vende no prejuízo, ou o
            frete subiu 5 p.p. do preço e a margem caiu junto.
          </li>
        </ul>
        <p>
          Níveis: 1 ou 2 pontos, atenção; 3 ou 4, provável problema; 5 ou mais, forte indício. A faixa de preço é a de
          cada pedido — o frete muda de patamar com o preço, e um anúncio que vende dos dois lados de uma faixa é
          comparado em cada uma separadamente.
        </p>
        <p>
          <strong>Fora da comparação:</strong> peso e dimensões estão cadastrados em {formatCount(d.resumo.skus_com_peso)}{" "}
          de {formatCount(d.resumo.skus)} SKUs analisados, pouco para comparar produtos de tamanho parecido. Pedidos com
          mais de uma unidade, do Flex ou sem frete observado não entram.
        </p>

        {d.faixas.length > 0 && (
          <div className="sb-central-tabela">
            <table className="sb-table">
              <thead>
                <tr>
                  <th>Faixa de preço</th>
                  <th className="sb-num">Anúncios</th>
                  <th className="sb-num">Frete ÷ preço, mediana</th>
                  <th className="sb-num">95% ficam até</th>
                </tr>
              </thead>
              <tbody>
                {d.faixas.map((f) => (
                  <tr key={f.faixa}>
                    <td>{ROTULO_DA_FAIXA[f.faixa]}</td>
                    <td className="sb-num">{formatCount(f.anuncios)}</td>
                    <td className="sb-num">{formatPercent(f.razao_mediana)}</td>
                    <td className="sb-num">{formatPercent(f.razao_p95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}
