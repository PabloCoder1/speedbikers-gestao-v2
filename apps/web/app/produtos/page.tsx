import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { AcessoRestrito } from "../../components/acesso-restrito";
import { FilterMenu } from "../../components/filter-menu";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../components/estado-da-tela";
import { PageTitle } from "../../components/page-title";
import { Shell } from "../../components/shell";
import { TOM, type Tom } from "../../components/tone";
import { FormularioFiltro } from "../../components/formulario-filtro";
import { LinkDeFiltro } from "../../components/link-de-filtro";
import {
  DEFAULT_PAGE_SIZE,
  ORDENS,
  PRESENCAS,
  PRESENCAS_SEM_SHOPEE,
  SEM_CATEGORIA,
  SEM_MARCA,
  buildCurationHref,
  filtrosAtivos,
  presencaPorMarketplace,
  resolveCurationFilters,
  toCurationRpcArgs,
  toOverviewRpcArgs,
  type CurationFilters,
  type EstadoChave,
  type OrdemChave,
  type PresencaChave,
  type SinalChave,
  type SituacaoChave,
  type TipoChave,
} from "../../lib/curation-filters";
import { PAGE_SIZES } from "../../lib/filters";
import { formatCount, formatDay } from "../../lib/format";
import {
  contagemDaPresenca,
  lerVisaoProdutos,
  linhaDoLegado,
  opcoesDeLista,
  type Contagem,
  type ContagemPresenca,
  type LinhaCuradoriaLegado,
  type LinhaProduto,
  type VisaoProdutos,
} from "../../lib/products-overview";
import { currentMembership } from "../../lib/request-membership";
import { mesmaUrl } from "../../lib/mesma-url";
import { createClient } from "../../lib/supabase/server";

import { CurationTable } from "./curation-table";

export const metadata = { title: "Produtos — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de /compras.
export const dynamic = "force-dynamic";

/**
 * Produtos — o catálogo e a curadoria dele (D-133, refeita em D-373).
 *
 * Até D-373 a tela era só a FILA DE CURADORIA: duas decisões que só uma pessoa
 * toma (estoque virtual, D-127; marca do fornecedor, D-129), cinco menus em
 * fila e uma tabela de dez colunas. O dono pediu uma tela "bonita, rápida e com
 * mais opções/categorias". O que mudou:
 *
 * - **uma leitura** (`get_products_overview`) com a página, o resumo do
 *   catálogo e as contagens de cada eixo — no lugar de duas RPCs;
 * - **cartões de atalho** para o que pede ação: não classificados, sem marca, a
 *   revisar, ativos sem anúncio, ativos sem venda, em encerramento;
 * - **coluna de filtros com contagem**: estado, sinal do ERP, categoria (a do
 *   UpSeller), marca do fornecedor (as marcas de verdade, não só "sem marca"),
 *   tipo, situação, anúncios e vendas. As contagens são facetadas: cada eixo
 *   conta com os OUTROS filtros aplicados;
 * - a tela abre no catálogo inteiro; a fila de curadoria é o primeiro cartão.
 *
 * O que NÃO mudou: todo recorte vive na URL (D-133), a escrita passa pela
 * conferência que diz a consequência, a sugestão nunca se aplica sozinha, e a
 * origem fiscal continua fora (D-129/D-139).
 *
 * **Sem a migration no banco** (a web chega antes), a função nova responde
 * PGRST202 e a tela cai nas RPCs de sempre, sem cartões nem contagens.
 *
 * **A Shopee (D-454, sobre D-445/C-56).** Com loja Shopee live, anúncio e
 * venda olham os dois marketplaces: os filtros ganham "só no ML", "só na
 * Shopee" e "nos dois", os cartões de "sem anúncio/venda" passam a dizer "em
 * nenhum marketplace" (com o número só do ML ao lado), e a coluna de giro
 * mostra cada marketplace na sua linha, sem total — o banco não o devolve.
 * Sem loja live (ou antes da migration de D-445), a tela é a de antes.
 */

const ROTULO_ESTADO: Record<EstadoChave, string> = {
  pendente: "Não classificados",
  virtual: "Estoque virtual",
  fisico: "Estoque físico",
  todos: "Todos",
};

const ROTULO_SINAL: Record<SinalChave, string> = {
  sentinela: "Parece sentinela",
  "sem-sinal": "Não parece sentinela",
  "sem-retrato": "Sem retrato do ERP",
  divergente: "Divergentes",
};

const ROTULO_ORDEM: Record<OrdemChave, string> = {
  curadoria: "Fila de curadoria",
  atualizado: "Atualizados primeiro",
  criado: "Criados primeiro",
};

const ROTULO_TIPO: Record<TipoChave, string> = { produto: "Produtos", kit: "Kits" };
const ROTULO_SITUACAO: Record<SituacaoChave, string> = {
  ativo: "Ativos",
  encerrando: "Encerrando estoque",
  inativo: "Inativos no ERP",
};
// Os rótulos viram chip fora do grupo: cada um diz o eixo ("Anúncio só na
// Shopee" e "Vendeu só na Shopee" não podem virar o mesmo "Só na Shopee").
const ROTULO_ANUNCIOS: Record<PresencaChave, string> = {
  com: "Com anúncio",
  sem: "Sem anúncio",
  "so-ml": "Anúncio só no ML",
  "so-shopee": "Anúncio só na Shopee",
  ambos: "Anúncio no ML e na Shopee",
};
const ROTULO_VENDAS: Record<PresencaChave, string> = {
  com: "Vendeu em 90 dias",
  sem: "Sem venda em 90 dias",
  "so-ml": "Vendeu só no ML",
  "so-shopee": "Vendeu só na Shopee",
  ambos: "Vendeu no ML e na Shopee",
};

/** As categorias e marcas à vista antes do "mais". */
const LIMITE_LISTA = 8;

/** O gerador não marca nulidade de `returns table` (ver `get_sku_curation_summary`). */
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

interface Opcao {
  readonly chave: string;
  readonly rotulo: string;
  readonly n: number | null;
  readonly href: string;
  readonly ativo: boolean;
}

function GrupoFiltro({
  titulo,
  opcoes,
  limpar,
  mais,
}: {
  titulo: string;
  opcoes: readonly Opcao[];
  /** Href que tira este eixo; ausente quando o eixo não está filtrando. */
  limpar?: string;
  mais?: readonly Opcao[];
}): ReactNode {
  const item = (o: Opcao): ReactNode => (
    <li key={o.chave}>
      <Link
        href={o.href}
        className={o.ativo ? "sb-prod-opcao sb-prod-opcao-ativa" : "sb-prod-opcao"}
        aria-current={o.ativo ? "true" : undefined}
      >
        <span>{o.rotulo}</span>
        {o.n !== null && <em>{formatCount(o.n)}</em>}
      </Link>
    </li>
  );

  return (
    <div className="sb-prod-grupo" role="group" aria-label={titulo}>
      <div className="sb-prod-grupo-topo">
        <span>{titulo}</span>
        {limpar !== undefined && (
          <Link href={limpar} className="sb-prod-grupo-limpar" aria-label={`Limpar ${titulo}`}>
            limpar
          </Link>
        )}
      </div>
      <ul>{opcoes.map(item)}</ul>
      {mais !== undefined && mais.length > 0 && (
        <details className="sb-prod-mais">
          <summary>Mais {formatCount(mais.length)}</summary>
          <ul>{mais.map(item)}</ul>
        </details>
      )}
    </div>
  );
}

function opcoesDe(
  lista: readonly Contagem[],
  ativo: string | null,
  sem: string,
  rotuloSem: string,
  href: (valor: string) => string,
): { principais: Opcao[]; demais: Opcao[] } {
  const { principais, demais } = opcoesDeLista(lista, ativo, sem, LIMITE_LISTA);
  const converter = (c: Contagem): Opcao => {
    const valor = c.valor ?? sem;

    return { chave: valor, rotulo: c.valor ?? rotuloSem, n: c.n, href: href(valor), ativo: ativo === valor };
  };

  return { principais: principais.map(converter), demais: demais.map(converter) };
}

/**
 * As opções de um eixo de presença (D-454). Com loja Shopee live, as cinco;
 * sem ela, as duas de antes — "só no ML" repetiria o "com" e as outras duas
 * estariam sempre vazias. Um recorte por marketplace que chegou pela URL
 * continua à vista, para poder ser tirado ali mesmo.
 */
function opcoesDePresenca(
  comShopee: boolean,
  contagens: ContagemPresenca,
  rotulos: Record<PresencaChave, string>,
  ativo: PresencaChave | null,
  href: (k: PresencaChave | null) => string,
): Opcao[] {
  const chaves: readonly PresencaChave[] = comShopee
    ? (Object.keys(PRESENCAS) as PresencaChave[])
    : [...PRESENCAS_SEM_SHOPEE, ...(ativo !== null && presencaPorMarketplace(ativo) ? [ativo] : [])];

  return chaves.map((k) => ({
    chave: k,
    rotulo: rotulos[k],
    n: contagemDaPresenca(contagens, k),
    href: href(ativo === k ? null : k),
    ativo: ativo === k,
  }));
}

/** Os filtros ativos como chips que se tiram com um clique. */
function chipsAtivos(atual: CurationFilters): { rotulo: string; href: string }[] {
  const chips: { rotulo: string; href: string }[] = [];
  const tirar = (override: Partial<CurationFilters>) => buildCurationHref(atual, override);

  if (atual.estado !== "todos") chips.push({ rotulo: ROTULO_ESTADO[atual.estado], href: tirar({ estado: "todos" }) });
  if (atual.sinal !== null) chips.push({ rotulo: ROTULO_SINAL[atual.sinal], href: tirar({ sinal: null }) });
  if (atual.categoria !== null) {
    chips.push({
      rotulo: `Categoria: ${atual.categoria === SEM_CATEGORIA ? "sem categoria" : atual.categoria}`,
      href: tirar({ categoria: null }),
    });
  }
  if (atual.marca !== null) {
    chips.push({ rotulo: `Marca: ${atual.marca === SEM_MARCA ? "sem marca" : atual.marca}`, href: tirar({ marca: null }) });
  }
  if (atual.tipo !== null) chips.push({ rotulo: ROTULO_TIPO[atual.tipo], href: tirar({ tipo: null }) });
  if (atual.situacao !== null) chips.push({ rotulo: ROTULO_SITUACAO[atual.situacao], href: tirar({ situacao: null }) });
  if (atual.anuncios !== null) chips.push({ rotulo: ROTULO_ANUNCIOS[atual.anuncios], href: tirar({ anuncios: null }) });
  if (atual.vendas !== null) chips.push({ rotulo: ROTULO_VENDAS[atual.vendas], href: tirar({ vendas: null }) });
  if (atual.busca !== "") chips.push({ rotulo: `Busca: "${atual.busca}"`, href: tirar({ busca: "" }) });

  return chips;
}

/** Um recorte "limpo" com só estes eixos — o destino dos cartões de atalho. */
function atalho(atual: CurationFilters, override: Partial<CurationFilters>): string {
  return buildCurationHref(
    {
      ...atual,
      estado: "todos",
      sinal: null,
      marca: null,
      categoria: null,
      tipo: null,
      situacao: null,
      anuncios: null,
      vendas: null,
      busca: "",
    },
    override,
  );
}

/** A tela inteira quando não há catálogo para mostrar (D-472): o que falhou, a mensagem à parte e "Tentar de novo". */
function Erro({
  titulo,
  detalhe,
  tentarDeNovo,
  tipo = "erro",
}: {
  titulo: string;
  detalhe?: string;
  tentarDeNovo?: string;
  tipo?: "erro" | "permissao";
}): ReactNode {
  return (
    <Shell>
      <PageTitle eyebrow="CATÁLOGO / PRODUTOS" title="Produtos" compacto />
      <EstadoDaTela
        tipo={tipo}
        titulo={titulo}
        detalhe={detalhe}
        acao={tentarDeNovo === undefined ? undefined : { href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
      />
    </Shell>
  );
}

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const atual = resolveCurationFilters(params);
  const supabase = await createClient();

  const membership = await currentMembership();
  const organizationId = membership.organizationId;

  if (membership.error !== null) {
    // Distinto de "sem organização": falha de leitura transitória (D-067).
    return (
      <Erro
        titulo="Não foi possível confirmar sua organização"
        detalhe={membership.error.message}
        tentarDeNovo={mesmaUrl("/produtos", params)}
      />
    );
  }

  if (organizationId === null) {
    return <Erro tipo="permissao" titulo="Sua conta não está associada a nenhuma organização." />;
  }

  // Duas leituras numa ida (D-185): a visão da tela e o resumo por marca, que
  // alimenta a lista de marcas conhecidas do campo "Aplicar marca" — ela precisa
  // de TODAS as marcas, e a contagem facetada só traz as do recorte.
  const [leitura, resumoMarcas] = await Promise.all([
    supabase.rpc("get_products_overview", { p_organization_id: organizationId, ...toOverviewRpcArgs(atual) }),
    supabase.rpc("get_sku_curation_summary", { p_organization_id: organizationId }),
  ]);

  const semPermissao = (m: string | undefined) => m?.includes("sem permissao") === true;

  if (semPermissao(leitura.error?.message) || semPermissao(resumoMarcas.error?.message)) {
    return <AcessoRestrito titulo="Produtos" papel="ADMIN ou GESTOR" />;
  }

  let visao: VisaoProdutos | null = null;
  let linhas: readonly LinhaProduto[];
  let total: number;

  if (leitura.error === null) {
    visao = lerVisaoProdutos(leitura.data);

    if (visao === null) {
      return (
        <Erro
          titulo="Não foi possível carregar o catálogo"
          detalhe="a leitura voltou fora do contrato esperado"
          tentarDeNovo={mesmaUrl("/produtos", params)}
        />
      );
    }

    linhas = visao.linhas;
    total = visao.total;
  } else if (leitura.error.code === "PGRST202") {
    // A função de D-373 ainda não existe neste banco: a fila de sempre, com os
    // filtros que ela conhece. Os eixos novos são ignorados nela.
    const legado = await supabase.rpc("get_sku_curation", {
      p_organization_id: organizationId,
      ...toCurationRpcArgs(atual),
    });

    if (legado.error !== null) {
      return (
        <Erro titulo="Não foi possível carregar o catálogo" detalhe={legado.error.message} tentarDeNovo={mesmaUrl("/produtos", params)} />
      );
    }

    const rows = legado.data as unknown as LinhaCuradoriaLegado[];

    linhas = rows.map(linhaDoLegado);
    total = rows[0]?.total_count ?? 0;
  } else {
    return (
      <Erro titulo="Não foi possível carregar o catálogo" detalhe={leitura.error.message} tentarDeNovo={mesmaUrl("/produtos", params)} />
    );
  }

  const porMarca = ((resumoMarcas.data ?? []) as SummaryRow[]).filter((l) => !l.is_total);
  const marcasConhecidas = porMarca
    .map((l) => l.supplier_brand)
    .filter((m): m is string => m !== null)
    .sort((a, b) => a.localeCompare(b));
  const totalResumo = ((resumoMarcas.data ?? []) as SummaryRow[]).find((l) => l.is_total) ?? null;

  const totalPaginas = total === 0 ? 0 : Math.ceil(total / atual.tamanho);
  const chips = chipsAtivos(atual);
  const retrato = visao?.resumo.retrato_em ?? totalResumo?.snapshot_captured_at ?? null;
  const f = visao?.facetas ?? null;
  const r = visao?.resumo ?? null;
  // D-454: só a leitura de D-445 sabe se há loja Shopee live; a antiga e a de
  // antes de D-373 respondem como sempre.
  const comShopee = r?.tem_shopee === true;
  // Recorte por marketplace sobre a função anterior a D-445: ela não o
  // conhece e devolve a lista vazia, sem erro. Dizer, em vez de mostrar "0".
  const recorteSemLeitura =
    visao !== null &&
    r?.tem_shopee === null &&
    (presencaPorMarketplace(atual.anuncios) || presencaPorMarketplace(atual.vendas));

  const opcoesEixo = <K extends string>(
    chaves: readonly K[],
    rotulos: Record<K, string>,
    contagens: Record<string, number> | null,
    chaveContagem: (k: K) => string,
    ativo: K | null,
    href: (k: K | null) => string,
  ): Opcao[] =>
    chaves.map((k) => ({
      chave: k,
      rotulo: rotulos[k],
      n: contagens === null ? null : (contagens[chaveContagem(k)] ?? 0),
      href: href(ativo === k ? null : k),
      ativo: ativo === k,
    }));

  const cartoes: { rotulo: string; n: number | null; nota: string; href: string; ativo: boolean; tom: Tom | "primario" }[] =
    r === null
      ? []
      : [
          {
            rotulo: "Catálogo",
            n: r.total,
            nota: retrato === null ? "sem retrato do ERP" : `retrato do ERP de ${formatDay(retrato)}`,
            href: "/produtos",
            ativo: filtrosAtivos(atual) === 0,
            tom: "primario",
          },
          {
            rotulo: "Não classificados",
            n: r.nunca_classificados,
            nota: "estoque virtual ou físico?",
            href: atalho(atual, { estado: "pendente" }),
            ativo: atual.estado === "pendente" && filtrosAtivos(atual) === 1,
            tom: "atencao",
          },
          {
            rotulo: "Sem marca",
            n: r.sem_marca,
            nota: "marca do fornecedor a preencher",
            href: atalho(atual, { marca: SEM_MARCA }),
            ativo: atual.marca === SEM_MARCA && filtrosAtivos(atual) === 1,
            tom: "atencao",
          },
          {
            rotulo: "A revisar",
            n: r.a_revisar,
            nota: "decisão contra o sinal do ERP",
            href: atalho(atual, { sinal: "divergente" }),
            ativo: atual.sinal === "divergente" && filtrosAtivos(atual) === 1,
            tom: "perigo",
          },
          {
            rotulo: "Ativos sem anúncio",
            n: r.sem_anuncio,
            // Com Shopee, o número é "em nenhum marketplace" (D-445) e o só do
            // ML, o cartão de antes, vai na nota — os dois vêm do banco.
            nota:
              comShopee && r.sem_anuncio_ml !== null
                ? `em nenhum marketplace · ${formatCount(r.sem_anuncio_ml)} sem anúncio no ML`
                : "nenhum anúncio vende o SKU",
            href: atalho(atual, { anuncios: "sem", situacao: "ativo" }),
            ativo: atual.anuncios === "sem" && atual.situacao === "ativo" && filtrosAtivos(atual) === 2,
            tom: "info",
          },
          {
            rotulo: "Ativos sem venda",
            n: r.sem_venda_90d,
            nota:
              comShopee && r.sem_venda_90d_ml !== null
                ? `nada em 90 dias, em nenhum marketplace · ${formatCount(r.sem_venda_90d_ml)} sem venda no ML`
                : "nenhuma unidade em 90 dias",
            href: atalho(atual, { vendas: "sem", situacao: "ativo" }),
            ativo: atual.vendas === "sem" && atual.situacao === "ativo" && filtrosAtivos(atual) === 2,
            tom: "info",
          },
          {
            rotulo: "Encerrando",
            n: r.encerrando,
            nota: "\"estoque inativo\" no ERP",
            href: atalho(atual, { situacao: "encerrando" }),
            ativo: atual.situacao === "encerrando" && filtrosAtivos(atual) === 1,
            tom: "neutro",
          },
        ];

  const categorias =
    f === null
      ? null
      : opcoesDe(f.categorias, atual.categoria, SEM_CATEGORIA, "Sem categoria", (v) =>
          buildCurationHref(atual, { categoria: atual.categoria === v ? null : v }),
        );
  const marcas =
    f === null
      ? null
      : opcoesDe(f.marcas, atual.marca, SEM_MARCA, "Sem marca", (v) =>
          buildCurationHref(atual, { marca: atual.marca === v ? null : v }),
        );

  return (
    <Shell>
      <PageTitle
        eyebrow="CATÁLOGO / PRODUTOS"
        title="Produtos"
        subtitle="O catálogo do ERP e o que falta decidir nele: estoque virtual, marca do fornecedor, produto sem anúncio ou sem venda. A sugestão nunca se aplica sozinha."
        aside={
          <>
            <FormularioFiltro action="/produtos" className="sb-rep-busca">
              {/*
                O GET manda só o que está no formulário: sem estes campos, buscar
                descartaria o recorte inteiro (D-136).
              */}
              {atual.estado !== "todos" && <input type="hidden" name="estado" value={atual.estado} />}
              {atual.sinal !== null && <input type="hidden" name="sinal" value={atual.sinal} />}
              {atual.marca !== null && <input type="hidden" name="marca" value={atual.marca} />}
              {atual.categoria !== null && <input type="hidden" name="categoria" value={atual.categoria} />}
              {atual.tipo !== null && <input type="hidden" name="tipo" value={atual.tipo} />}
              {atual.situacao !== null && <input type="hidden" name="situacao" value={atual.situacao} />}
              {atual.anuncios !== null && <input type="hidden" name="anuncios" value={atual.anuncios} />}
              {atual.vendas !== null && <input type="hidden" name="vendas" value={atual.vendas} />}
              {atual.ordem !== "curadoria" && <input type="hidden" name="ordem" value={atual.ordem} />}
              {atual.tamanho !== DEFAULT_PAGE_SIZE && <input type="hidden" name="tamanho" value={String(atual.tamanho)} />}
              <input
                type="search"
                name="busca"
                className="sb-input"
                defaultValue={atual.busca}
                placeholder="SKU ou título"
                aria-label="Buscar SKU ou título"
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </FormularioFiltro>
          </>
        }
      />

      {cartoes.length > 0 && (
        <nav className="sb-prod-atalhos" aria-label="Atalhos do catálogo">
          {cartoes.map((c) => (
            <Link
              key={c.rotulo}
              href={c.href}
              className={c.ativo ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
              style={{ "--sb-rep-tom": c.tom === "primario" ? "var(--sb-primary)" : TOM[c.tom].color } as CSSProperties}
              aria-current={c.ativo ? "true" : undefined}
            >
              <span className="sb-rep-estado-rotulo">{c.rotulo}</span>
              <strong>{c.n === null ? "—" : formatCount(c.n)}</strong>
              <small>{c.nota}</small>
            </Link>
          ))}
        </nav>
      )}

      <div className={f === null ? "sb-prod-layout sb-prod-layout-sem-filtros" : "sb-prod-layout"}>
        {f !== null && categorias !== null && marcas !== null && (
          <aside className="sb-prod-filtros" aria-label="Filtros do catálogo">
            <div className="sb-prod-filtros-topo">
              <b>Filtros</b>
              {filtrosAtivos(atual) > 0 && (
                <Link href={atalho(atual, {})} className="sb-prod-grupo-limpar">
                  limpar tudo
                </Link>
              )}
            </div>

            <GrupoFiltro
              titulo="Estoque"
              opcoes={opcoesEixo(
                ["pendente", "virtual", "fisico"] as const,
                ROTULO_ESTADO,
                f.estado,
                (k) => k,
                atual.estado === "todos" ? null : atual.estado,
                (k) => buildCurationHref(atual, { estado: k ?? "todos" }),
              )}
              {...(atual.estado === "todos" ? {} : { limpar: buildCurationHref(atual, { estado: "todos" }) })}
            />

            <GrupoFiltro
              titulo="Categoria"
              opcoes={categorias.principais}
              mais={categorias.demais}
              {...(atual.categoria === null ? {} : { limpar: buildCurationHref(atual, { categoria: null }) })}
            />

            <GrupoFiltro
              titulo="Marca do fornecedor"
              opcoes={marcas.principais}
              mais={marcas.demais}
              {...(atual.marca === null ? {} : { limpar: buildCurationHref(atual, { marca: null }) })}
            />

            <GrupoFiltro
              titulo="Situação"
              opcoes={opcoesEixo(
                ["ativo", "encerrando", "inativo"] as const,
                ROTULO_SITUACAO,
                f.situacao,
                (k) => k,
                atual.situacao,
                (k) => buildCurationHref(atual, { situacao: k }),
              )}
              {...(atual.situacao === null ? {} : { limpar: buildCurationHref(atual, { situacao: null }) })}
            />

            <GrupoFiltro
              titulo="Anúncios"
              opcoes={opcoesDePresenca(comShopee, f.anuncios, ROTULO_ANUNCIOS, atual.anuncios, (k) =>
                buildCurationHref(atual, { anuncios: k }),
              )}
              {...(atual.anuncios === null ? {} : { limpar: buildCurationHref(atual, { anuncios: null }) })}
            />

            <GrupoFiltro
              titulo="Vendas"
              opcoes={opcoesDePresenca(comShopee, f.vendas, ROTULO_VENDAS, atual.vendas, (k) =>
                buildCurationHref(atual, { vendas: k }),
              )}
              {...(atual.vendas === null ? {} : { limpar: buildCurationHref(atual, { vendas: null }) })}
            />

            <GrupoFiltro
              titulo="Tipo"
              opcoes={opcoesEixo(
                ["produto", "kit"] as const,
                ROTULO_TIPO,
                f.tipo,
                (k) => k,
                atual.tipo,
                (k) => buildCurationHref(atual, { tipo: k }),
              )}
              {...(atual.tipo === null ? {} : { limpar: buildCurationHref(atual, { tipo: null }) })}
            />

            <GrupoFiltro
              titulo="Sinal do ERP"
              opcoes={opcoesEixo(
                ["sentinela", "sem-sinal", "sem-retrato", "divergente"] as const,
                ROTULO_SINAL,
                f.sinal,
                (k) => k.replace("-", "_"),
                atual.sinal,
                (k) => buildCurationHref(atual, { sinal: k }),
              )}
              {...(atual.sinal === null ? {} : { limpar: buildCurationHref(atual, { sinal: null }) })}
            />
          </aside>
        )}

        <div className="sb-prod-principal">
          <div className="sb-prod-barra">
            <div className="sb-prod-chips">
              <span className="sb-prod-contagem">
                {formatCount(total)} {total === 1 ? "produto" : "produtos"}
              </span>
              {chips.map((c) => (
                <Link key={c.rotulo} href={c.href} className="sb-prod-chip" aria-label={`Tirar filtro ${c.rotulo}`}>
                  {c.rotulo}
                  <span aria-hidden="true">×</span>
                </Link>
              ))}
            </div>
            <div className="sb-prod-ordem">
              {/*
                A ordem e o tamanho da página (D-315): recorte do que se olha,
                escrito na URL, e trocar qualquer um volta para a página 1.
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
            </div>
          </div>

          {recorteSemLeitura && (
            <p role="status" className="sb-note sb-note-atencao" style={{ margin: 0 }}>
              O recorte por marketplace (só no ML, só na Shopee, nos dois) ainda não existe neste banco, e a lista sai
              vazia. Tire o filtro de anúncio ou de venda para ver o catálogo.
            </p>
          )}

          <CurationTable
            organizationId={organizationId}
            rows={linhas}
            marcasConhecidas={marcasConhecidas}
            cabecalho={[
              `${formatCount(linhas.length)} de ${formatCount(total)} neste recorte`,
              retrato === null
                ? "sem retrato do ERP — sem retrato não há sugestão"
                : `retrato do ERP de ${formatDay(retrato)}`,
              ...(comShopee ? ["anúncios e vendas do ML e da Shopee, sem a loja de teste"] : []),
            ].join(" · ")}
          />

          {totalPaginas > 1 && (
            <nav className="sb-prod-paginas" aria-label="Páginas">
              {atual.page > 1 ? (
                <LinkDeFiltro className="sb-button" href={buildCurationHref(atual, { page: atual.page - 1 })}>
                  ‹ Anterior
                </LinkDeFiltro>
              ) : (
                <span />
              )}
              <span>
                Página {formatCount(atual.page)} de {formatCount(totalPaginas)}
              </span>
              {atual.page < totalPaginas ? (
                <LinkDeFiltro className="sb-button" href={buildCurationHref(atual, { page: atual.page + 1 })}>
                  Próxima ›
                </LinkDeFiltro>
              ) : (
                <span />
              )}
            </nav>
          )}

          <p className="sb-rep-rodape">
            {formatCount(r?.virtuais ?? totalResumo?.virtual_marked ?? 0)} marcados como estoque virtual têm a cobertura
            em branco de propósito em <Link href="/reposicao">Cobertura e reposição</Link>. Categoria é a do UpSeller;
            marca do fornecedor é decisão de curadoria.
          </p>
        </div>
      </div>
    </Shell>
  );
}
