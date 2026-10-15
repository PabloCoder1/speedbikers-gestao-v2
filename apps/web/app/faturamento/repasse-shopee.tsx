import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { EstadoDaTela, TENTAR_DE_NOVO, type AcaoDoEstado } from "../../components/estado-da-tela";
import { Panel } from "../../components/panel";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import {
  divergenciaEmTodos,
  lojaDeTesteDoRepasse,
  separarPorNivel,
  type Liberacao,
  type LinhaPendente,
  type LinhaRepasse,
} from "../../lib/repasse-shopee";

interface Resposta<T> {
  readonly data: T[] | null;
  readonly error: { message: string; code?: string } | null;
}

const TITULO = "Repasse da Shopee";

/** "1 pedido", "3 pedidos" — o número vem do banco, a palavra concorda com ele. */
function quantos(n: number | null, um: string, varios: string): string {
  return `${formatCount(n)} ${n === 1 ? um : varios}`;
}

/** As últimas liberações à vista; o resto fica para a conferência por pedido. */
export const LIBERACOES_A_VISTA = 10;

/**
 * O REPASSE DA SHOPEE NO FATURAMENTO (D-458, etapa T5d; contrato C-64, D-451).
 *
 * O realizado ao lado do previsto: o dinheiro que a Shopee liberou no período
 * (pelo DIA DA LIBERAÇÃO), o `escrow_amount` dos mesmos pedidos, a diferença
 * entre os dois e o que ainda falta liberar agora. Quatro leituras, todas do
 * SQL; a tela não soma nada.
 *
 * O que a tela não faz, de propósito:
 * - não soma o repasse ao recebido nem ao resultado (é conferência, C-64);
 * - não compara o liberado com a receita do mesmo período (dias diferentes);
 * - não chama a diferença de cobrança enquanto a unidade do valor liberado
 *   não foi conferida com a Shopee — diz isso ao lado do número.
 */
export async function RepasseShopee({
  leitura,
  pendente,
  liberacoes,
  periodo,
  tentarDeNovo,
}: {
  leitura: PromiseLike<Resposta<LinhaRepasse>>;
  pendente: PromiseLike<Resposta<LinhaPendente>>;
  liberacoes: PromiseLike<Resposta<Liberacao>>;
  periodo: string;
  /** A mesma URL, para "Tentar de novo" (D-470). */
  tentarDeNovo?: string;
}): Promise<ReactNode> {
  const [resposta, agora, lista] = await Promise.all([leitura, pendente, liberacoes]);
  // D-470: "Tentar de novo" leva à mesma URL da tela.
  const acao: AcaoDoEstado | undefined =
    tentarDeNovo === undefined ? undefined : { href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true };

  // A web chega à produção antes da migration de D-451 (PGRST202).
  if (resposta.error?.code === "PGRST202") {
    return (
      <Panel title={TITULO} subtitle={periodo}>
        <EstadoDaTela
          tipo="vazio"
          titulo="A leitura dos repasses da Shopee ainda está sendo ativada neste ambiente"
          descricao="Os números aparecem depois da primeira leitura das lojas."
        />
      </Panel>
    );
  }

  if (resposta.error !== null) {
    return (
      <Panel title={TITULO} subtitle={periodo}>
        <EstadoDaTela tipo="erro" titulo="Não foi possível carregar os repasses da Shopee" detalhe={resposta.error.message} acao={acao} />
      </Panel>
    );
  }

  const { total, lojas } = separarPorNivel(resposta.data);
  // O "a liberar" é outra leitura: se ela falhar, a célula diz "—" e o motivo, sem derrubar o resto.
  const pendentes = agora.error === null ? separarPorNivel(agora.data) : null;

  return (
    <Panel title={TITULO} subtitle={`${periodo} · pelo dia em que a Shopee liberou o dinheiro`}>
      <p role="note" className="sb-campanhas-ml-nota">
        O repasse é o dinheiro que a Shopee liberou, contado pelo dia da liberação e não pelo da venda: não compare com a
        receita do mesmo período. Ele não muda o recebido nem o resultado — é a conferência do que estava previsto.
      </p>

      {total === null ? (
        <>
          <EstadoDaTela
            tipo="vazio"
            titulo="Nenhuma loja real com os repasses já lidos"
            descricao="Sem números para o período. A leitura começa sozinha junto com a de pedidos de cada loja."
          />
          {lojas.length > 0 && <Lojas lojas={lojas} pendentes={pendentes?.lojas ?? null} />}
        </>
      ) : (
        <Resumo
          total={total}
          pendente={pendentes === null ? { erro: agora.error?.message ?? "" } : pendentes.total}
          lista={lista}
          lojas={<Lojas lojas={lojas} pendentes={pendentes?.lojas ?? null} />}
          acao={acao}
        />
      )}
    </Panel>
  );
}

function Resumo({
  total,
  pendente,
  lista,
  lojas,
  acao,
}: {
  total: LinhaRepasse;
  pendente: LinhaPendente | null | { erro: string };
  lista: Resposta<Liberacao>;
  lojas: ReactNode;
  acao: AcaoDoEstado | undefined;
}): ReactNode {
  const semValor = total.liberacoes_sem_valor ?? 0;
  const aLiberar = pendente !== null && "erro" in pendente ? null : pendente;

  const celulas: KpiCellData[] = [
    {
      metricId: "shopee_repasse_liberado",
      label: "Liberado no período",
      formula: "SUM(payout_amount) das liberações, pelo dia da liberação (São Paulo) — não o da venda",
      value: formatCurrency(total.liberado),
      previous: null,
      ressalva: `${quantos(total.pedidos_liberados, "pedido", "pedidos")}${
        semValor > 0 ? ` · ${quantos(semValor, "liberação sem valor", "liberações sem valor")}, fora da soma` : ""
      }`,
    },
    {
      label: "Previsto desses pedidos",
      formula: "escrow_amount dos mesmos pedidos liberados, quando o financeiro já foi lido",
      value: formatCurrency(total.previsto),
      previous: null,
      ressalva: `${formatCount(total.pedidos_com_previsto)} de ${formatCount(total.pedidos_liberados)} pedidos com o previsto lido`,
    },
    {
      metricId: "shopee_repasse_diferenca",
      label: "Diferença",
      formula: "por pedido: todas as liberações − o previsto; só pedidos com o previsto lido e sem liberação sem valor",
      value: formatCurrency(total.diferenca),
      previous: null,
      ressalva: `${quantos(total.pedidos_divergentes, "pedido divergente", "pedidos divergentes")} · a unidade do valor liberado ainda não foi conferida com a Shopee`,
    },
    {
      metricId: "shopee_a_liberar",
      label: "A liberar agora",
      formula: "escrow_amount dos pedidos válidos sem liberação lida, criados depois do início da leitura",
      value: aLiberar === null ? "—" : formatCurrency(aLiberar.a_liberar),
      previous: null,
      ressalva:
        pendente !== null && "erro" in pendente
          ? "não foi possível ler o que falta liberar"
          : aLiberar === null
            ? "sem retrato do que falta liberar"
            : `${quantos(aLiberar.pedidos, "pedido", "pedidos")}${
                (aLiberar.pedidos_sem_financeiro ?? 0) > 0
                  ? ` · ${formatCount(aLiberar.pedidos_sem_financeiro)} sem o financeiro, fora do valor`
                  : ""
              }${aLiberar.mais_antigo === null ? "" : ` · o mais antigo de ${formatDateTime(aLiberar.mais_antigo)}`}`,
    },
  ];

  return (
    <>
      {total.cobertura_completa === false && (
        <p role="note" className="sb-note sb-note-atencao sb-campanhas-ml-aviso">
          O período não está inteiro dentro da leitura dos repasses
          {total.lido_ate === null ? "" : ` (lida até ${formatDateTime(total.lido_ate)})`}: liberação fora dela não está
          nos números.
        </p>
      )}

      {divergenciaEmTodos(total) && (
        <p role="note" className="sb-note sb-note-atencao sb-campanhas-ml-aviso">
          Todos os pedidos comparáveis divergem do previsto. Antes de tratar como cobrança, confira a unidade do valor
          liberado: ela ainda não foi conferida com a Shopee, e uma unidade trocada produz exatamente isso.
        </p>
      )}

      <div className="sb-campanhas-ml-faixa">
        <KpiStrip cells={celulas} />
      </div>

      <div className="sb-campanhas-ml-corpo">
        <div className="sb-campanhas-ml-coluna">
          <h3 className="sb-campanhas-ml-titulo">
            Últimas liberações <small>no período</small>
          </h3>
          <Liberacoes lista={lista} acao={acao} />
        </div>

        <div className="sb-campanhas-ml-coluna">{lojas}</div>
      </div>
    </>
  );
}

function Liberacoes({ lista, acao }: { lista: Resposta<Liberacao>; acao: AcaoDoEstado | undefined }): ReactNode {
  if (lista.error !== null) {
    return <EstadoDaTela tipo="erro" titulo="Não foi possível carregar as liberações" detalhe={lista.error.message} acao={acao} />;
  }

  const linhas = lista.data ?? [];

  if (linhas.length === 0) {
    return <EstadoDaTela tipo="vazio" titulo="Nenhuma liberação lida neste período" />;
  }

  const total = linhas[0]?.total_count ?? linhas.length;

  return (
    <>
      <ul className="sb-valores" aria-label="Últimas liberações da Shopee">
        {linhas.map((l) => {
          const deTeste = lojaDeTesteDoRepasse(l);
          const notas = [
            `${l.shop_name}${deTeste ? " (teste)" : ""}`,
            `liberado em ${formatDateTime(l.released_at)}`,
            l.previsto === null ? "previsto não lido" : `previsto ${formatCurrency(l.previsto)}`,
            l.diferenca_do_pedido === null || l.diferenca_do_pedido === 0
              ? null
              : `diferença ${formatCurrency(l.diferenca_do_pedido)}`,
            l.liberacoes_do_pedido > 1 ? `${formatCount(l.liberacoes_do_pedido)} liberações do pedido` : null,
          ].filter((nota): nota is string => nota !== null);

          return (
            <li key={`${l.shopee_shop_id}-${l.order_sn}-${l.released_at}`}>
              <span className="sb-valores-rotulo">Pedido {l.order_sn}</span>
              <strong className="sb-valores-valor">
                {l.payout_amount === null ? "sem valor" : formatCurrency(l.payout_amount)}
              </strong>
              <span className="sb-valores-nota">{notas.join(" · ")}</span>
            </li>
          );
        })}
      </ul>
      {total > linhas.length && (
        <p className="sb-campanhas-ml-nota">
          Mostrando as {formatCount(linhas.length)} mais recentes de {formatCount(total)} liberações do período.
        </p>
      )}
    </>
  );
}

/** Uma linha por loja: o liberado e o que falta liberar, e o que não se sabe dela. */
function Lojas({
  lojas,
  pendentes,
}: {
  lojas: readonly LinhaRepasse[];
  pendentes: readonly LinhaPendente[] | null;
}): ReactNode {
  const pendentePorLoja = new Map((pendentes ?? []).map((p) => [p.account_id, p]));

  return (
    <div>
      <h3 className="sb-campanhas-ml-titulo">Por loja</h3>
      <ul className="sb-valores" aria-label="Repasse por loja">
        {lojas.map((loja) => {
          const naoLida = loja.liberado === null;
          const deTeste = lojaDeTesteDoRepasse(loja);
          const falta = pendentePorLoja.get(loja.account_id) ?? null;
          const notas = [
            naoLida ? "repasses ainda não lidos" : quantos(loja.pedidos_liberados, "pedido liberado", "pedidos liberados"),
            deTeste ? "loja de teste, fora do total" : null,
            !naoLida && loja.cobertura_completa === false ? "só o trecho já lido" : null,
            !naoLida && (loja.pedidos_divergentes ?? 0) > 0
              ? `${quantos(loja.pedidos_divergentes, "divergente", "divergentes")} (${formatCurrency(loja.diferenca)})`
              : null,
            falta?.a_liberar == null ? null : `a liberar ${formatCurrency(falta.a_liberar)}`,
            loja.lido_ate === null ? null : `lido até ${formatDateTime(loja.lido_ate)}`,
          ].filter((nota): nota is string => nota !== null);

          return (
            <li key={loja.account_id ?? loja.account_name}>
              <span className="sb-valores-rotulo">
                {loja.account_name ?? "Loja Shopee"}
                {deTeste ? " (teste)" : ""}
              </span>
              <strong className="sb-valores-valor">{naoLida ? "—" : formatCurrency(loja.liberado)}</strong>
              <span className="sb-valores-nota">{notas.join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
