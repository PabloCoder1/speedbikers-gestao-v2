import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Icone } from "../../../../components/icons";
import { PageTitle } from "../../../../components/page-title";
import { Shell } from "../../../../components/shell";
import { formatCount } from "../../../../lib/format";
import { locationKindLabel } from "../../../../lib/labels";
import { createClient } from "../../../../lib/supabase/server";
import { AdjustmentForm } from "./adjustment-form";

export const metadata = { title: "Ajustar estoque — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default async function AjusteEstoquePage({
  params,
}: {
  params: Promise<{ skuId: string }>;
}): Promise<ReactNode> {
  const { skuId } = await params;

  const supabase = await createClient();

  // As duas leituras partem do MESMO `skuId` da URL — a segunda nunca
  // precisou esperar a primeira. Em paralelo desde D-195.
  //
  // O guarda continua depois, e continua correto: a RLS restringe as duas
  // leituras de forma independente, então disparar `inventory_balances` antes
  // de saber se o SKU existe não mostra nada a quem não podia ver. O preço é
  // uma consulta desperdiçada no caminho 404, que é o caminho raro.
  const [sku, balances] = await Promise.all([
    supabase.from("skus").select("id, sku, title").eq("id", skuId).maybeSingle(),
    supabase.from("inventory_balances").select("location_kind, quantity").eq("sku_id", skuId),
  ]);

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — mesmo
  // raciocínio já usado em apps/web/app/compras/[id]/page.tsx.
  if (sku.error !== null || sku.data === null) {
    notFound();
  }

  return (
    <Shell>
      {/* O CODIGO do SKU e chave, nao titulo: vai na sobrancelha, em mono,
          como manda o `ObjectHeader` do design system. O titulo e o ato. */}
      <PageTitle
        eyebrow={`ESTOQUE / ${sku.data.sku}`}
        title="Ajuste de saldo"
        subtitle={sku.data.title ?? <Link href="/estoque">Voltar ao estoque</Link>}
        aside={
          <Link className="sb-button" href="/estoque">
            <Icone nome="setas" tamanho={14} /> Voltar ao estoque
          </Link>
        }
        compacto
      />

      {balances.error !== null && (
        <p role="alert" className="sb-adjust-alert">
          Não foi possível carregar o saldo atual: {balances.error.message}. Confira o saldo em{" "}
          <Link href="/estoque">/estoque</Link> antes de ajustar.
        </p>
      )}

      <div className="sb-adjust-layout">
        <section className="sb-adjust-balance sb-panel" aria-labelledby="saldo-atual">
          <div className="sb-adjust-section-head">
            <div>
              <span className="sb-eyebrow">POSIÇÃO ATUAL</span>
              <h2 id="saldo-atual">Onde este SKU está</h2>
            </div>
            <span className="sb-adjust-section-icon" aria-hidden="true">
              <Icone nome="caixa" tamanho={18} />
            </span>
          </div>
          <p className="sb-adjust-muted">Confira cada local antes de registrar uma entrada ou saída.</p>

          {balances.error === null && balances.data.length > 0 && (
            <div className="sb-adjust-balance-grid">
              {balances.data.map((balance) => (
                <div
                  className={`sb-adjust-balance-card sb-adjust-balance-${balance.location_kind.toLowerCase()}`}
                  key={balance.location_kind}
                >
                  <span>{locationKindLabel(balance.location_kind)}</span>
                  <strong>{formatCount(balance.quantity)}</strong>
                  <small>unidades</small>
                </div>
              ))}
            </div>
          )}

          {balances.error === null && balances.data.length === 0 && (
            <p className="sb-adjust-empty">Nenhum saldo registrado para este SKU.</p>
          )}

          <div className="sb-adjust-rule">
            <Icone nome="pulso" tamanho={14} /> Cada ajuste fica registrado no ledger com motivo e local.
          </div>
        </section>

        <section className="sb-adjust-form-card sb-panel" aria-labelledby="novo-ajuste">
          <div className="sb-adjust-section-head">
            <div>
              <span className="sb-eyebrow">AÇÃO AUDITÁVEL</span>
              <h2 id="novo-ajuste">Registrar movimentação</h2>
            </div>
            <span className="sb-adjust-section-icon sb-adjust-section-icon-accent" aria-hidden="true">
              <Icone nome="ciclo" tamanho={18} />
            </span>
          </div>
          <p className="sb-adjust-muted">Use valores positivos para entrada e negativos para saída.</p>

          <AdjustmentForm skuId={sku.data.id} />
        </section>
      </div>
    </Shell>
  );
}
