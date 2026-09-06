import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import {
  DOCUMENT_STATUSES,
  OPERATION_TYPES,
  PAGE_SIZE,
  buildDocumentHref,
  resolveDocumentFilters,
  summarizeDocumentWindow,
} from "../../lib/document-filters";
import { formatCount, formatDateTime } from "../../lib/format";
import { batchStatusLabel, operationTypeLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Notas Fiscais — Speed Bikers Gestão" };

// A sessão vem de cookie: renderizar em build produziria a página de outra
// pessoa. Mesmo raciocínio de apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * NF-e / Entradas — a lista, pelo frame `ProcessScreen type="nfe"` (D18).
 *
 * **O frame desta tela é um ESBOÇO, e isso mudou o que a fatia faz.** As cinco
 * variações do `ProcessScreen` não estão no mesmo estágio: `movements` traz
 * três cartões e a tabela inteira, `links` traz cinco cartões e sete colunas —
 * mas `nfe` (que divide o corpo com `suppliers`) tem cabeçalho, um painel
 * "Histórico de Notas" e, no lugar da tabela, um parágrafo de reserva
 * ("Lista de notas carregada e validada..."). Não há faixa de KPIs desenhada.
 *
 * Por isso esta tela NÃO ganhou `KpiStrip`, ao contrário de D14–D17: a fila
 * previa "PageTitle + KpiStrip + Panel + .sb-table" antes de alguém ler o
 * frame, e o frame não pede a faixa. Inventar quatro números para preencher um
 * espaço que o desenho não reservou é a classe de erro que D-249 e D-252
 * evitaram do outro lado (recusar célula sem dado); aqui o que falta não é o
 * dado, é o desenho.
 *
 * O que o frame DITA e esta tela cumpre: sobrancelha "ESTOQUE / OPERAÇÃO",
 * título "NF-e / Entradas", a linha de apoio, a ação primária no cabeçalho
 * (a primeira das telas de processo a ter uma) e o painel "Histórico de Notas"
 * com o controle de filtros na barra dele.
 */

interface DocumentRow {
  id: string;
  file_name: string | null;
  status: string;
  operation_type: string | null;
  document_number: string | null;
  issuer_name: string | null;
  total_items: number | null;
  resolved_items: number;
  created_at: string;
  last_error: string | null;
}

export default async function NotasFiscaisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolveDocumentFilters(query);
  const supabase = await createClient();

  const from = (filters.page - 1) * PAGE_SIZE;

  // Sem filtro por organização na consulta: a policy já restringe
  // (documents_select_admin), e repetir a condição aqui daria a impressão de
  // que ela é a proteção — não é.
  //
  // `count: "exact"` corre sobre o conjunto FILTRADO, antes do `range` — é o
  // total da busca, não o da página, e é o que a janela declara. A tela lia
  // `.limit(50)` sem dizer que havia corte (classe de D-131).
  let consulta = supabase
    .from("documents")
    .select(
      "id, file_name, status, operation_type, document_number, issuer_name, total_items, resolved_items, created_at, last_error",
      { count: "exact" },
    );

  if (filters.status !== null) {
    consulta = consulta.eq("status", filters.status);
  }

  if (filters.operation !== null) {
    consulta = consulta.eq("operation_type", filters.operation);
  }

  const { data, error, count } = await consulta
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  const rows = (data ?? []) as DocumentRow[];
  const window = summarizeDocumentWindow(filters.page, count ?? 0, rows.length);

  const rotuloEstado = filters.status === null ? "Estado" : batchStatusLabel(filters.status);
  const rotuloDirecao = filters.operation === null ? "Direção" : operationTypeLabel(filters.operation);

  return (
    <Shell>
      {/*
        `OpsHeader` do frame: sobrancelha, título, linha de apoio e a barra à
        direita. O texto de apoio é o do próprio frame.
      */}
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="NF-e / Entradas"
        subtitle="Receba XMLs com vinculação, conferência e rastreabilidade."
        aside={
          /*
            A ação primária do frame ("Upload XML"). É a primeira tela de
            processo com uma, e por isso ela mora no cabeçalho — como no
            `OpsHeader` —, não em cima da tabela. O rótulo é o do frame; a rota
            é a real (`/notas-fiscais/nova`).
          */
          <Link className="sb-button sb-button-primary" href="/notas-fiscais/nova">
            Upload XML
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
          title="Histórico de Notas"
          aside={
            <>
              <span
                style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)", whiteSpace: "nowrap" }}
              >
                {window.label}
              </span>

              {/*
                O "Filtros ⌄" do frame, aberto nas duas dimensões que a tabela
                já mostra — estado e direção. Cada opção é um LINK: o recorte
                fica na URL, nunca em estado React (regra de `FilterMenu`).
              */}
              <FilterMenu
                rotulo={rotuloEstado}
                opcoes={[
                  {
                    href: buildDocumentHref(filters, { status: null }),
                    label: "Todos os estados",
                    ativo: filters.status === null,
                  },
                  ...DOCUMENT_STATUSES.map((estado) => ({
                    href: buildDocumentHref(filters, { status: estado }),
                    label: batchStatusLabel(estado),
                    ativo: filters.status === estado,
                  })),
                ]}
              />

              <FilterMenu
                rotulo={rotuloDirecao}
                opcoes={[
                  {
                    href: buildDocumentHref(filters, { operation: null }),
                    label: "Entradas e saídas",
                    ativo: filters.operation === null,
                  },
                  ...OPERATION_TYPES.map((tipo) => ({
                    href: buildDocumentHref(filters, { operation: tipo }),
                    label: operationTypeLabel(tipo),
                    ativo: filters.operation === tipo,
                  })),
                ]}
              />
            </>
          }
        >
          {rows.length === 0 && (
            <p className="sb-empty">
              {filters.status === null && filters.operation === null
                ? "Nenhuma nota fiscal enviada ainda. Envie o XML de uma compra ou saída para começar."
                : window.label}
            </p>
          )}

          {rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Arquivo</th>
                    <th>Número</th>
                    <th>Direção</th>
                    <th>Emitente</th>
                    <th>Estado</th>
                    <th className="sb-num">Itens vinculados</th>
                    <th>Enviado em</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((document) => (
                    <tr key={document.id}>
                      <td>
                        <Link className="sb-entity" href={`/notas-fiscais/${document.id}`}>
                          {document.file_name ?? document.id}
                        </Link>

                        {document.last_error !== null && (
                          <div style={{ color: "var(--sb-danger)", fontSize: "0.625rem" }}>
                            {document.last_error}
                          </div>
                        )}
                      </td>
                      <td className="sb-mono">{document.document_number ?? "—"}</td>
                      <td>
                        {document.operation_type === null
                          ? "—"
                          : operationTypeLabel(document.operation_type)}
                      </td>
                      <td>{document.issuer_name ?? "—"}</td>
                      <td>
                        <StatusPill code={document.status} label={batchStatusLabel(document.status)} />
                      </td>
                      {/*
                        Ausência não vira zero (D-067): sem `total_items` a nota
                        ainda não foi lida, e "0 de 0" afirmaria conferência
                        vazia onde não houve leitura nenhuma.
                      */}
                      <td className="sb-num">
                        {document.total_items === null
                          ? "—"
                          : `${formatCount(document.resolved_items)} de ${formatCount(document.total_items)}`}
                      </td>
                      <td>{formatDateTime(document.created_at)}</td>
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
            <Link className="sb-button" href={buildDocumentHref(filters, { page: filters.page - 1 })}>
              ← Anterior
            </Link>
          )}
          {filters.page < window.totalPages && (
            <Link className="sb-button" href={buildDocumentHref(filters, { page: filters.page + 1 })}>
              Próxima →
            </Link>
          )}
        </div>
      )}
    </Shell>
  );
}
