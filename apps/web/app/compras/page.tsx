import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { TOM, type Tom } from "../../components/tone";
import { formatCount, formatCurrency, formatDay } from "../../lib/format";
import { purchaseOrderStatusLabel } from "../../lib/labels";
import {
  PAGE_SIZE,
  PURCHASE_ORDER_STATUSES,
  buildPurchaseOrderHref,
  resolvePurchaseOrderFilters,
  summarizePurchaseOrderWindow,
  type PurchaseOrderStatus,
} from "../../lib/purchase-order-filters";
import {
  etapaDoPedido,
  leituraPrevisao,
  lerVisaoCompras,
  linhaDoLegado,
  proximoPasso,
  type AgregadoCompra,
  type LinhaCompra,
  type LinhaLegado,
  type VisaoCompras,
} from "../../lib/purchase-orders-overview";
import { currentMembership } from "../../lib/request-membership";
import { podeOperarCompras } from "../../lib/purchase-order-permission";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Pedidos de Compra — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Pedidos de Compra — a fila pelo frame `ProcessScreen type="purchases"` (D19,
 * D-255), refeita em D-365 para responder sem abrir pedido nenhum:
 *
 *   - quanto dinheiro está comprometido em pedidos abertos;
 *   - o que está atrasado, e há quanto tempo;
 *   - o que chega nesta semana e o que já chegou no mês;
 *   - e, em cada linha, o PRÓXIMO PASSO do pedido.
 *
 * D-255 recusou cartões porque o frame não os desenha e inventá-los seria
 * decoração. Os de agora não são decoração: cada um é uma pergunta de quem
 * compra, e todos saem da mesma leitura (`get_purchase_orders_overview`), no
 * padrão de `/reposicao` (D-358). Nada é somado aqui.
 *
 * **Enquanto a migration não chega ao banco** (a web da branch principal vai ao
 * ar antes dela, D-363), a função nova responde PGRST202 e a tela cai na
 * leitura antiga, sem cartões e sem selo de atraso — nunca em erro.
 */

/**
 * Tom de cada estado nos CARTÕES. A etiqueta da tabela continua a de
 * `StatusPill` (a mesma do detalhe); aqui os três estados em andamento precisam
 * se distinguir de relance, e o amarelo único de `statusTone` não deixa.
 */
const TOM_ESTADO: Record<PurchaseOrderStatus, Tom> = {
  DRAFT: "neutro",
  APPROVED: "info",
  ORDERED: "atencao",
  RECEIVED: "ok",
  CANCELLED: "perigo",
};

const DESCRICAO_ESTADO: Record<PurchaseOrderStatus, string> = {
  DRAFT: "esperando aprovação",
  APPROVED: "falta enviar ao fornecedor",
  ORDERED: "a caminho",
  RECEIVED: "entrou no estoque",
  CANCELLED: "interrompidos",
};

const ETAPAS = ["Rascunho", "Aprovado", "Enviado", "Recebido"] as const;

const COMPACTO_BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * "R$ 12,4 mil" — o cartão pede ordem de grandeza, e o valor exato fica no
 * `title`. Abaixo de dez mil o compacto só perde precisão ("R$ 357,5"), então
 * o valor sai cheio.
 */
function compacto(valor: number): string {
  return Math.abs(valor) < 10_000 ? formatCurrency(valor) : COMPACTO_BRL.format(valor);
}

function plural(n: number, um: string, varios: string): string {
  return `${formatCount(n)} ${n === 1 ? um : varios}`;
}

/**
 * Valor de um grupo. `null` não é zero (D-254): nenhum pedido do grupo tem
 * custo, e o cartão diz isso em vez de mostrar "R$ 0".
 */
function valorCompacto(agregado: AgregadoCompra): string {
  return agregado.valor === null ? "sem custo" : compacto(agregado.valor);
}

function ressalvaCusto(agregado: AgregadoCompra): string {
  return agregado.sem_custo > 0 ? ` · ${plural(agregado.sem_custo, "com custo faltando", "com custo faltando")}` : "";
}

export default async function ComprasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolvePurchaseOrderFilters(query);
  const supabase = await createClient();

  const membership = await currentMembership();
  const organizationId = membership.organizationId;
  const podeOperar = podeOperarCompras(membership.role);

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / OPERAÇÃO"
          title="Pedidos de Compra"
          subtitle="Planeje, aprove e acompanhe o abastecimento."
        />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const argumentos = {
    p_organization_id: organizationId,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
    ...(filters.status !== null ? { p_status: filters.status } : {}),
    ...(filters.search !== null ? { p_search: filters.search } : {}),
  };

  const leitura = await supabase.rpc("get_purchase_orders_overview", {
    ...argumentos,
    ...(filters.overdue ? { p_overdue: true } : {}),
  });

  let visao: VisaoCompras | null = null;
  let linhas: readonly LinhaCompra[] = [];
  let total = 0;
  let erro: string | null = null;

  if (leitura.error === null) {
    visao = lerVisaoCompras(leitura.data);

    if (visao === null) {
      erro = "a leitura dos pedidos voltou fora do contrato esperado";
    } else {
      linhas = visao.linhas;
      total = visao.total;
    }
  } else if (leitura.error.code === "PGRST202") {
    // A função nova ainda não existe neste banco: a leitura de D-255 continua
    // servindo a fila. "Só atrasados" não existe nela, e é ignorado.
    const legado = await supabase.rpc("get_purchase_orders", argumentos);

    if (legado.error !== null) {
      erro = legado.error.message;
    } else {
      const rows = legado.data as unknown as (LinhaLegado & { total_count: number })[];

      linhas = rows.map(linhaDoLegado);
      total = rows[0]?.total_count ?? 0;
    }
  } else {
    erro = leitura.error.message;
  }

  const janela = summarizePurchaseOrderWindow(filters.page, total, linhas.length);
  const contagem = new Map((visao?.contagens ?? []).map((c) => [c.status, c]));
  const pedidosNaBusca = visao === null ? null : visao.contagens.reduce((soma, c) => soma + c.pedidos, 0);
  const filtroAtivo = filters.status !== null || filters.search !== null || filters.overdue;
  const semNenhumPedido = erro === null && total === 0 && !filtroAtivo;

  const tituloFila =
    filters.overdue
      ? "Fila de Pedidos · atrasados"
      : filters.status === null
        ? "Fila de Pedidos"
        : `Fila de Pedidos · ${purchaseOrderStatusLabel(filters.status)}`;

  return (
    <Shell>
      {/* `OpsHeader` do frame: sobrancelha, título, linha de apoio e as ações. */}
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Pedidos de Compra"
        subtitle="Planeje, aprove e acompanhe o abastecimento — do rascunho ao recebimento."
        aside={
          <>
            {/*
              Busca como GET nativo: o recorte fica na URL. Os `hidden` são
              obrigatórios porque um form GET só envia os campos que tem — sem
              eles, buscar limparia o estado e o "só atrasados" (D-136).
            */}
            <form method="get" action="/compras" className="sb-rep-busca">
              {filters.status !== null && <input type="hidden" name="estado" value={filters.status} />}
              {filters.overdue && <input type="hidden" name="atrasados" value="1" />}
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="Nº do pedido ou fornecedor"
                aria-label="Buscar por número do pedido ou fornecedor"
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
            <Link className="sb-button" href="/reposicao">
              Sugestão de compra
            </Link>
            {podeOperar && (
              <Link className="sb-button sb-button-primary" href="/compras/novo">
                Novo Pedido
              </Link>
            )}
          </>
        }
      />

      {erro !== null && (
        <p role="alert" className="sb-note sb-note-perigo" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Não foi possível carregar os pedidos: {erro}
        </p>
      )}

      {semNenhumPedido && (
        <div className="sb-cmp-vazio">
          <b>Nenhum pedido de compra ainda</b>
          <span>
            Comece pela sugestão de compra — ela marca o que está em ruptura e leva as quantidades para um pedido em
            rascunho — ou crie um pedido do zero.
          </span>
          <div>
            <Link className="sb-button sb-button-primary" href="/reposicao">
              Ver sugestão de compra
            </Link>
            {podeOperar && (
              <Link className="sb-button" href="/compras/novo">
                Criar pedido do zero
              </Link>
            )}
          </div>
        </div>
      )}

      {visao !== null && !semNenhumPedido && (
        <>
          {/*
            O RESUMO: quatro perguntas de quem compra. Os agregados respeitam a
            busca e ignoram estado e "só atrasados" (D-250) — clicar num cartão
            não zera os outros.
          */}
          <section className="sb-rep-resumo" aria-label="Resumo dos pedidos de compra">
            <div
              className="sb-rep-destaque"
              title={visao.emAberto.valor === null ? undefined : formatCurrency(visao.emAberto.valor)}
            >
              <span className="sb-rep-destaque-rotulo">Comprometido em aberto</span>
              <strong>{valorCompacto(visao.emAberto)}</strong>
              <span className="sb-rep-destaque-nota">
                {plural(visao.emAberto.pedidos, "pedido", "pedidos")} em rascunho, aprovados ou a caminho ·{" "}
                {formatCount(visao.emAberto.unidades)} un
                {ressalvaCusto(visao.emAberto)}
              </span>
            </div>

            <Link
              href={buildPurchaseOrderHref(filters, { overdue: !filters.overdue, status: null })}
              className={
                visao.atrasados.pedidos > 0
                  ? "sb-rep-destaque sb-rep-destaque-perigo sb-cmp-destaque-link"
                  : "sb-rep-destaque sb-cmp-destaque-link"
              }
              aria-current={filters.overdue ? "true" : undefined}
            >
              <span className="sb-rep-destaque-rotulo">Atrasados</span>
              <strong>{plural(visao.atrasados.pedidos, "pedido", "pedidos")}</strong>
              <span className="sb-rep-destaque-nota">
                {visao.atrasados.pedidos === 0
                  ? "nenhuma previsão vencida"
                  : `maior atraso ${plural(visao.atrasados.maiorAtrasoDias, "dia", "dias")} · ${valorCompacto(visao.atrasados)}`}
                {filters.overdue ? " · mostrando só estes" : visao.atrasados.pedidos > 0 ? " · ver" : ""}
              </span>
            </Link>

            <div
              className="sb-rep-destaque"
              title={visao.chegando.valor === null ? undefined : formatCurrency(visao.chegando.valor)}
            >
              <span className="sb-rep-destaque-rotulo">Chegando em 7 dias</span>
              <strong>{plural(visao.chegando.pedidos, "pedido", "pedidos")}</strong>
              <span className="sb-rep-destaque-nota">
                {visao.chegando.pedidos === 0
                  ? "nenhuma previsão nesta semana"
                  : `${valorCompacto(visao.chegando)} · ${formatCount(visao.chegando.unidades)} un`}
              </span>
            </div>

            <div
              className="sb-rep-destaque"
              title={visao.recebidos.valor === null ? undefined : formatCurrency(visao.recebidos.valor)}
            >
              <span className="sb-rep-destaque-rotulo">Recebido em 30 dias</span>
              <strong>{valorCompacto(visao.recebidos)}</strong>
              <span className="sb-rep-destaque-nota">
                {plural(visao.recebidos.pedidos, "pedido", "pedidos")} · {formatCount(visao.recebidos.unidades)} un
                {ressalvaCusto(visao.recebidos)}
              </span>
            </div>
          </section>
        </>
      )}

      {!semNenhumPedido && erro === null && (
        /*
          OS CINCO ESTADOS como filtro, mais "Todos". São os cinco da `check`
          constraint, não os sete do brief (D-255). Sem a leitura nova, os
          cartões continuam filtrando, só sem número.
        */
        <nav className="sb-rep-estados sb-cmp-estados" aria-label="Filtrar por estado">
          <Link
            href={buildPurchaseOrderHref(filters, { status: null, overdue: false })}
            className={filters.status === null && !filters.overdue ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
            style={{ "--sb-rep-tom": "var(--sb-primary)" } as CSSProperties}
            aria-current={filters.status === null && !filters.overdue ? "true" : undefined}
          >
            <span className="sb-rep-estado-rotulo">Todos</span>
            <strong>{pedidosNaBusca === null ? "—" : formatCount(pedidosNaBusca)}</strong>
            <small>{filters.search === null ? "todos os pedidos" : `com "${filters.search}"`}</small>
          </Link>

          {PURCHASE_ORDER_STATUSES.map((estado) => {
            const dado = contagem.get(estado);
            const ativo = filters.status === estado;

            return (
              <Link
                key={estado}
                href={buildPurchaseOrderHref(filters, { status: ativo ? null : estado, overdue: false })}
                className={ativo ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
                style={{ "--sb-rep-tom": TOM[TOM_ESTADO[estado]].color } as CSSProperties}
                aria-current={ativo ? "true" : undefined}
              >
                <span className="sb-rep-estado-rotulo">{purchaseOrderStatusLabel(estado)}</span>
                <strong>{visao === null ? "—" : formatCount(dado?.pedidos ?? 0)}</strong>
                <small>
                  {dado !== undefined && dado.valor !== null && dado.valor > 0
                    ? `${compacto(dado.valor)}${dado.sem_custo > 0 ? " · parcial" : ""}`
                    : DESCRICAO_ESTADO[estado]}
                </small>
              </Link>
            );
          })}
        </nav>
      )}

      {erro === null && !semNenhumPedido && (
        <Panel
          title={tituloFila}
          subtitle={`Mais recentes primeiro. ${janela.label}`}
          aside={
            <>
              {filtroAtivo && (
                <Link className="sb-button" href="/compras">
                  Limpar filtros
                </Link>
              )}
              {janela.totalPages > 1 && (
                <span className="sb-rep-paginas">
                  {filters.page > 1 && (
                    <Link className="sb-button" href={buildPurchaseOrderHref(filters, { page: filters.page - 1 })}>
                      ‹ Anterior
                    </Link>
                  )}
                  <span>
                    {filters.page} de {janela.totalPages}
                  </span>
                  {filters.page < janela.totalPages && (
                    <Link className="sb-button" href={buildPurchaseOrderHref(filters, { page: filters.page + 1 })}>
                      Próxima ›
                    </Link>
                  )}
                </span>
              )}
            </>
          }
        >
          {linhas.length === 0 && (
            <p className="sb-empty">
              {janela.label} <Link href="/compras">Ver todos</Link>
            </p>
          )}

          {linhas.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table sb-cmp-tabela">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Fornecedor</th>
                    <th className="sb-num">Itens</th>
                    <th className="sb-num" title="Quantidade × custo unitário. Item sem custo fica fora da soma e é dito ao lado.">
                      Valor estimado
                    </th>
                    <th>Estado</th>
                    <th title="Data prevista de chegada. O atraso só conta para pedido aprovado ou enviado.">Previsão</th>
                    <th>Próximo passo</th>
                  </tr>
                </thead>

                <tbody>
                  {linhas.map((pedido) => {
                    const passo = proximoPasso(pedido);
                    const previsao = leituraPrevisao(pedido);
                    const etapa = etapaDoPedido(pedido);
                    const href = `/compras/${pedido.id}`;

                    return (
                      <tr key={pedido.id} className={pedido.atrasado ? "sb-cmp-linha-atrasada" : undefined}>
                        <td>
                          <Link className="sb-cmp-numero" href={href}>
                            #{pedido.order_number}
                          </Link>
                          <span className="sb-cmp-sub">
                            {formatDay(pedido.created_at)}
                            {pedido.created_by_name !== null && ` · ${pedido.created_by_name}`}
                          </span>
                        </td>

                        <td>
                          {/*
                            Fornecedor é anulável por desenho: um rascunho pode
                            nascer antes de o fornecedor estar decidido.
                          */}
                          {pedido.supplier_name === null ? (
                            <span className="sb-rep-mudo">Sem fornecedor</span>
                          ) : pedido.supplier_id === null ? (
                            <span className="sb-cmp-fornecedor">{pedido.supplier_name}</span>
                          ) : (
                            <Link className="sb-cmp-fornecedor" href={`/fornecedores/${pedido.supplier_id}`}>
                              {pedido.supplier_name}
                            </Link>
                          )}
                          {pedido.destination_warehouse_name !== null && (
                            <span className="sb-cmp-sub">para {pedido.destination_warehouse_name}</span>
                          )}
                        </td>

                        <td className="sb-num">
                          {plural(pedido.itens, "item", "itens")}
                          {pedido.unidades !== null && pedido.itens > 0 && (
                            <span className="sb-cmp-sub">{formatCount(pedido.unidades)} un</span>
                          )}
                        </td>

                        {/*
                          Custo ausente não vira zero (D-254): `valor` é NULO
                          quando há itens e nenhum tem custo, e a ressalva
                          aparece ao lado do número quando só ALGUNS têm
                          (`docs/METRICS.md` 5C.2).
                        */}
                        <td className="sb-num">
                          <span className="sb-cmp-valor">{formatCurrency(pedido.valor)}</span>
                          {pedido.sem_custo > 0 && (
                            <span className="sb-cmp-sub sb-cmp-ressalva">
                              {formatCount(pedido.sem_custo)} de {formatCount(pedido.itens)} sem custo
                            </span>
                          )}
                        </td>

                        <td>
                          <StatusPill code={pedido.status} label={purchaseOrderStatusLabel(pedido.status)} />
                          <span
                            className={etapa.cancelado ? "sb-cmp-regua sb-cmp-regua-cancelada" : "sb-cmp-regua"}
                            aria-hidden="true"
                            title={`${ETAPAS.slice(0, etapa.feitas).join(" → ")}${etapa.cancelado ? " → cancelado" : ""}`}
                          >
                            {ETAPAS.map((nome, indice) => (
                              <i key={nome} className={indice < etapa.feitas ? "sb-cmp-regua-feita" : undefined} />
                            ))}
                          </span>
                        </td>

                        <td>
                          {previsao === null ? (
                            <span className="sb-rep-mudo">—</span>
                          ) : (
                            <>
                              <span className="sb-cmp-data">{previsao.data}</span>
                              {previsao.nota !== null && previsao.tom !== null && (
                                <span className="sb-cmp-selo" style={TOM[previsao.tom]}>
                                  {previsao.nota}
                                </span>
                              )}
                            </>
                          )}
                        </td>

                        <td>
                          {passo === null ? (
                            <Link className="sb-cmp-abrir" href={href}>
                              Ver pedido
                            </Link>
                          ) : (
                            <Link
                              className="sb-cmp-passo"
                              href={href}
                              style={{ "--sb-cmp-tom": TOM[passo.tom].color } as CSSProperties}
                            >
                              {passo.texto}
                              <span aria-hidden="true"> ›</span>
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </Shell>
  );
}
