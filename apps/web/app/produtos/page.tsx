import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

import { CurationTable, type CurationRow } from "./curation-table";
import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { PAGE_SIZES } from "../../lib/filters";
import {
  DEFAULT_PAGE_SIZE,
  ORDENS,
  SEM_MARCA,
  buildCurationHref,
  resolveCurationFilters,
  toCurationRpcArgs,
  type EstadoChave,
  type OrdemChave,
  type SinalChave,
} from "../../lib/curation-filters";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Produtos — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de /compras.
export const dynamic = "force-dynamic";

/**
 * Curadoria do catálogo (D-133).
 *
 * Existe porque duas colunas de `skus` só podem ser preenchidas por gente, e
 * marcar 2.306 SKUs um a um não é realista:
 *
 * - `stock_is_virtual` (D-127) — o saldo do ERP é sentinela, não contagem, e
 *   não há regra derivável (a hipótese "base menos vendas" foi testada e
 *   reprovada, correlação 0,291).
 * - `supplier_brand` (D-129) — `skus.brand` guarda a CATEGORIA do UpSeller
 *   (66% em 'MANETE') e o importador a sobrescreve a cada planilha.
 *
 * A tela SUGERE pela assinatura sentinela e nunca aplica sozinha: o operador
 * confirma num painel que diz a CONSEQUÊNCIA, não só a contagem.
 *
 * Todo o filtro vive na URL, nunca em estado React — só assim os Filtros
 * Salvos continuam funcionando e o link de ida de `/cobertura` chega com o
 * recorte certo.
 */

const ROTULO_ESTADO: Record<EstadoChave, string> = {
  pendente: "Não classificados",
  virtual: "Virtuais",
  fisico: "Físicos",
  todos: "Todos os estados",
};

const ROTULO_SINAL: Record<SinalChave, string> = {
  sentinela: "Parece sentinela",
  "sem-sinal": "Não parece sentinela",
  "sem-retrato": "Sem retrato",
  divergente: "Divergentes",
};

/**
 * A ordem, com o nome do que ela SERVE — não o nome da coluna (D-315).
 *
 * "Fila de curadoria" diz por que ela é o padrão: ela põe na frente o que
 * precisa de decisão. As duas datas são as do UpSeller, para achar o que foi
 * mexido agora.
 */
const ROTULO_ORDEM: Record<OrdemChave, string> = {
  curadoria: "Fila de curadoria",
  atualizado: "Atualizados primeiro",
  criado: "Criados primeiro",
};


/**
 * O gerador de tipos NÃO marca nulidade de `returns table` — declara tudo
 * como não-nulo. Aqui isso importa de verdade: `supplier_brand` é NULO na
 * linha dos SKUs sem marca, e a linha TOTAL do `grouping sets` também vem com
 * ela nula. Sem esta interface, o código que distingue as duas não compila —
 * e, pior, o lint acusaria a comparação como "sem sobreposição", que é
 * exatamente o contrário do que o dado faz. Mesmo molde de `CoverageRow`.
 */
interface SummaryRow {
  is_total: boolean;
  supplier_brand: string | null;
  total: number;
  unclassified: number;
  virtual_marked: number;
  with_signature: number;
  diverging: number;
  snapshot_captured_at: string | null;
}

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;

  const atual = resolveCurationFilters(params);

  const supabase = await createClient();

  // `.limit(1)` e não `.maybeSingle()` sem filtro: numa organização com dois
  // membros o `maybeSingle` estoura PGRST116 e a tela inteira morre — o
  // defeito que D-119 mediu e corrigiu.
  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (membership.error !== null) {
    // Distinto de "sem organização": aquela mensagem sugere problema de
    // cadastro; isto é falha de leitura transitória (D-067, Nível 3).
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Produtos</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível confirmar sua organização: {membership.error.message}
        </p>
      </Shell>
    );
  }

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Produtos</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const semMarca = atual.marca === SEM_MARCA;

  const [fila, resumo] = await Promise.all([
    supabase.rpc("get_sku_curation", {
      p_organization_id: organizationId,
      // Recorte, tamanho e ordem saem todos de `toCurationRpcArgs` — o único
      // lugar que traduz o vocabulário da URL para o do banco (D-315).
      ...toCurationRpcArgs(atual),
    }),
    supabase.rpc("get_sku_curation_summary", { p_organization_id: organizationId }),
  ]);

  const error = fila.error ?? resumo.error;

  if (error !== null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Produtos</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar a curadoria: {error.message}
        </p>
      </Shell>
    );
  }

  const rows = (fila.data ?? []) as CurationRow[];
  const totalFiltrado = rows[0]?.total_count ?? 0;

  const linhas = (resumo.data ?? []) as SummaryRow[];
  const total = linhas.find((l) => l.is_total) ?? null;
  const porMarca = linhas.filter((l) => !l.is_total);
  const marcasConhecidas = porMarca
    .map((l) => l.supplier_brand)
    .filter((m): m is string => m !== null)
    .sort((a, b) => a.localeCompare(b));

  const semMarcaTotal = porMarca.find((l) => l.supplier_brand === null)?.total ?? 0;
  const retrato = total?.snapshot_captured_at ?? null;

  const rotuloEstado = ROTULO_ESTADO[atual.estado];
  const rotuloSinal = atual.sinal === null ? "Qualquer sinal" : ROTULO_SINAL[atual.sinal];

  // A última página do recorte, para "Página X de Y" — o `1/65` do UpSeller.
  const totalPaginas = totalFiltrado === 0 ? 0 : Math.ceil(totalFiltrado / atual.tamanho);

  return (
    <Shell>
      <PageTitle
        eyebrow="INTELIGÊNCIA / CURADORIA"
        title="Curadoria de produtos"
        // As duas decisoes que so uma pessoa toma: estoque virtual (o saldo do
        // ERP e sentinela, nao contagem — D-127) e marca do fornecedor (a
        // coluna Categorias do UpSeller nao e marca — D-129). A sugestao e
        // medida e NUNCA aplicada sozinha. A explicacao longa saiu do subtitulo
        // (o frame tem uma linha) e mora no `title` das colunas.
        subtitle="Estoque virtual e marca do fornecedor — as duas decisões que só uma pessoa toma; a sugestão nunca se aplica sozinha."
        aside={
          <>
            {/*
              Os filtros viraram a barra de menus do Figma, como em `/vendas`.
              Todo o recorte continua na URL, nunca em estado React — só assim os
              Filtros Salvos continuam funcionando e o link de ida de
              `/cobertura` chega com o recorte certo.
            */}
            <FilterMenu
              rotulo={rotuloEstado}
              opcoes={(["pendente", "virtual", "fisico", "todos"] as EstadoChave[]).map((chave) => ({
                href: buildCurationHref(atual, { estado: chave }),
                ativo: atual.estado === chave,
                label: ROTULO_ESTADO[chave],
              }))}
            />

            <FilterMenu
              rotulo={rotuloSinal}
              opcoes={[
                {
                  href: buildCurationHref(atual, { sinal: null }),
                  ativo: atual.sinal === null,
                  label: "Qualquer sinal",
                },
                ...(["sentinela", "sem-sinal", "sem-retrato", "divergente"] as SinalChave[]).map((chave) => ({
                  href: buildCurationHref(atual, { sinal: chave }),
                  ativo: atual.sinal === chave,
                  label: ROTULO_SINAL[chave],
                })),
              ]}
            />

            <FilterMenu
              rotulo={semMarca ? "Sem marca" : "Todas as marcas"}
              opcoes={[
                { href: buildCurationHref(atual, { marca: null }), ativo: !semMarca, label: "Todas as marcas" },
                { href: buildCurationHref(atual, { marca: SEM_MARCA }), ativo: semMarca, label: "Sem marca" },
              ]}
            />

            {/*
              A ORDEM e o TAMANHO DA PAGINA, as duas opcoes do UpSeller (D-315).
              Moram na barra junto dos filtros porque sao a mesma coisa que eles:
              recorte do que se olha, escrito na URL. Trocar qualquer um volta
              para a pagina 1 -- `buildCurationHref` faz isso sozinho, e sem ele
              ir de 300 para 20 na pagina 4 cairia fora do conjunto.
            */}
            <FilterMenu
              rotulo={ROTULO_ORDEM[atual.ordem]}
              opcoes={(Object.keys(ORDENS) as OrdemChave[]).map((chave) => ({
                href: buildCurationHref(atual, { ordem: chave }),
                ativo: atual.ordem === chave,
                label: ROTULO_ORDEM[chave],
              }))}
            />

            <FilterMenu
              rotulo={`${String(atual.tamanho)} por página`}
              opcoes={PAGE_SIZES.map((tamanho) => ({
                href: buildCurationHref(atual, { tamanho }),
                ativo: atual.tamanho === tamanho,
                label: `${String(tamanho)} por página`,
              }))}
            />

            <form method="get" action="/produtos" style={{ display: "flex", gap: "0.375rem" }}>
              {/*
                O GET manda so o que esta no formulario: sem estes campos,
                buscar descartaria estado, sinal, marca, ordem e tamanho.
              */}
              {atual.estado !== "pendente" && <input type="hidden" name="estado" value={atual.estado} />}
              {atual.sinal !== null && <input type="hidden" name="sinal" value={atual.sinal} />}
              {atual.marca !== null && <input type="hidden" name="marca" value={atual.marca} />}
              {atual.ordem !== "curadoria" && <input type="hidden" name="ordem" value={atual.ordem} />}
              {atual.tamanho !== DEFAULT_PAGE_SIZE && (
                <input type="hidden" name="tamanho" value={String(atual.tamanho)} />
              )}
              <input
                type="search"
                name="busca"
                className="sb-input"
                defaultValue={atual.busca}
                placeholder="SKU ou título"
                aria-label="Buscar SKU ou título"
                style={{ minWidth: "12rem" }}
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
          </>
        }
      />

      {/*
        Do cabecalho direto ao cartao, como o frame. A faixa de contadores que
        existia aqui era invencao da V3 (a auditoria de fidelidade a apontou):
        as contagens do retrato — nunca classificados, sem marca, a revisar —
        moram agora no cabecalho do cartao, onde o frame poe "N resultados".
        Elas NAO sao metricas catalogadas: sao estados do catalogo.
      */}
      <CurationTable
        organizationId={organizationId}
        rows={rows}
        marcasConhecidas={marcasConhecidas}
        cabecalho={[
          retrato === null
            ? "sem retrato do ERP — nenhuma planilha aplicada, e sem retrato não há sugestão"
            : `retrato do ERP de ${new Date(retrato).toLocaleDateString("pt-BR")}`,
          `${formatCount(rows.length)} de ${formatCount(totalFiltrado)} neste recorte`,
          `${formatCount(total?.unclassified ?? 0)} nunca classificados`,
          `${formatCount(semMarcaTotal)} sem marca`,
          `${formatCount(total?.diverging ?? 0)} a revisar`,
        ].join(" · ")}
      />

      <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
        {atual.page > 1 && (
          <>
            <a href={buildCurationHref(atual, { page: atual.page - 1 })}>Anterior</a>
            {" · "}
          </>
        )}
        {/* Onde se esta dentro do conjunto -- o `1/65` do UpSeller. Sem isto,
            "Proxima" e a unica pista de que ha mais alguma coisa. */}
        {totalPaginas > 1 && `Página ${formatCount(atual.page)} de ${formatCount(totalPaginas)} · `}
        {atual.page < totalPaginas && (
          <>
            <a href={buildCurationHref(atual, { page: atual.page + 1 })}>Próxima</a>
            {" · "}
          </>
        )}
        {formatCount(total?.virtual_marked ?? 0)} marcados como virtual têm a cobertura em branco de propósito em{" "}
        <a href="/reposicao">Cobertura e reposição</a>.
      </p>
    </Shell>
  );
}
