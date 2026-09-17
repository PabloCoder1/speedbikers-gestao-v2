import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { Icone } from "../../components/icons";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { TOM } from "../../components/tone";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";
import {
  PAGE_SIZE,
  buildSupplierHref,
  resolveSupplierFilters,
  summarizeSupplierWindow,
  type SupplierOrder,
  type SupplierState,
} from "../../lib/supplier-filters";
import {
  formatarDocumento,
  idadeRelativa,
  iniciais,
  lerVisaoFornecedores,
  type ContagensFornecedores,
} from "../../lib/suppliers-overview";

import { Canais } from "./canais";
import { InspecaoFornecedor } from "./inspecao-fornecedor";

export const metadata = { title: "Fornecedores — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Fornecedores — a lista, pelo frame `ProcessScreen type="suppliers"` (D20),
 * com "último pedido" e "valor comprado" em D-258, e refeita em D-366.
 *
 * ## D-366: uma leitura, e a tela que responde "com quem estou comprando?"
 *
 * A lista só listava: sem busca, um recorte (ativo/inativo), ordem só por nome e
 * nenhum resumo. `get_suppliers_overview` devolve numa ida a página, as
 * contagens dos recortes e os totais da base (em aberto e comprado), com as
 * três saídas de valor de D-258 — ausência de custo nunca vira R$ 0,00.
 *
 * O que a tela ganhou: busca por nome, razão social, contato, e-mail ou CNPJ
 * (com ou sem pontuação); recortes "com pedido em aberto" e "sem pedido"; ordem
 * por em aberto, pedido recente ou valor; canais de contato clicáveis; e o
 * atalho para um pedido novo já com o fornecedor.
 *
 * **Continua valendo a recusa de D-256:** lead time, cobertura, origem, marcas e
 * política NÃO são fato de fornecedor neste modelo (`skus.supplier_id` não
 * existe de propósito, D-174), e a tela não os promete.
 */

const RECORTES: readonly {
  chave: SupplierState;
  rotulo: string;
  descricao: string;
  cor: string;
}[] = [
  {
    chave: "todos",
    rotulo: "Todos",
    descricao: "a base inteira",
    cor: "var(--sb-primary)",
  },
  {
    chave: "ativos",
    rotulo: "Ativos",
    descricao: "aparecem no pedido de compra",
    cor: TOM.ok.color,
  },
  {
    chave: "em_aberto",
    rotulo: "Com pedido em aberto",
    descricao: "rascunho, aprovado ou enviado",
    cor: TOM.atencao.color,
  },
  {
    chave: "sem_pedido",
    rotulo: "Sem pedido",
    descricao: "nenhum pedido registrado",
    cor: "var(--sb-muted-ink)",
  },
  {
    chave: "inativos",
    rotulo: "Inativos",
    descricao: "fora de novos pedidos",
    cor: TOM.neutro.color,
  },
];

const ORDENS: readonly { chave: SupplierOrder; rotulo: string }[] = [
  { chave: "nome", rotulo: "Ordem: nome" },
  { chave: "em_aberto", rotulo: "Ordem: mais pedidos em aberto" },
  { chave: "recente", rotulo: "Ordem: pedido mais recente" },
  { chave: "valor", rotulo: "Ordem: maior valor comprado" },
];

/** "R$ 1,35 mi", "R$ 758 mil" — o destaque pede ordem de grandeza; o exato fica no `title`. */
const COMPACTO = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Valor com as três saídas de D-258: NULO é "sem custo", nunca R$ 0,00. */
function valorCompacto(valor: number | null): string {
  return valor === null ? "sem custo" : COMPACTO.format(valor);
}

function contagemDe(contagens: ContagensFornecedores, chave: SupplierState): number {
  return chave === "todos" ? contagens.todos : contagens[chave];
}

export default async function FornecedoresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolveSupplierFilters(query);

  const membership = await currentMembership();
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

  // Quem cadastra e edita: o mesmo par que `create_supplier`/`update_supplier`
  // conferem no banco. Esconder o botão é cortesia; a defesa é a RPC.
  const podeEditar = membership.role === "ADMIN" || membership.role === "GESTOR";

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_suppliers_overview", {
    p_organization_id: organizationId,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
    ...(filters.search === null ? {} : { p_search: filters.search }),
    ...(filters.state === "todos" ? {} : { p_state: filters.state }),
    ...(filters.order === "nome" ? {} : { p_order: filters.order }),
  });

  const visao = error === null ? lerVisaoFornecedores(data) : null;
  const erro =
    error?.message ?? (visao === null ? "a leitura dos fornecedores voltou fora do contrato esperado" : null);

  const window = summarizeSupplierWindow(filters.page, visao?.total ?? 0, visao?.linhas.length ?? 0);
  const filtroAtivo = filters.search !== null || filters.state !== "todos" || filters.order !== "nome";
  const recorteAtivo = RECORTES.find((r) => r.chave === filters.state);
  const agora = new Date();

  return (
    <Shell>
      {/*
        `OpsHeader` do frame. A linha de apoio do frame promete "Lead time,
        cobertura" por fornecedor, que o modelo não tem (D-256); fica a parte
        verdadeira dela — o relacionamento, que é o que foi COMPRADO (D-174).
      */}
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Fornecedores"
        subtitle="Cadastro e relacionamento de compra — o que foi pedido a cada fornecedor."
        aside={
          <>
            <form method="get" action="/fornecedores" className="sb-rep-busca" role="search">
              {/* GET nativo só envia os campos do form (D-136): as dimensões ativas vão escondidas. */}
              {filters.state !== "todos" && <input type="hidden" name="estado" value={filters.state} />}
              {filters.order !== "nome" && <input type="hidden" name="ordem" value={filters.order} />}
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="Nome, contato, e-mail ou CNPJ"
                aria-label="Buscar fornecedor por nome, contato, e-mail ou CNPJ"
                maxLength={80}
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
            {podeEditar && (
              <Link className="sb-button sb-button-primary" href="/fornecedores/novo">
                <Icone nome="mais" tamanho={14} />
                Novo Fornecedor
              </Link>
            )}
          </>
        }
      />

      {erro !== null && (
        <p role="alert" className="sb-note sb-note-perigo" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Não foi possível carregar os fornecedores: {erro}
        </p>
      )}

      {visao !== null && (
        <>
          {/*
            O RESUMO. Mesmo conjunto dos cartões — a busca, sem o recorte —, e
            nada somado aqui: os totais vêm do SQL com as três saídas de valor.
          */}
          <section className="sb-rep-resumo" aria-label="Resumo dos fornecedores">
            <Link
              className="sb-rep-destaque sb-forn-destaque-link"
              href={buildSupplierHref(filters, { state: "em_aberto" })}
              title={visao.totais.valorEmAberto === null ? undefined : formatCurrency(visao.totais.valorEmAberto)}
            >
              <span className="sb-rep-destaque-rotulo">Em aberto</span>
              <strong>{valorCompacto(visao.totais.valorEmAberto)}</strong>
              <span className="sb-rep-destaque-nota">
                {formatCount(visao.totais.pedidosEmAberto)} pedido(s) em {formatCount(visao.contagens.em_aberto)}{" "}
                fornecedor(es)
                {visao.totais.itensEmAbertoSemCusto > 0 && (
                  <em className="sb-forn-ressalva">
                    {" "}
                    · {formatCount(visao.totais.itensEmAbertoSemCusto)} item(ns) sem custo fora da soma
                  </em>
                )}
              </span>
            </Link>

            <div
              className="sb-rep-destaque"
              title={visao.totais.valorComprado === null ? undefined : formatCurrency(visao.totais.valorComprado)}
            >
              <span className="sb-rep-destaque-rotulo">Comprado</span>
              <strong>{valorCompacto(visao.totais.valorComprado)}</strong>
              <span className="sb-rep-destaque-nota">
                todos os pedidos, sem os cancelados
                {visao.totais.itensSemCusto > 0 && (
                  <em className="sb-forn-ressalva"> · {formatCount(visao.totais.itensSemCusto)} item(ns) sem custo</em>
                )}
              </span>
            </div>

            <div
              className="sb-rep-destaque"
              title={visao.totais.ultimoPedidoEm === null ? undefined : formatDateTime(visao.totais.ultimoPedidoEm)}
            >
              <span className="sb-rep-destaque-rotulo">Último pedido</span>
              <strong>{idadeRelativa(visao.totais.ultimoPedidoEm, agora) ?? "—"}</strong>
              <span className="sb-rep-destaque-nota">
                {visao.totais.ultimoPedidoFornecedor ?? "nenhum pedido de compra registrado"}
              </span>
            </div>

            <div className="sb-rep-destaque">
              <span className="sb-rep-destaque-rotulo">Base</span>
              <strong>
                {formatCount(visao.contagens.ativos)}{" "}
                <small className="sb-forn-de">de {formatCount(visao.contagens.todos)}</small>
              </strong>
              <span className="sb-rep-destaque-nota">
                ativos · {formatCount(visao.contagens.sem_pedido)} ainda sem pedido
              </span>
            </div>
          </section>

          {/* OS RECORTES como cartões, no desenho dos estados da reposição (D-358). */}
          <nav className="sb-rep-estados sb-forn-recortes" aria-label="Filtrar fornecedores">
            {RECORTES.map((recorte) => {
              const ativo = filters.state === recorte.chave;

              return (
                <Link
                  key={recorte.chave}
                  href={buildSupplierHref(filters, {
                    state: ativo && recorte.chave !== "todos" ? "todos" : recorte.chave,
                  })}
                  className={ativo ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
                  style={{ "--sb-rep-tom": recorte.cor } as CSSProperties}
                  aria-current={ativo ? "true" : undefined}
                >
                  <span className="sb-rep-estado-rotulo">{recorte.rotulo}</span>
                  <strong>{formatCount(contagemDe(visao.contagens, recorte.chave))}</strong>
                  <small>{recorte.descricao}</small>
                </Link>
              );
            })}
          </nav>

          <Panel
            title="Base de Fornecedores"
            subtitle={
              <>
                {filters.search !== null && (
                  <>
                    Busca por <b>“{filters.search}”</b>
                    {filters.state !== "todos" &&
                      recorteAtivo !== undefined &&
                      ` em ${recorteAtivo.rotulo.toLowerCase()}`}{" "}
                    ·{" "}
                  </>
                )}
                {window.label} Valor comprado sem os cancelados.
              </>
            }
            aside={
              <>
                {filtroAtivo && (
                  <Link className="sb-button" href="/fornecedores">
                    Limpar filtros
                  </Link>
                )}
                <FilterMenu
                  rotulo={ORDENS.find((o) => o.chave === filters.order)?.rotulo ?? "Ordem"}
                  opcoes={ORDENS.map((ordem) => ({
                    href: buildSupplierHref(filters, { order: ordem.chave }),
                    label: ordem.rotulo.replace("Ordem: ", ""),
                    ativo: filters.order === ordem.chave,
                  }))}
                />
                {window.totalPages > 1 && (
                  <span className="sb-rep-paginas">
                    {filters.page > 1 && (
                      <Link
                        className="sb-button"
                        href={buildSupplierHref(filters, {
                          page: filters.page - 1,
                        })}
                      >
                        ‹ Anterior
                      </Link>
                    )}
                    <span>
                      {filters.page} de {window.totalPages}
                    </span>
                    {filters.page < window.totalPages && (
                      <Link
                        className="sb-button"
                        href={buildSupplierHref(filters, {
                          page: filters.page + 1,
                        })}
                      >
                        Próxima ›
                      </Link>
                    )}
                  </span>
                )}
              </>
            }
          >
            {visao.linhas.length === 0 && (
              <div className="sb-forn-vazio">
                {visao.contagens.todos === 0 && filters.search === null ? (
                  <>
                    <b>Nenhum fornecedor cadastrado ainda.</b>
                    <span>Cadastre quem vende para você e acompanhe aqui o que foi pedido a cada um.</span>
                    {podeEditar && (
                      <Link className="sb-button sb-button-primary" href="/fornecedores/novo">
                        Cadastrar o primeiro fornecedor
                      </Link>
                    )}
                  </>
                ) : (
                  <>
                    <b>Nenhum fornecedor com estes filtros.</b>
                    <span>
                      {filters.search !== null
                        ? `Nada encontrado para “${filters.search}”. Confira a grafia ou busque pelo CNPJ.`
                        : "Troque o recorte acima para ver os demais."}
                    </span>
                    <Link className="sb-button" href="/fornecedores">
                      Ver todos
                    </Link>
                  </>
                )}
              </div>
            )}

            {visao.linhas.length > 0 && (
              <div className="sb-forn-tabela-rolagem">
                <table className="sb-table sb-forn-tabela">
                  <thead>
                    <tr>
                      <th>Fornecedor</th>
                      <th>Contato</th>
                      <th className="sb-num">Pedidos</th>
                      <th>Último pedido</th>
                      <th className="sb-num" title="Soma dos itens dos pedidos, sem os cancelados">
                        Valor comprado
                      </th>
                      <th>Estado</th>
                      <th>
                        <span className="sb-sr-only">Ações</span>
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {visao.linhas.map((s) => {
                      const documento = formatarDocumento(s.document);

                      return (
                        <tr key={s.id} className={s.is_active ? undefined : "sb-forn-linha-inativa"}>
                          <td>
                            <div className="sb-forn-identidade">
                              <span className="sb-avatar sb-forn-avatar" aria-hidden="true">
                                {iniciais(s.name)}
                              </span>
                              <div className="sb-forn-nome">
                                {/* Dashboard do fornecedor (D-174) — o destino individual. */}
                                <Link className="sb-entity" href={`/fornecedores/${s.id}`}>
                                  {s.name}
                                </Link>
                                <span className="sb-forn-sub">
                                  {s.legal_name !== null && <span>{s.legal_name}</span>}
                                  {documento !== null && <span className="sb-mono">{documento}</span>}
                                  {s.legal_name === null && documento === null && (
                                    <span>sem razão social nem CNPJ</span>
                                  )}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="sb-forn-contato">
                              <span className={s.contact_name === null ? "sb-rep-mudo" : undefined}>
                                {s.contact_name ?? "sem pessoa de contato"}
                              </span>
                              <Canais canais={s} compacto />
                            </div>
                          </td>
                          <td className="sb-num">
                            <b className="sb-forn-num">{formatCount(s.orders_total)}</b>
                            {s.orders_em_aberto > 0 && (
                              <span className="sb-status sb-forn-aberto" style={TOM.atencao}>
                                {formatCount(s.orders_em_aberto)} em aberto
                              </span>
                            )}
                          </td>
                          {/* Sem pedido, "—" em vez de uma data inventada: a coluna fala de um fato que não aconteceu. */}
                          <td>
                            {s.ultimo_pedido_em === null ? (
                              <span className="sb-rep-mudo">—</span>
                            ) : (
                              <span className="sb-forn-quando" title={formatDateTime(s.ultimo_pedido_em)}>
                                <b>{idadeRelativa(s.ultimo_pedido_em, agora)}</b>
                                <small>{formatDateTime(s.ultimo_pedido_em)}</small>
                              </span>
                            )}
                          </td>
                          {/*
                            Custo ausente não vira zero (D-254/D-258): NULO quando há
                            itens e nenhum tem custo, e a ressalva quando só alguns têm
                            (`docs/METRICS.md` 5C.2).
                          */}
                          <td className="sb-num">
                            {s.valor_pedido === null ? (
                              <span
                                className="sb-rep-mudo"
                                title="há itens, mas nenhum com custo — ausência não é zero"
                              >
                                sem custo
                              </span>
                            ) : (
                              <b className="sb-forn-num">{formatCurrency(s.valor_pedido)}</b>
                            )}
                            {s.itens_sem_custo > 0 && (
                              <small className="sb-forn-ressalva sb-forn-bloco">
                                {formatCount(s.itens_sem_custo)} item(ns) sem custo
                              </small>
                            )}
                          </td>
                          <td>
                            <span className="sb-status" style={s.is_active ? TOM.ok : TOM.neutro}>
                              {s.is_active ? "Ativo" : "Inativo"}
                            </span>
                          </td>
                          <td className="sb-forn-acoes">
                            {/* A gaveta do frame: resumo aqui, tela cheia no nome. */}
                            <InspecaoFornecedor organizationId={organizationId} supplierId={s.id} nome={s.name} />
                            {podeEditar && s.is_active && (
                              <Link
                                className="sb-forn-acao"
                                href={`/compras/novo?fornecedor=${s.id}`}
                                title={`Novo pedido de compra para ${s.name}`}
                                aria-label={`Novo pedido de compra para ${s.name}`}
                              >
                                <Icone nome="carrinho" tamanho={15} />
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
        </>
      )}
    </Shell>
  );
}
