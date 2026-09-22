import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { CarregandoSeODemorar } from "../../components/carregando-link";
import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { TOM } from "../../components/tone";
import {
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  OPERATION_TYPES,
  PAGE_SIZE,
  buildDocumentHref,
  documentTypeLabel,
  resolveDocumentFilters,
  summarizeDocumentWindow,
} from "../../lib/document-filters";
import {
  lerVisaoDocumentos,
  linhaDoLegado,
  proximoPassoDoDocumento,
  type LinhaDocumento,
  type LinhaDocumentoLegado,
  type VisaoDocumentos,
} from "../../lib/documents-overview";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { batchStatusLabel, operationTypeLabel } from "../../lib/labels";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Notas e Documentos — Speed Bikers Gestão" };

// A sessão vem de cookie: renderizar em build produziria a página de outra
// pessoa. Mesmo raciocínio de apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Notas e Documentos — a fila de entrada e saída de mercadoria.
 *
 * Nasceu em D18 como "NF-e / Entradas", pelo frame `ProcessScreen type="nfe"`,
 * que era um ESBOÇO: cabeçalho, um painel "Histórico de Notas" e, no lugar da
 * tabela, um parágrafo de reserva. Por isso a tela não ganhou cartões então —
 * o que faltava não era dado, era desenho (D-249/D-252).
 *
 * **D-375 mudou o que a tela FAZ, e é isso que justifica o novo desenho.** Ela
 * deixou de ser "upload de XML" e passou a receber quatro documentos, de
 * entrada e de saída, em XML e em PDF:
 *
 *   NF-e (XML)        o caminho preferido — conferido pela SEFAZ
 *   DANFE (PDF)       o papel da mesma nota, quando só ele chega
 *   Pedido de saída   o impresso do UpSeller (SKU e quantidade, sem valor)
 *   Envio ao Full     as instruções de preparação do Mercado Livre
 *
 * Os cartões e as contagens saem todos da MESMA leitura
 * (`get_documents_overview`), no padrão de `/reposicao` (D-358) e `/compras`
 * (D-365). Nada é somado aqui.
 *
 * **Enquanto a migration não chega ao banco** (a web da branch principal vai ao
 * ar antes dela, D-363), a RPC responde PGRST202 e a tela cai na consulta
 * antiga em `documents`: sem cartões, sem tipo e sem valor — nunca em erro.
 */

/** O ciclo de `docs/NFE.md`, na ordem em que acontece. Tom por etapa, não por gravidade. */
const TOM_ESTADO: Record<string, keyof typeof TOM> = {
  UPLOADED: "info",
  PARSING: "info",
  PARSED: "atencao",
  APPLYING: "info",
  APPLIED: "ok",
  FAILED: "perigo",
  CANCELLED: "neutro",
};

const DESCRICAO_ESTADO: Record<string, string> = {
  UPLOADED: "aguardando leitura",
  PARSING: "sendo lido",
  PARSED: "esperando conferência",
  APPLYING: "baixando no estoque",
  APPLIED: "já no estoque",
  FAILED: "não foi possível ler",
  CANCELLED: "interrompidos",
};

/**
 * O estado em uma palavra, para a TABELA. `batchStatusLabel` continua sendo o
 * rótulo de sempre nos cartões e nos menus, onde há espaço; aqui ele custava a
 * coluna do próximo passo (a classe de D-315: tabela mais larga que a tela).
 */
const ESTADO_CURTO: Record<string, string> = {
  UPLOADED: "Enviado",
  PARSING: "Lendo",
  PARSED: "Em conferência",
  APPLYING: "Aplicando",
  APPLIED: "Aplicado",
  FAILED: "Falhou",
  CANCELLED: "Cancelado",
};

function plural(n: number, um: string, varios: string): string {
  return `${formatCount(n)} ${n === 1 ? um : varios}`;
}

/** As colunas que a leitura antiga sabe responder — a mesma lista de antes de D-375. */
const COLUNAS_LEGADO =
  "id, file_name, status, operation_type, document_number, series, access_key, issuer_name, issue_date, total_items, resolved_items, created_at, applied_at, last_error";

/**
 * O número do documento como quem confere o chama: "NF 22 · série 3",
 * "OUT12467", "#77036991". Sem número, o nome do arquivo é o que existe.
 */
function identificacao(linha: LinhaDocumento): string {
  if (linha.document_number === null) return linha.file_name;

  const serie = linha.series === null ? "" : ` · série ${linha.series}`;

  return `${linha.document_number}${serie}`;
}

export default async function NotasFiscaisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolveDocumentFilters(query);
  const supabase = await createClient();
  const membership = await currentMembership();
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / OPERAÇÃO"
          title="Notas e Documentos"
          subtitle="Entrada e saída de mercadoria por XML ou PDF."
        />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const from = (filters.page - 1) * PAGE_SIZE;

  /*
    A organização vai no argumento porque a RPC recorta por ela, não porque ela
    seja a proteção: quem autoriza continua sendo a policy de `documents`
    (`documents_select_admin`) — a função é `security invoker` exatamente para
    isso. Um id de outra organização aqui não devolveria linha nenhuma.
  */
  const leitura = await supabase.rpc("get_documents_overview", {
    p_organization_id: organizationId,
    p_limit: PAGE_SIZE,
    p_offset: from,
    ...(filters.status !== null ? { p_status: filters.status } : {}),
    ...(filters.operation !== null ? { p_operation: filters.operation } : {}),
    ...(filters.type !== null ? { p_type: filters.type } : {}),
    ...(filters.search !== null ? { p_search: filters.search } : {}),
  });

  let visao: VisaoDocumentos | null = null;
  let linhas: readonly LinhaDocumento[] = [];
  let total = 0;
  let erro: string | null = null;

  if (leitura.error === null) {
    visao = lerVisaoDocumentos(leitura.data);

    if (visao === null) {
      erro = "a leitura dos documentos voltou fora do contrato esperado";
    } else {
      linhas = visao.linhas;
      total = visao.total;
    }
  } else if (leitura.error.code === "PGRST202") {
    /*
      A função nova ainda não existe neste banco. A consulta de D18 continua
      servindo a fila; tipo e busca não existem nela e são ignorados — o que a
      tela NÃO pode fazer é mostrar zero linhas como se o filtro tivesse
      funcionado, então o recorte por tipo desaparece junto com os cartões.
      `count: "exact"` corre sobre o conjunto filtrado, antes do `range`.
    */
    let consulta = supabase.from("documents").select(COLUNAS_LEGADO, { count: "exact" });

    if (filters.status !== null) consulta = consulta.eq("status", filters.status);
    if (filters.operation !== null) consulta = consulta.eq("operation_type", filters.operation);

    const legado = await consulta.order("created_at", { ascending: false }).range(from, from + PAGE_SIZE - 1);

    if (legado.error !== null) {
      erro = legado.error.message;
    } else {
      linhas = (legado.data as unknown as LinhaDocumentoLegado[]).map(linhaDoLegado);
      total = legado.count ?? 0;
    }
  } else {
    erro = leitura.error.message;
  }

  const janela = summarizeDocumentWindow(filters.page, total, linhas.length);
  const filtroAtivo =
    filters.status !== null || filters.operation !== null || filters.type !== null || filters.search !== null;
  const semNenhumDocumento = erro === null && total === 0 && !filtroAtivo;
  const contagemEstado = visao?.contagens.estado ?? {};
  const contagemTipo = visao?.contagens.tipo ?? {};
  const naBusca = visao === null ? null : Object.values(contagemEstado).reduce((soma, n) => soma + n, 0);

  const rotuloEstado = filters.status === null ? "Estado" : batchStatusLabel(filters.status);
  const rotuloDirecao = filters.operation === null ? "Direção" : operationTypeLabel(filters.operation);
  const rotuloTipo = filters.type === null ? "Tipo" : documentTypeLabel(filters.type);

  const tituloFila = [
    "Documentos",
    filters.type === null ? null : documentTypeLabel(filters.type),
    filters.search === null ? null : `busca "${filters.search}"`,
  ]
    .filter((parte): parte is string => parte !== null)
    .join(" · ");

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Notas e Documentos"
        subtitle="Entrada e saída de mercadoria por XML ou PDF — leitura, conferência e baixa no estoque."
        aside={
          <>
            {/*
              Busca como GET nativo: o recorte fica na URL. Os `hidden` são
              obrigatórios porque um form GET só envia os campos que tem — sem
              eles, buscar limparia os outros recortes (D-136).
            */}
            <form method="get" action="/notas-fiscais" className="sb-rep-busca">
              {filters.status !== null && <input type="hidden" name="estado" value={filters.status} />}
              {filters.operation !== null && <input type="hidden" name="direcao" value={filters.operation} />}
              {filters.type !== null && <input type="hidden" name="tipo" value={filters.type} />}
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="Nº, chave, emitente ou arquivo"
                aria-label="Buscar por número, chave de acesso, emitente ou nome do arquivo"
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
            <Link className="sb-button sb-button-primary" href="/notas-fiscais/nova">
              Enviar documento
            </Link>
          </>
        }
      />

      {erro !== null && (
        <p role="alert" className="sb-note sb-note-perigo" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Não foi possível carregar os documentos: {erro}
        </p>
      )}

      {semNenhumDocumento && (
        <div className="sb-cmp-vazio">
          <b>Nenhum documento enviado ainda</b>
          <span>
            Envie o XML de uma NF-e (o caminho preferido — é o único conferido pela SEFAZ) ou, quando só o papel
            chegar, o PDF: DANFE, Pedido de Saída do UpSeller ou as instruções de envio ao Full. A leitura reconhece o
            documento pelo conteúdo, não pelo nome do arquivo.
          </span>
          <div>
            <Link className="sb-button sb-button-primary" href="/notas-fiscais/nova">
              Enviar o primeiro documento
            </Link>
          </div>
        </div>
      )}

      {visao !== null && !semNenhumDocumento && (
        /*
          O RESUMO: as quatro perguntas de quem confere. Os números respeitam a
          BUSCA e ignoram os recortes (D-250) — clicar num cartão não zera os
          outros.
        */
        <section className="sb-rep-resumo" aria-label="Resumo dos documentos">
          <Link
            href={buildDocumentHref(filters, { status: filters.status === "PARSED" ? null : "PARSED" })}
            className={
              visao.resumo.em_conferencia > 0
                ? "sb-rep-destaque sb-rep-destaque-atencao sb-cmp-destaque-link"
                : "sb-rep-destaque sb-cmp-destaque-link"
            }
            aria-current={filters.status === "PARSED" ? "true" : undefined}
          >
            <span className="sb-rep-destaque-rotulo">Esperando conferência</span>
            <strong>{plural(visao.resumo.em_conferencia, "documento", "documentos")}</strong>
            <span className="sb-rep-destaque-nota">
              {visao.resumo.em_conferencia === 0
                ? "nada parado antes do estoque"
                : visao.resumo.itens_sem_vinculo === 0
                  ? "todos os itens vinculados · falta aplicar"
                  : `${plural(visao.resumo.itens_sem_vinculo, "item sem SKU", "itens sem SKU")} para vincular`}
            </span>
            <CarregandoSeODemorar />
          </Link>

          <div className="sb-rep-destaque">
            <span className="sb-rep-destaque-rotulo">Em leitura</span>
            <strong>{plural(visao.resumo.em_leitura, "documento", "documentos")}</strong>
            <span className="sb-rep-destaque-nota">
              {visao.resumo.em_leitura === 0 ? "nenhum arquivo na fila" : "o worker está lendo o arquivo"}
            </span>
          </div>

          <Link
            href={buildDocumentHref(filters, { status: filters.status === "FAILED" ? null : "FAILED" })}
            className={
              visao.resumo.falhas > 0
                ? "sb-rep-destaque sb-rep-destaque-perigo sb-cmp-destaque-link"
                : "sb-rep-destaque sb-cmp-destaque-link"
            }
            aria-current={filters.status === "FAILED" ? "true" : undefined}
          >
            <span className="sb-rep-destaque-rotulo">Falhas de leitura</span>
            <strong>{plural(visao.resumo.falhas, "documento", "documentos")}</strong>
            <span className="sb-rep-destaque-nota">
              {visao.resumo.falhas === 0 ? "nenhum arquivo recusado" : "ver o motivo e reenviar · ver"}
            </span>
            <CarregandoSeODemorar />
          </Link>

          <div className="sb-rep-destaque">
            <span className="sb-rep-destaque-rotulo">Aplicados em 30 dias</span>
            <strong>{plural(visao.resumo.aplicados_30d, "documento", "documentos")}</strong>
            <span className="sb-rep-destaque-nota">
              {visao.resumo.aplicados_30d === 0
                ? "nenhuma baixa no período"
                : `${formatCount(visao.resumo.entradas_30d)} de entrada · ${formatCount(visao.resumo.saidas_30d)} de saída`}
            </span>
          </div>
        </section>
      )}

      {!semNenhumDocumento && erro === null && (
        /*
          OS ESTADOS DO CICLO como filtro, mais "Todos". Sem a leitura nova os
          cartões continuam filtrando, só sem número — melhor que esconder o
          recorte.
        */
        <nav className="sb-rep-estados sb-nf-estados" aria-label="Filtrar por estado">
          <Link
            href={buildDocumentHref(filters, { status: null })}
            className={filters.status === null ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
            style={{ "--sb-rep-tom": "var(--sb-primary)" } as CSSProperties}
            aria-current={filters.status === null ? "true" : undefined}
          >
            <span className="sb-rep-estado-rotulo">Todos</span>
            <strong>{naBusca === null ? "—" : formatCount(naBusca)}</strong>
            <small>{filters.search === null ? "todos os documentos" : `com "${filters.search}"`}</small>
            <CarregandoSeODemorar />
          </Link>

          {DOCUMENT_STATUSES.map((estado) => {
            const ativo = filters.status === estado;
            const n = contagemEstado[estado];

            return (
              <Link
                key={estado}
                href={buildDocumentHref(filters, { status: ativo ? null : estado })}
                className={ativo ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
                style={{ "--sb-rep-tom": TOM[TOM_ESTADO[estado] ?? "neutro"].color } as CSSProperties}
                aria-current={ativo ? "true" : undefined}
              >
                <span className="sb-rep-estado-rotulo">{batchStatusLabel(estado)}</span>
                <strong>{visao === null ? "—" : formatCount(n ?? 0)}</strong>
                <small>{DESCRICAO_ESTADO[estado] ?? ""}</small>
                <CarregandoSeODemorar />
              </Link>
            );
          })}
        </nav>
      )}

      {erro === null && !semNenhumDocumento && (
        <Panel
          title={tituloFila}
          subtitle={`Mais recentes primeiro. ${janela.label}`}
          aside={
            <>
              {/*
                Tipo e direção como menus: cada opção é um LINK, o recorte fica
                na URL, nunca em estado React (regra de `FilterMenu`). O tipo só
                aparece quando a leitura nova responde — sem ela, filtrar por
                tipo devolveria a lista inteira e mentiria.
              */}
              {visao !== null && (
                <FilterMenu
                  rotulo={rotuloTipo}
                  opcoes={[
                    {
                      href: buildDocumentHref(filters, { type: null }),
                      label: "Todos os tipos",
                      ativo: filters.type === null,
                    },
                    ...DOCUMENT_TYPES.map((tipo) => {
                      const n = contagemTipo[tipo] ?? 0;

                      return {
                        href: buildDocumentHref(filters, { type: tipo }),
                        label: `${documentTypeLabel(tipo)} (${formatCount(n)})`,
                        ativo: filters.type === tipo,
                      };
                    }),
                  ]}
                />
              )}

              <FilterMenu
                rotulo={rotuloDirecao}
                opcoes={[
                  {
                    href: buildDocumentHref(filters, { operation: null }),
                    label: "Entradas e saídas",
                    ativo: filters.operation === null,
                  },
                  ...OPERATION_TYPES.map((direcao) => ({
                    href: buildDocumentHref(filters, { operation: direcao }),
                    label: operationTypeLabel(direcao),
                    ativo: filters.operation === direcao,
                  })),
                ]}
              />

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

              {filtroAtivo && (
                <Link className="sb-button" href="/notas-fiscais">
                  Limpar filtros
                  <CarregandoSeODemorar />
                </Link>
              )}

              {janela.totalPages > 1 && (
                <span className="sb-rep-paginas">
                  {filters.page > 1 && (
                    <Link className="sb-button" href={buildDocumentHref(filters, { page: filters.page - 1 })}>
                      ‹ Anterior
                      <CarregandoSeODemorar />
                    </Link>
                  )}
                  <span>
                    {filters.page} de {janela.totalPages}
                  </span>
                  {filters.page < janela.totalPages && (
                    <Link className="sb-button" href={buildDocumentHref(filters, { page: filters.page + 1 })}>
                      Próxima ›
                      <CarregandoSeODemorar />
                    </Link>
                  )}
                </span>
              )}
            </>
          }
        >
          {linhas.length === 0 && (
            <p className="sb-empty">
              {janela.label} <Link href="/notas-fiscais">Ver todos</Link>
            </p>
          )}

          {linhas.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table sb-nf-tabela">
                <thead>
                  <tr>
                    <th>Documento</th>
                    <th title="O layout lido e a direção do movimento. O tipo sai do conteúdo do arquivo, não do nome.">
                      Tipo e direção
                    </th>
                    <th>Origem</th>
                    <th className="sb-num" title="Itens com SKU vinculado. Vincular todos é o que libera a baixa.">
                      Itens
                    </th>
                    <th className="sb-num" title="Soma de quantidade × valor unitário. Documento de separação não traz valor.">
                      Valor
                    </th>
                    <th>Estado</th>
                    <th>Próximo passo</th>
                  </tr>
                </thead>

                <tbody>
                  {linhas.map((linha) => {
                    const passo = proximoPassoDoDocumento(linha);
                    const href = `/notas-fiscais/${linha.id}`;
                    const total_itens = linha.total_items;
                    const resolvidos = linha.resolved_items ?? 0;

                    return (
                      <tr key={linha.id} className={linha.status === "FAILED" ? "sb-nf-linha-falha" : undefined}>
                        <td>
                          <Link className="sb-cmp-numero" href={href}>
                            {identificacao(linha)}
                          </Link>
                          <span className="sb-cmp-sub" title={linha.file_name}>
                            {linha.document_number === null ? formatDateTime(linha.created_at) : linha.file_name}
                          </span>
                          {linha.reference !== null && linha.reference !== "" && (
                            <span className="sb-nf-referencia" title={linha.reference}>
                              {linha.reference}
                            </span>
                          )}
                          {linha.last_error !== null && (
                            <span className="sb-nf-erro" title={linha.last_error}>
                              {linha.last_error}
                            </span>
                          )}
                        </td>

                        {/*
                          Tipo e direção numa coluna só: são a mesma pergunta
                          ("que documento é este, e para que lado ele move?"), e
                          separá-las empurrava o PRÓXIMO PASSO para fora da tela
                          em 1440 px — a classe de D-315.

                          O tipo é NULO enquanto a leitura não terminou, e a
                          tela diz "em leitura" em vez de chutar "NF-e", que é o
                          que o nome do arquivo sugeriria.
                        */}
                        <td>
                          <span className="sb-nf-tipo">{documentTypeLabel(linha.document_type)}</span>
                          <span className="sb-cmp-sub">
                            {linha.operation_type === null ? (
                              (linha.source_format ?? "—")
                            ) : (
                              <span
                                className="sb-nf-direcao"
                                style={
                                  {
                                    "--sb-nf-tom":
                                      linha.operation_type === "ENTRADA" ? "var(--sb-success)" : "var(--sb-secondary)",
                                  } as CSSProperties
                                }
                              >
                                {linha.operation_type === "ENTRADA" ? "↓" : "↑"}{" "}
                                {operationTypeLabel(linha.operation_type)}
                              </span>
                            )}
                            {linha.operation_type !== null && linha.source_format !== null
                              ? ` · ${linha.source_format}`
                              : ""}
                          </span>
                        </td>

                        <td>
                          {linha.issuer_name === null ? (
                            <span className="sb-rep-mudo">{linha.access_key === null ? "—" : "sem emitente"}</span>
                          ) : (
                            <span className="sb-nf-emitente" title={linha.issuer_cnpj ?? undefined}>
                              {linha.issuer_name}
                            </span>
                          )}
                          {linha.access_key !== null && (
                            <span className="sb-cmp-sub sb-mono" title={linha.access_key}>
                              chave …{linha.access_key.slice(-6)}
                            </span>
                          )}
                        </td>

                        {/*
                          Ausência não vira zero (D-067): sem `total_items` o
                          documento ainda não foi lido, e "0 de 0" afirmaria
                          conferência vazia onde não houve leitura nenhuma.
                        */}
                        <td className="sb-num">
                          {total_itens === null ? (
                            <span className="sb-rep-mudo">—</span>
                          ) : (
                            <>
                              <span className={resolvidos < total_itens ? "sb-nf-itens-parcial" : "sb-nf-itens"}>
                                {formatCount(resolvidos)} de {formatCount(total_itens)}
                              </span>
                              {linha.unidades > 0 && (
                                <span className="sb-cmp-sub">{formatCount(linha.unidades)} un</span>
                              )}
                            </>
                          )}
                        </td>

                        {/*
                          Documento de separação NÃO traz valor, e zero se leria
                          como "de graça" (D-254): a célula diz "sem valor".
                        */}
                        <td className="sb-num">
                          {linha.valor > 0 ? (
                            <span className="sb-cmp-valor">{formatCurrency(linha.valor)}</span>
                          ) : (
                            <span className="sb-rep-mudo">{total_itens === null ? "—" : "sem valor"}</span>
                          )}
                        </td>

                        <td>
                          <StatusPill code={linha.status} label={ESTADO_CURTO[linha.status] ?? batchStatusLabel(linha.status)} />
                          <span className="sb-cmp-sub">
                            {linha.applied_at === null
                              ? formatDateTime(linha.created_at)
                              : `aplicado ${formatDateTime(linha.applied_at)}`}
                          </span>
                        </td>

                        <td>
                          <Link
                            className="sb-cmp-passo"
                            href={href}
                            style={{ "--sb-cmp-tom": TOM[passo.tom].color } as CSSProperties}
                          >
                            {passo.texto}
                            <span aria-hidden="true"> ›</span>
                          </Link>
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
