import Link from "next/link";
import type { ReactNode } from "react";

import { AcessoRestrito } from "../../components/acesso-restrito";
import { FilterMenu } from "../../components/filter-menu";
import { FilterPill } from "../../components/filter-pill";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { StatusPill } from "../../components/status-pill";
import { Shell } from "../../components/shell";
import { formatCount, formatDateTime } from "../../lib/format";
import { sanitizeErrorText } from "../../lib/sanitize";
import { batchStatusLabel, kindLabel } from "../../lib/labels";
import {
  BATCH_PAGE_SIZE,
  IMPORT_KINDS,
  IMPORT_STATUSES,
  buildImportHref,
  resolveImportFilters,
  summarizeBatchWindow,
} from "../../lib/import-filters";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Importações — Speed Bikers Gestão" };

// A sessão vem de cookie: renderizar em build produziria a página de outra
// pessoa. Sem isto o Next tentaria pré-renderizar e falharia no deploy.
export const dynamic = "force-dynamic";

/**
 * Histórico de importações do UpSeller (D-278, fatia D37b).
 *
 * A tela lia `.limit(50)` sem `count`, sem janela e sem página seguinte: com 51
 * lotes, o 51º não existia para quem olhava. É a classe de D-131, e a mesma
 * correção que D-253 aplicou em `/notas-fiscais` — `count: "exact"` sobre o
 * conjunto FILTRADO, para cabeçalho e tabela falarem do mesmo recorte (D-236).
 */
export default async function ImportacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolveImportFilters(query);

  const supabase = await createClient();

  // Sem filtro por organização na consulta: a policy já restringe, e repetir a
  // condição aqui daria a impressão de que ela é a proteção — não é.
  let consulta = supabase
    .from("erp_import_batches")
    .select(
      "id, kind, status, file_name, total_rows, ok_rows, skipped_rows, invalid_rows, created_at, last_error",
      { count: "exact" },
    );

  if (filters.kind !== null) consulta = consulta.eq("kind", filters.kind);
  if (filters.status !== null) consulta = consulta.eq("status", filters.status);

  const from = (filters.page - 1) * BATCH_PAGE_SIZE;

  /*
    O papel entra no MESMO `Promise.all` da listagem: em fila seriam duas
    latências onde uma resolve, e o guarda `check:waterfalls` reprova a fila.
  */
  const [membership, { data, error, count }] = await Promise.all([
    currentMembership(supabase),
    consulta.order("created_at", { ascending: false }).range(from, from + BATCH_PAGE_SIZE - 1),
  ]);

/*
  RESTRITA A ADMIN (D-312). Importar uma planilha do UpSeller reescreve o
  catálogo, e o dono do produto decidiu que a porta é de quem administra a
  base — a tela saiu de "Operação" e foi para "Administração" no menu.

  A recusa é no SERVIDOR, e não só no menu escondido: quem tem o endereço
  chega aqui (D-295 §3). O que esta linha AINDA não é: a última defesa. As
  policies de `erp_import_batches`/`erp_import_rows` e as rotas da api
  continuam autorizando ADMIN **e GESTOR** — fechar isso é migration e está
  registrado como pendência.
*/
  if (membership.role !== "ADMIN") {
    return <AcessoRestrito titulo="Importações" />;
  }

  const rows = data ?? [];
  const janela = summarizeBatchWindow(filters.page, count ?? 0, rows.length);

  return (
    <Shell>
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / DADOS E PROCESSAMENTOS"
        title="Importações"
        subtitle="Planilhas do UpSeller: leitura, conferência e aplicação no catálogo."
        aside={
          <Link className="sb-button sb-button-primary" href="/importacoes/nova">
            Nova importação
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
          title="Histórico de importações"
          aside={
            <>
              <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)", whiteSpace: "nowrap" }}>
                {janela.label}
              </span>

              {/* Cada opção é um LINK: o recorte fica na URL, nunca em estado
                  React (regra de `FilterMenu`). */}
              <FilterMenu
                rotulo={filters.kind === null ? "Tipo" : kindLabel(filters.kind)}
                opcoes={[
                  {
                    href: buildImportHref(filters, { kind: null }),
                    label: "Todos os tipos",
                    ativo: filters.kind === null,
                  },
                  ...IMPORT_KINDS.map((tipo) => ({
                    href: buildImportHref(filters, { kind: tipo }),
                    label: kindLabel(tipo),
                    ativo: filters.kind === tipo,
                  })),
                ]}
              />

              <FilterMenu
                rotulo={filters.status === null ? "Estado" : batchStatusLabel(filters.status)}
                opcoes={[
                  {
                    href: buildImportHref(filters, { status: null }),
                    label: "Todos os estados",
                    ativo: filters.status === null,
                  },
                  ...IMPORT_STATUSES.map((estado) => ({
                    href: buildImportHref(filters, { status: estado }),
                    label: batchStatusLabel(estado),
                    ativo: filters.status === estado,
                  })),
                ]}
              />
            </>
          }
        >
          {rows.length === 0 && (
            <p className="sb-empty">
              {filters.kind === null && filters.status === null
                ? "Nenhum arquivo importado ainda. Envie uma exportação do UpSeller para começar."
                : janela.label}
            </p>
          )}

          {rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Arquivo</th>
                    <th>Tipo</th>
                    <th>Estado</th>
                    <th className="sb-num">Linhas</th>
                    <th className="sb-num">OK</th>
                    <th className="sb-num">Ignoradas</th>
                    <th className="sb-num">Inválidas</th>
                    <th>Enviado em</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((batch) => (
                    <tr key={batch.id}>
                      <td>
                        <Link className="sb-entity" href={`/importacoes/${batch.id}`}>
                          {batch.file_name ?? batch.id}
                        </Link>

                        {batch.last_error !== null && (
                          <div style={{ color: "var(--sb-danger)", fontSize: "0.75rem" }}>
                            {sanitizeErrorText(batch.last_error)}
                          </div>
                        )}
                      </td>
                      <td>{kindLabel(batch.kind)}</td>
                      <td>
                        <StatusPill code={batch.status} label={batchStatusLabel(batch.status)} />
                      </td>
                      <td className="sb-num">{formatCount(batch.total_rows)}</td>
                      <td className="sb-num">{formatCount(batch.ok_rows)}</td>
                      <td className="sb-num">{formatCount(batch.skipped_rows)}</td>
                      <td
                        className="sb-num"
                        {...((batch.invalid_rows ?? 0) > 0
                          ? { style: { color: "var(--sb-danger)" } }
                          : {})}
                      >
                        {formatCount(batch.invalid_rows)}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(batch.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {error === null && janela.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <FilterPill href={buildImportHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < janela.totalPages && (
            <FilterPill href={buildImportHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
