import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { currentMembership } from "../../lib/membership";
import { createClient } from "../../lib/supabase/server";
import {
  PAGE_SIZE,
  buildSupplierHref,
  resolveSupplierFilters,
  summarizeSupplierWindow,
} from "../../lib/supplier-filters";

export const metadata = { title: "Fornecedores — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Fornecedores — a lista, pelo frame `ProcessScreen type="suppliers"` (D20),
 * com "último pedido" e "valor comprado" acrescentados em D-258.
 *
 * **O frame é o MESMO esboço da `nfe`** — as duas variações dividem o corpo no
 * export, e o corpo é um parágrafo de reserva. Então: cabeçalho e painel do
 * frame, tabela real vestida de `.sb-table`, e **sem faixa de KPIs**, porque
 * não há cartão desenhado.
 *
 * **A linha de apoio do frame promete o que o modelo não tem.** Ela diz "Lead
 * time, cobertura e relacionamento em uma única visão" — e as duas primeiras
 * não existem POR FORNECEDOR: `skus.supplier_id` não existe de propósito
 * (D-174) e `replenishment_settings` é escopada por organização, marca (texto)
 * ou SKU. O desenho fica e o conteúdo incompatível sai, que é a regra do
 * Design Contract.
 *
 * **Das nove colunas do brief §24, seis existem agora.** Fornecedor, status,
 * último pedido e valor comprado saem de `get_suppliers`; origem, marcas, lead
 * time, cobertura alvo e política de reposição continuam fora, cada uma com
 * recusa registrada.
 */

interface SupplierRow {
  id: string;
  name: string;
  legal_name: string | null;
  document: string | null;
  contact_name: string | null;
  phone: string | null;
  is_active: boolean;
  orders_total: number;
  ultimo_pedido_em: string | null;
  valor_pedido: number | null;
  itens_sem_custo: number;
  total_count: number;
}

const ESTADOS = [
  { chave: "todos", label: "Todos os estados" },
  { chave: "ativos", label: "Ativos" },
  { chave: "inativos", label: "Inativos" },
] as const;

export default async function FornecedoresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolveSupplierFilters(query);
  const supabase = await createClient();

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / OPERAÇÃO"
          title="Fornecedores"
          subtitle="Cadastro e relacionamento de compra — o que foi pedido a cada fornecedor."
        />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const { data, error } = await supabase.rpc("get_suppliers", {
    p_organization_id: organizationId,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
    ...(filters.state === "todos" ? {} : { p_only_active: filters.state === "ativos" }),
  });

  const rows = (data ?? []) as unknown as SupplierRow[];
  const totalCount = rows[0]?.total_count ?? 0;
  const window = summarizeSupplierWindow(filters.page, totalCount, rows.length);

  const rotuloEstado = ESTADOS.find((e) => e.chave === filters.state)?.label ?? "Estado";

  return (
    <Shell>
      {/*
        `OpsHeader` do frame. A linha de apoio é reescrita: a do frame promete
        "Lead time, cobertura" por fornecedor, que o modelo não tem (ver o
        comentário do módulo). O que sobrou é a parte verdadeira dela — o
        relacionamento, que existe e é o que foi COMPRADO (D-174).
      */}
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Fornecedores"
        subtitle="Cadastro e relacionamento de compra — o que foi pedido a cada fornecedor."
        aside={
          <Link className="sb-button sb-button-primary" href="/fornecedores/novo">
            Novo Fornecedor
          </Link>
        }
      />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <Panel
          title="Base de Fornecedores"
          subtitle="Valor comprado exclui pedidos cancelados — eles têm coluna própria no dashboard do fornecedor."
          aside={
            <>
              <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)", whiteSpace: "nowrap" }}>
                {window.label}
              </span>

              {/*
                O "Filtros ⌄" do frame. Uma dimensão só, e é a única que existe
                por fornecedor: `is_active`. As do brief §24 (origem, marcas,
                lead time, cobertura, política) não são fato de fornecedor
                neste modelo.
              */}
              <FilterMenu
                rotulo={rotuloEstado}
                opcoes={ESTADOS.map((estado) => ({
                  href: buildSupplierHref(filters, { state: estado.chave }),
                  label: estado.label,
                  ativo: filters.state === estado.chave,
                }))}
              />
            </>
          }
        >
          {rows.length === 0 && (
            <p className="sb-empty">
              {filters.state === "todos" ? "Nenhum fornecedor cadastrado ainda." : window.label}
            </p>
          )}

          {rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Documento</th>
                    <th>Contato</th>
                    <th className="sb-num">Pedidos</th>
                    <th>Último pedido</th>
                    <th className="sb-num">Valor comprado</th>
                    <th>Estado</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((supplier) => (
                    <tr key={supplier.id}>
                      <td>
                        {/* Dashboard do fornecedor (D-174) — o destino individual. */}
                        <Link className="sb-entity" href={`/fornecedores/${supplier.id}`}>
                          {supplier.name}
                        </Link>
                        {supplier.legal_name !== null && (
                          <div style={{ color: "var(--sb-text-soft)", fontSize: "0.625rem" }}>
                            {supplier.legal_name}
                          </div>
                        )}
                      </td>
                      <td className="sb-mono">{supplier.document ?? "—"}</td>
                      <td>{supplier.contact_name ?? supplier.phone ?? "—"}</td>
                      <td className="sb-num">{formatCount(supplier.orders_total)}</td>
                      {/*
                        Sem pedido, "—" em vez de uma data inventada: a coluna
                        fala de um fato que não aconteceu.
                      */}
                      <td>
                        {supplier.ultimo_pedido_em === null
                          ? "—"
                          : formatDateTime(supplier.ultimo_pedido_em)}
                      </td>
                      {/*
                        Custo ausente não vira zero (D-254/D-258):
                        `valor_pedido` é NULO quando há itens e nenhum tem
                        custo, e a ressalva aparece quando só alguns têm
                        (`docs/METRICS.md` 5C.2).
                      */}
                      <td className="sb-num">
                        {formatCurrency(supplier.valor_pedido)}
                        {supplier.itens_sem_custo > 0 && (
                          <div style={{ fontSize: "0.625rem", color: "var(--sb-accent-ink)" }}>
                            {formatCount(supplier.itens_sem_custo)} item(ns) sem custo
                          </div>
                        )}
                      </td>
                      <td style={{ color: supplier.is_active ? undefined : "var(--sb-text-soft)" }}>
                        {supplier.is_active ? "Ativo" : "Inativo"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {error === null && window.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <Link className="sb-button" href={buildSupplierHref(filters, { page: filters.page - 1 })}>
              ← Anterior
            </Link>
          )}
          {filters.page < window.totalPages && (
            <Link className="sb-button" href={buildSupplierHref(filters, { page: filters.page + 1 })}>
              Próxima →
            </Link>
          )}
        </div>
      )}
    </Shell>
  );
}
