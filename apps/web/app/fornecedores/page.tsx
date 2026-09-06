import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
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
 * Fornecedores — a lista, pelo frame `ProcessScreen type="suppliers"` (D20).
 *
 * **O frame é o MESMO esboço da `nfe`** — as duas variações dividem o corpo no
 * export, e o corpo é um parágrafo de reserva ("Lista de fornecedores carregada
 * e validada…"). Então, como em D-253: cabeçalho e painel do frame, tabela real
 * vestida de `.sb-table`, e **sem faixa de KPIs**, porque não há cartão
 * desenhado.
 *
 * **A linha de apoio do frame promete o que o modelo não tem.** Ela diz "Lead
 * time, cobertura e relacionamento em uma única visão" — e nenhuma das três
 * primeiras existe POR FORNECEDOR: `skus.supplier_id` não existe de propósito
 * (D-174) e `replenishment_settings` é escopada por organização, marca (texto)
 * ou SKU, nunca por fornecedor. Manter a frase seria a tela prometendo colunas
 * que ela não pode mostrar; o desenho fica e o conteúdo incompatível sai, que é
 * a regra do Design Contract.
 */

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

  const from = (filters.page - 1) * PAGE_SIZE;

  // Sem filtro por organização: a policy já restringe (suppliers_select_permitted).
  //
  // `count: "exact"` sobre o conjunto FILTRADO, antes do `range`: a tela lia
  // `.limit(200)` e não declarava nada — nem total, nem página seguinte
  // (D-131).
  let consulta = supabase
    .from("suppliers")
    .select("id, name, legal_name, document, contact_name, phone, is_active", { count: "exact" });

  if (filters.state !== "todos") {
    consulta = consulta.eq("is_active", filters.state === "ativos");
  }

  const { data, error, count } = await consulta
    .order("name")
    .range(from, from + PAGE_SIZE - 1);

  const rows = data ?? [];
  const window = summarizeSupplierWindow(filters.page, count ?? 0, rows.length);

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
              {filters.state === "todos"
                ? "Nenhum fornecedor cadastrado ainda."
                : window.label}
            </p>
          )}

          {rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Razão social</th>
                    <th>Documento</th>
                    <th>Contato</th>
                    <th>Telefone</th>
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
                      </td>
                      <td style={{ color: "var(--sb-text-soft)" }}>{supplier.legal_name ?? "—"}</td>
                      <td className="sb-mono">{supplier.document ?? "—"}</td>
                      <td>{supplier.contact_name ?? "—"}</td>
                      <td>{supplier.phone ?? "—"}</td>
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
