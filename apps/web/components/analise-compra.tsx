import Link from "next/link";
import type { ReactNode } from "react";

import { formatCount, formatCurrency, formatDay } from "../lib/format";
import type { AvaliacaoSku, MargemDoSku } from "../lib/purchase-analysis";
import {
  FAIXA_MARGEM,
  GIRO,
  QUALIDADE_MARGEM,
  RECOMENDACAO,
  SITUACAO,
  contextoDoMotivo,
  formatarMargem,
  fraseDoMotivo,
  motivosOrdenados,
} from "../lib/purchase-fit-vocabulary";
import { TOM } from "./tone";

/**
 * As peças visuais da avaliação de compra (D-721), compartilhadas pela
 * Reposição e pelo pedido de compra. Nenhuma faz conta: recebem o resultado do
 * domínio já montado (`avaliarSku`).
 *
 * Divulgação progressiva: a linha mostra só o selo da situação e a margem
 * consolidada; o "porquê", a margem por canal e conta, a disponibilidade e os
 * pedidos em aberto ficam dentro do painel `<details>` — sem JavaScript, com
 * teclado, e sem carregar nada a mais ao abrir.
 */

const MARKETPLACE: Record<string, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  TIKTOK_SHOP: "TikTok Shop",
};

export function SeloSituacao({ avaliacao }: { avaliacao: AvaliacaoSku }): ReactNode {
  if (avaliacao.fit === null) {
    return (
      <span className="sb-status" style={TOM.neutro} title="Sem saldo, venda nem anúncio: o SKU está fora da reposição">
        Fora da reposição
      </span>
    );
  }

  const s = SITUACAO[avaliacao.fit.situation];

  return (
    <span className="sb-status" style={TOM[s.tom]} title={s.descricao}>
      {s.rotulo}
    </span>
  );
}

export function SeloRecomendacao({ avaliacao }: { avaliacao: AvaliacaoSku }): ReactNode {
  const r = avaliacao.fit?.recommendation ?? null;

  if (r === null) return null;

  return (
    <span className="sb-status" style={TOM[RECOMENDACAO[r].tom]}>
      {RECOMENDACAO[r].rotulo}
    </span>
  );
}

/** A margem consolidada, compacta: o número, a faixa e a qualidade só no `title`. */
export function CelulaMargem({ margem, margemMinima }: { margem: MargemDoSku | null; margemMinima: number }): ReactNode {
  const total = margem?.total ?? null;

  if (total === null) {
    return (
      <span className="sb-rep-mudo" title="Nenhuma venda válida no período nas contas e lojas que você alcança">
        sem venda
      </span>
    );
  }

  const { margin, coverage, quality } = total.avaliacao;

  if (margin === null) {
    return (
      <span className="sb-rep-mudo" title="Sem venda coberta: falta frete observado, recebido ou custo conhecido — nunca 0%">
        não confirmada
      </span>
    );
  }

  const faixa = margin < 0 ? "NEGATIVA" : margin < margemMinima ? "ABAIXO_DO_MINIMO" : "SAUDAVEL";
  const titulo = `Margem consolidada (recebido − custo) ÷ receita, só das vendas cobertas · ${QUALIDADE_MARGEM[quality]}${
    coverage === null ? "" : ` · ${formatarMargem(coverage)} da receita coberta`
  } · mínimo da organização ${formatarMargem(margemMinima)}`;

  return (
    <span className="sb-cmp-margem" title={titulo}>
      <b style={{ color: TOM[FAIXA_MARGEM[faixa].tom].color }}>{formatarMargem(margin)}</b>
      {quality !== "CONFIAVEL" && <small>{QUALIDADE_MARGEM[quality]}</small>}
    </span>
  );
}

function TabelaMargem({ margem }: { margem: MargemDoSku }): ReactNode {
  const linhas: { chave: string; nome: string; nivel: "total" | "canal" | "conta"; r: MargemDoSku["porConta"][number] | NonNullable<MargemDoSku["total"]> }[] = [];

  for (const m of margem.porMarketplace) {
    linhas.push({ chave: m.marketplace, nome: MARKETPLACE[m.marketplace] ?? m.marketplace, nivel: "canal", r: m });

    for (const c of margem.porConta.filter((x) => x.marketplace === m.marketplace)) {
      linhas.push({ chave: `${m.marketplace}:${c.contaId}`, nome: c.conta ?? "conta sem nome", nivel: "conta", r: c });
    }
  }

  if (margem.total !== null) linhas.push({ chave: "total", nome: "Consolidado", nivel: "total", r: margem.total });

  return (
    <table className="sb-table sb-cmp-tabela-margem">
      <thead>
        <tr>
          <th>Canal / conta</th>
          <th className="sb-num">Un</th>
          <th className="sb-num" title="Receita das vendas cobertas (as que têm recebido e custo conhecidos)">Receita coberta</th>
          <th className="sb-num" title="Recebido depois das taxas, das mesmas vendas">Recebido</th>
          <th className="sb-num" title="Custo do produto na data da venda">Custo</th>
          <th className="sb-num">Margem</th>
        </tr>
      </thead>
      <tbody>
        {linhas.map(({ chave, nome, nivel, r }) => (
          <tr key={chave} className={`sb-cmp-nivel-${nivel}`}>
            <td>{nome}</td>
            <td className="sb-num">{formatCount(r.units)}</td>
            <td className="sb-num">{r.coveredRevenue === null ? "—" : formatCurrency(r.coveredRevenue)}</td>
            <td className="sb-num">{r.coveredReceived === null ? "—" : formatCurrency(r.coveredReceived)}</td>
            <td className="sb-num">{r.coveredCost === null ? "—" : formatCurrency(r.coveredCost)}</td>
            <td className="sb-num">
              {formatarMargem(r.avaliacao.margin)}
              {r.avaliacao.coverage !== null && r.avaliacao.coverage < 1 && (
                <small className="sb-cmp-cobertura"> · {formatarMargem(r.avaliacao.coverage)} coberto</small>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface PainelAnaliseProps {
  readonly avaliacao: AvaliacaoSku;
  readonly margemMinima: number;
  readonly periodoMargem: { readonly de: string; readonly ate: string } | null;
  readonly lojasTiktok: number;
  readonly sugestao: number | null;
  readonly noPedido: number | null;
  readonly tetoDias: number | null;
}

/** O "porquê" de uma linha — conteúdo do `<details>`. */
export function PainelAnalise(p: PainelAnaliseProps & { nivelTitulo?: 3 | 4 }): ReactNode {
  const { linha, margem, fit } = p.avaliacao;
  // O nível do título segue a tela: sob o h2 da reposição é h3; dentro da revisão (h3), h4.
  const H = p.nivelTitulo === 3 ? "h3" : "h4";

  if (fit === null) {
    return (
      <div className="sb-cmp-painel">
        <p>
          Este SKU não tem saldo, venda nem anúncio na reposição — não há base para recomendar quantidade. A decisão é sua.
        </p>
      </div>
    );
  }

  const usavel = linha.stock_is_virtual ? null : linha.local_quantity + linha.full_quantity + linha.transito;
  const ctx = contextoDoMotivo(fit, {
    units30d: linha.units_30d,
    estoque: usavel,
    sugestao: p.sugestao,
    noPedido: p.noPedido,
    margem: margem?.total?.avaliacao.margin ?? null,
    margemMinima: p.margemMinima,
    diasRuptura: linha.stockoutDays30,
    outrosPedidos: linha.otherOpenQuantity,
    tetoDias: p.tetoDias,
  });
  const motivos = motivosOrdenados(fit);

  return (
    <div className="sb-cmp-painel">
      <section aria-label="Por que">
        <H>
          {SITUACAO[fit.situation].rotulo}
          {fit.recommendedQuantity !== null && (
            <span className="sb-cmp-recomendado"> · o sistema compraria {formatCount(fit.recommendedQuantity)} un</span>
          )}
        </H>
        <ul className="sb-cmp-motivos">
          {motivos.map((m) => (
            <li key={m.code} className={m.weight === "atencao" ? "sb-cmp-motivo-atencao" : undefined}>
              {fraseDoMotivo(m.code, ctx)}
            </li>
          ))}
        </ul>
        <p className="sb-cmp-meta">
          {GIRO[fit.turnover]} · confiança {fit.confidence.toLowerCase()}
          {linha.daysSinceFirstSale !== null && ` · vende há ${formatCount(linha.daysSinceFirstSale)} dias`}
          {linha.daysSinceFirstSale === null && " · nunca vendeu"}
        </p>
      </section>

      <section aria-label="Margem">
        <H>
          Margem
          {p.periodoMargem !== null && (
            <span className="sb-cmp-periodo">
              {" "}
              · {formatDay(p.periodoMargem.de)} a {formatDay(p.periodoMargem.ate)}
            </span>
          )}
        </H>
        {margem?.total == null ? (
          <p className="sb-rep-mudo">Nenhuma venda válida no período.</p>
        ) : (
          <TabelaMargem margem={margem} />
        )}
        <p className="sb-cmp-meta">
          Margem = (recebido após taxas − custo) ÷ receita antes das taxas, só das vendas cobertas; o consolidado soma os
          valores, nunca a média das porcentagens. No Mercado Livre o recebido desconta comissão e frete do vendedor (taxa
          fixa, parcelamento e Mercado Pago ficam fora); na Shopee, é o repasse com os ajustes. Não é lucro líquido: imposto,
          Ads e custos fixos não entram.
          {p.lojasTiktok > 0 && " TikTok Shop: loja conectada, mas os pedidos ainda não são lidos — sem margem."}
        </p>
      </section>

      {(linha.otherOpenOrders.length > 0 || linha.lastPurchase !== null || linha.supplierRule !== null || linha.preferredSupplier !== null) && (
        <section aria-label="Compras">
          <H>Compras</H>
          <ul className="sb-cmp-motivos">
            {linha.otherOpenOrders.map((o) => (
              <li key={o.id}>
                <Link prefetch={false} href={`/compras/${o.id}`}>
                  Pedido #{o.orderNumber}
                </Link>{" "}
                ({o.status === "DRAFT" ? "rascunho" : "aprovado"}) com{" "}
                {formatCount(o.quantity)} un
              </li>
            ))}
            {linha.lastPurchase !== null && (
              <li>
                Última compra: pedido #{linha.lastPurchase.orderNumber} em {formatDay(linha.lastPurchase.at)}
                {linha.lastPurchase.supplier !== null && `, ${linha.lastPurchase.supplier}`}
                {linha.lastPurchase.unitCost !== null && ` a ${formatCurrency(linha.lastPurchase.unitCost)}`}
              </li>
            )}
            {linha.supplierRule !== null && (
              <li>
                No fornecedor deste pedido
                {linha.supplierRule.supplierCode !== null && ` (código ${linha.supplierRule.supplierCode})`}:{" "}
                {[
                  linha.supplierRule.minimumOrderQuantity !== null && `mínimo ${formatCount(linha.supplierRule.minimumOrderQuantity)} un`,
                  linha.supplierRule.packMultiple !== null && `múltiplo de ${formatCount(linha.supplierRule.packMultiple)}`,
                  linha.supplierRule.leadTimeDays !== null && `prazo ${formatCount(linha.supplierRule.leadTimeDays)} dias`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "sem MOQ, múltiplo ou prazo cadastrados"}
              </li>
            )}
            {linha.preferredSupplier !== null && <li>Fornecedor preferido: {linha.preferredSupplier.name}</li>}
          </ul>
        </section>
      )}
    </div>
  );
}
