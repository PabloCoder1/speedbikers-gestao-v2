import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Icone } from "../../../../components/icons";
import { PageTitle } from "../../../../components/page-title";
import { Shell } from "../../../../components/shell";
import { formatCount, formatCurrency, formatDateTime } from "../../../../lib/format";
import { iniciais, monogramaDeProduto } from "../../../../lib/initials";
import { formatQtyDelta, locationKindLabel, movementTypeLabel } from "../../../../lib/movement-labels";
import { currentMembership } from "../../../../lib/request-membership";
import { sanitizeErrorText } from "../../../../lib/sanitize";
import { ADJUSTMENT_LOCATIONS, type AdjustmentLocation } from "../../../../lib/stock-adjustment";
import { createClient } from "../../../../lib/supabase/server";
import { AdjustmentForm } from "./adjustment-form";

export const metadata = { title: "Ajustar estoque — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

const HISTORY_SIZE = 8;

/** Mesmo corte da RPC `create_manual_stock_adjustment` — a tela avisa antes, o banco decide. */
const CAN_ADJUST = new Set(["ADMIN", "GESTOR"]);

export default async function AjusteEstoquePage({
  params,
}: {
  params: Promise<{ skuId: string }>;
}): Promise<ReactNode> {
  const { skuId } = await params;

  const supabase = await createClient();

  // O id do usuário vem do cookie (`getSession`, sem ida ao Auth) — serve só
  // para mostrar o nome de quem vai assinar o ajuste. Quem grava `created_by`
  // é a RPC, com `auth.uid()`; a tela nunca manda o autor.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user.id ?? null;

  // Todas partem do `skuId` da URL, então vão juntas (D-195). A RLS restringe
  // cada uma de forma independente; no caminho 404 o preço é consulta
  // desperdiçada, que é o caminho raro.
  const [sku, balances, history, perfil, membership] = await Promise.all([
    supabase
      .from("skus")
      .select("id, sku, title, brand, barcode, unit, purchase_cost, is_active")
      .eq("id", skuId)
      .maybeSingle(),
    supabase.from("inventory_balances").select("location_kind, quantity, updated_at").eq("sku_id", skuId),
    supabase
      .from("stock_movements")
      .select("id, occurred_at, movement_type, location_kind, qty_delta, reason, autor:profiles(full_name)")
      .eq("sku_id", skuId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(HISTORY_SIZE),
    userId === null
      ? Promise.resolve({ data: null, error: null })
      : supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
    currentMembership(),
  ]);

  // `null` pode ser "não existe" ou "a policy escondeu" — mesmo raciocínio de
  // apps/web/app/compras/[id]/page.tsx.
  if (sku.error !== null || sku.data === null) {
    notFound();
  }

  const produto = sku.data;

  // Os três locais sempre aparecem: um local sem linha em `inventory_balances`
  // tem saldo zero, e esconder o card faria a pessoa achar que não pode
  // ajustar ali.
  const saldos = Object.fromEntries(ADJUSTMENT_LOCATIONS.map((kind) => [kind, 0])) as Record<
    AdjustmentLocation,
    number
  >;
  let ultimaAtualizacao: string | null = null;

  for (const linha of balances.data ?? []) {
    if (linha.location_kind in saldos) {
      saldos[linha.location_kind as AdjustmentLocation] = linha.quantity;
    }

    if (ultimaAtualizacao === null || linha.updated_at > ultimaAtualizacao) {
      ultimaAtualizacao = linha.updated_at;
    }
  }

  const total = ADJUSTMENT_LOCATIONS.reduce((soma, kind) => soma + saldos[kind], 0);
  const nomeAutor = perfil.data?.full_name ?? session?.user.email ?? "Você";
  const podeAjustar = membership.role !== null && CAN_ADJUST.has(membership.role);
  const formularioIndisponivel = !podeAjustar || balances.error !== null || membership.error !== null;
  const movimentos = history.data ?? [];

  return (
    <Shell>
      {/* O CÓDIGO do SKU é chave, não título: vai na sobrancelha, em mono,
          como manda o `ObjectHeader` do design system. O título é o ato. */}
      <PageTitle
        eyebrow={`ESTOQUE / ${produto.sku}`}
        title="Ajuste de estoque"
        subtitle="Registre entradas, saídas ou o resultado de uma contagem. Cada ajuste fica no histórico com autor, data e motivo."
        aside={
          <>
            <Link className="sb-button" href={`/estoque/movimentacoes?busca=${encodeURIComponent(produto.sku)}`}>
              <Icone nome="pulso" tamanho={14} /> Movimentações
            </Link>
            <Link className="sb-button" href="/estoque">
              <Icone nome="setas" tamanho={14} /> Voltar ao estoque
            </Link>
          </>
        }
        compacto
      />

      {balances.error !== null && (
        <p role="alert" className="sb-adjust-alert">
          Não foi possível carregar o saldo atual
          {sanitizeErrorText(balances.error.message) === null
            ? "."
            : `: ${sanitizeErrorText(balances.error.message) ?? ""}.`} O ajuste foi bloqueado para evitar uma
          movimentação sem contexto.
        </p>
      )}

      {membership.error !== null && (
        <p role="alert" className="sb-adjust-alert">
          Não foi possível confirmar sua permissão. Recarregue a página antes de tentar ajustar o estoque.
        </p>
      )}

      {!podeAjustar && membership.error === null && (
        <p role="note" className="sb-adjust-alert sb-adjust-alert-info">
          Seu papel permite consultar, mas só ADMIN e GESTOR registram ajustes de estoque.
        </p>
      )}

      {/* Cartão do produto: o que está sendo ajustado, antes de qualquer campo. */}
      <section className="sb-adjust-product sb-panel" aria-label="Produto">
        <span className="sb-adjust-product-thumb" aria-hidden="true">
          {monogramaDeProduto(produto.title ?? produto.sku)}
        </span>
        <div className="sb-adjust-product-copy">
          <Link className="sb-adjust-product-title" href={`/skus/${produto.id}`}>
            {produto.title ?? "Produto sem título"}
          </Link>
          <div className="sb-adjust-product-meta">
            <span className="sb-mono">{produto.sku}</span>
            {produto.brand !== null && <span>{produto.brand}</span>}
            {produto.barcode !== null && <span className="sb-mono">EAN {produto.barcode}</span>}
            {produto.purchase_cost !== null && <span>Custo {formatCurrency(produto.purchase_cost)}</span>}
            {!produto.is_active && <span className="sb-adjust-tag-muted">Inativo</span>}
          </div>
        </div>
        <div className="sb-adjust-product-total">
          <small>Saldo total</small>
          <strong>{balances.error === null ? formatCount(total) : "—"}</strong>
          <small>{ultimaAtualizacao === null ? "sem movimento" : `atualizado ${formatDateTime(ultimaAtualizacao)}`}</small>
        </div>
      </section>

      <div className="sb-adjust-layout">
        <section className="sb-adjust-form-card sb-panel" aria-labelledby="novo-ajuste">
          <div className="sb-adjust-section-head">
            <div>
              <span className="sb-eyebrow">NOVO AJUSTE</span>
              <h2 id="novo-ajuste">Registrar movimentação</h2>
            </div>
            <span className="sb-adjust-section-icon sb-adjust-section-icon-accent" aria-hidden="true">
              <Icone nome="ciclo" tamanho={18} />
            </span>
          </div>

          <AdjustmentForm
            skuId={produto.id}
            balances={saldos}
            unitCost={produto.purchase_cost}
            unit={produto.unit}
            authorName={nomeAutor}
            authorInitials={iniciais(nomeAutor)}
            disabled={formularioIndisponivel}
            balanceUnavailable={balances.error !== null}
          />
        </section>

        <section className="sb-adjust-history sb-panel" aria-labelledby="historico-ajustes">
          <div className="sb-adjust-section-head">
            <div>
              <span className="sb-eyebrow">HISTÓRICO</span>
              <h2 id="historico-ajustes">Últimas movimentações</h2>
            </div>
            <span className="sb-adjust-section-icon sb-adjust-section-icon-soft" aria-hidden="true">
              <Icone nome="prancheta" tamanho={18} />
            </span>
          </div>

          {history.error !== null && (
            <p className="sb-adjust-muted">Não foi possível carregar o histórico agora.</p>
          )}

          {history.error === null && movimentos.length === 0 && (
            <p className="sb-adjust-muted">Nenhuma movimentação registrada para este SKU ainda.</p>
          )}

          {movimentos.length > 0 && (
            <ol className="sb-adjust-timeline">
              {movimentos.map((mov) => {
                const delta = mov.qty_delta;
                const autor = mov.autor?.full_name ?? null;

                return (
                  <li key={mov.id} className={delta > 0 ? "sb-adjust-in" : "sb-adjust-out"}>
                    <span className="sb-adjust-timeline-delta">{formatQtyDelta(delta)}</span>
                    <div className="sb-adjust-timeline-body">
                      <b>{movementTypeLabel(mov.movement_type)}</b>
                      <span className="sb-adjust-timeline-where">{locationKindLabel(mov.location_kind)}</span>
                      {mov.reason !== null && <p>{mov.reason}</p>}
                      <small>
                        {formatDateTime(mov.occurred_at)}
                        {autor !== null && (
                          <>
                            {" · "}
                            <span className="sb-adjust-author-chip">{autor}</span>
                          </>
                        )}
                      </small>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <Link
            className="sb-adjust-history-more"
            href={`/estoque/movimentacoes?busca=${encodeURIComponent(produto.sku)}`}
          >
            Ver extrato completo <Icone nome="avancar" tamanho={12} />
          </Link>
        </section>
      </div>
    </Shell>
  );
}
