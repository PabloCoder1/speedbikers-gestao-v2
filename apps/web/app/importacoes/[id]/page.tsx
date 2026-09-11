import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AutoRefresh } from "../../../components/auto-refresh";
import { FilterPill } from "../../../components/filter-pill";
import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { ProcessSteps } from "../../../components/process-steps";
import { AcessoRestrito } from "../../../components/acesso-restrito";
import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { TOM, tomDeStatus } from "../../../components/tone";
import { erpImportEtapas } from "../../../lib/erp-import-steps";
import { formatCount, formatDateTime } from "../../../lib/format";
import {
  ROW_PAGE_SIZE,
  ROW_STATUSES,
  buildRowHref,
  resolveRowFilters,
  summarizeRowWindow,
} from "../../../lib/import-filters";
import {
  applyStatusLabel,
  batchStatusLabel,
  kindLabel,
  rowStatusLabel,
  statusTone,
} from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";
import { currentMembership } from "../../../lib/membership";
import { ConfirmApplyForm } from "./confirm-apply-form";
import { summarize } from "./summarize";

export const dynamic = "force-dynamic";

/**
 * Tela de conferência.
 *
 * Terceira etapa do fluxo `upload -> parse -> CONFERÊNCIA -> aplicação`. Aqui
 * ninguém altera catálogo, vínculo nem estoque: mostra-se exatamente o que o
 * arquivo produziu, para um humano decidir antes de acontecer.
 *
 * A ordem padrão é por linha, e não por status, porque quem confere está com a
 * planilha aberta ao lado — a linha 4.312 aqui tem que ser a linha 4.312 lá.
 *
 * Migrada em D-278 (fatia D37b). O indicador de etapas é o terceiro consumidor
 * do `.process-steps`, e o que ele mede aqui é diferente dos outros dois: a
 * aplicação declara a fração DEPOIS do ato, sobre as linhas APROVADAS — o
 * raciocínio e a medição estão em `lib/erp-import-steps.ts`.
 */

export default async function ConferenciaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { id } = await params;
  const query = await searchParams;

  const filters = resolveRowFilters(query);

  const supabase = await createClient();

  // As duas leituras partem do mesmo `id` da rota, e a das linhas só precisa
  // de `filter` e `page`, que vêm da URL — nunca precisou esperar o lote
  // (D-197). Duas latências em fila onde uma resolve, e esta tela pagava isso
  // também em toda troca de página e de filtro, que são as interações
  // frequentes dela.
  //
  // A consulta das linhas é montada ANTES do `Promise.all` porque o filtro de
  // status é opcional; montar não dispara nada, o `await` é que dispara.
  const from = (filters.page - 1) * ROW_PAGE_SIZE;

  let rowsQuery = supabase
    .from("erp_import_rows")
    .select("row_number, status, reason, sku_key, payload, apply_status, apply_reason", { count: "exact" })
    .eq("batch_id", id);

  if (filters.status !== null) {
    rowsQuery = rowsQuery.eq("status", filters.status);
  }

  const [membership, batch, rows] = await Promise.all([
    currentMembership(supabase),
    supabase
      .from("erp_import_batches")
      .select(
        "id, kind, status, file_name, total_rows, ok_rows, skipped_rows, invalid_rows, applied_rows, unresolved_rows, parsed_at, created_at, last_error",
      )
      .eq("id", id)
      .maybeSingle(),
    rowsQuery.order("row_number").range(from, from + ROW_PAGE_SIZE - 1),
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

  // `null` aqui pode ser "não existe" ou "a policy escondeu". A tela responde
  // igual nos dois casos de propósito: confirmar a existência de um lote de
  // outra organização já é vazamento. A RLS restringe `erp_import_rows` de
  // forma independente, então ler as linhas em paralelo não contorna isso.
  if (batch.error !== null || batch.data === null) {
    notFound();
  }

  // Copia local: dentro de um callback o TypeScript descarta o estreitamento de
  // uma propriedade, porque nada garante que ela nao mudou nesse meio-tempo.
  const info = batch.data;

  const janela = summarizeRowWindow(filters.page, rows.count ?? 0, rows.data?.length ?? 0);

  // Estados de trabalho em curso. Fora deles nada muda sozinho, e recarregar
  // seria so gasto.
  const working = info.status === "UPLOADED" || info.status === "PARSING" || info.status === "APPLYING";

  const etapas = erpImportEtapas({
    status: info.status,
    parsedAt: info.parsed_at,
    totalRows: info.total_rows,
    okRows: info.ok_rows,
    appliedRows: info.applied_rows,
    unresolvedRows: info.unresolved_rows,
  });

  const badges: readonly ObjectBadge[] = [
    { label: batchStatusLabel(info.status), tom: tomDeStatus(statusTone(info.status)) },
    { label: kindLabel(info.kind), tom: "info" },
  ];

  // Os fatos do lote. "Aplicadas" e "Pendentes" só entram depois que a
  // aplicação começou: antes disso não são zero, são inexistentes (D-067).
  const fatos: readonly (readonly [string, string])[] = [
    ["Linhas", formatCount(info.total_rows)],
    ["OK", formatCount(info.ok_rows)],
    ["Ignoradas", formatCount(info.skipped_rows)],
    ["Inválidas", formatCount(info.invalid_rows)],
    ...(info.status === "APPLYING" || info.status === "APPLIED"
      ? ([
          ["Aplicadas", formatCount(info.applied_rows)],
          ["Pendentes", formatCount(info.unresolved_rows)],
        ] as const)
      : []),
  ];

  return (
    <Shell>
      {working && <AutoRefresh />}

      <PageTitle
        eyebrow="ADMINISTRAÇÃO / DADOS E PROCESSAMENTOS"
        title="Importações"
        subtitle={<Link href="/importacoes">← Voltar ao histórico de importações</Link>}
        compacto
      />

      <ObjectHeader
        identificador="IMPORTAÇÃO"
        titulo={info.file_name ?? info.id}
        badges={badges}
        meta={info.parsed_at === null ? undefined : `Lido em ${formatDateTime(info.parsed_at)}`}
      >
        <dl className="sb-fact-grid">
          {fatos.map(([rotulo, valor]) => (
            <div key={rotulo}>
              <dt>{rotulo}</dt>
              <dd>{valor}</dd>
            </div>
          ))}
        </dl>
      </ObjectHeader>

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <ProcessSteps etapas={etapas} rotulo="Etapas desta importação" />
      </div>

      {info.last_error !== null && (
        <p
          role="alert"
          style={{
            ...TOM.perigo,
            margin: "0 0 var(--sb-space-3)",
            padding: "var(--sb-space-3)",
            borderRadius: "var(--sb-radius)",
            fontSize: "0.8125rem",
            lineHeight: 1.5,
          }}
        >
          {info.last_error}
        </p>
      )}

      {info.status === "PARSED" && <ConfirmApplyForm batchId={info.id} />}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel
          title="Linhas da planilha"
          subtitle={janela.label}
          aside={
            /* Eram pílulas de raio 999px — a forma que o design system
               substituiu pelo `FilterPill` do frame (D-232). */
            <>
              <FilterPill
                href={buildRowHref(info.id, filters, { status: null })}
                active={filters.status === null}
              >
                Todas
              </FilterPill>
              {ROW_STATUSES.map((estado) => (
                <FilterPill
                  key={estado}
                  href={buildRowHref(info.id, filters, { status: estado })}
                  active={filters.status === estado}
                >
                  {rowStatusLabel(estado)}
                </FilterPill>
              ))}
            </>
          }
        >
          {rows.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar as linhas: {rows.error.message}
            </p>
          )}

          {rows.error === null && rows.data.length === 0 && (
            <p className="sb-empty">Nenhuma linha neste filtro.</p>
          )}

          {rows.error === null && rows.data.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th className="sb-num">Linha</th>
                    <th>Estado</th>
                    <th>SKU</th>
                    <th>Conteúdo lido</th>
                    {info.status === "APPLIED" && <th>Aplicação</th>}
                  </tr>
                </thead>

                <tbody>
                  {rows.data.map((row) => (
                    <tr key={row.row_number}>
                      <td className="sb-num">{row.row_number}</td>
                      <td>
                        <StatusPill code={row.status} label={rowStatusLabel(row.status)} />
                      </td>
                      <td className="sb-mono">{row.sku_key ?? "—"}</td>
                      <td
                        {...(row.reason === null ? {} : { style: { color: "var(--sb-text-soft)" } })}
                      >
                        {row.reason ?? summarize(info.kind, row.payload)}
                      </td>
                      {info.status === "APPLIED" && (
                        <td>
                          {row.apply_status === null ? (
                            "—"
                          ) : (
                            <StatusPill code={row.apply_status} label={applyStatusLabel(row.apply_status)} />
                          )}
                          {row.apply_reason !== null && (
                            <div
                              style={{
                                fontSize: "0.75rem",
                                color: "var(--sb-text-soft)",
                                marginTop: "0.125rem",
                              }}
                            >
                              {row.apply_reason}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {janela.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <FilterPill href={buildRowHref(info.id, filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < janela.totalPages && (
            <FilterPill href={buildRowHref(info.id, filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
