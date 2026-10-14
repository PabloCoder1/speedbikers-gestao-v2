/**
 * O MARKETPLACE como recorte das telas (D-431, etapa T1 da frente multicanal —
 * `docs/MULTICHANNEL_SCREENS.md` §4).
 *
 * Nesta etapa o marketplace escolhe ENTRE AS TELAS que já existem para cada
 * canal (`/vendas` e `/vendas/shopee`, `/anuncios` e `/anuncios/shopee`): ainda
 * não há número de dois canais somado em lugar nenhum — o consolidado nasce no
 * SQL (contrato C-53) e só então vira a opção "todos". Aqui mora o que a troca
 * precisa saber, e nada soma linha:
 *
 * - **quais marketplaces oferecer** — os que têm conta ou loja que a pessoa
 *   alcança, contadas no banco sob a RLS (`count`, nunca a lista). A lista não
 *   é uma constante da tela: quem só tem Mercado Livre não vê seletor nenhum, e
 *   a tela fica como sempre foi;
 * - **o que atravessa a troca** — só o que vale nos dois lados. Conta, marca,
 *   loja, situação e estado são de um canal e ficam para trás; o período passa
 *   (as duas telas de vendas usam o mesmo vocabulário, `./period`); a busca de
 *   anúncios passa, menos o código de anúncio do Mercado Livre.
 *
 * O parâmetro da URL, quando houver um, é `marketplace`, e não `canal`: em
 * `/atendimento` o `canal` já é o tipo de caso (pergunta, mensagem,
 * reclamação), e `support_cases.channel` e `sync_runs.channel` também existem.
 */

import type { FilterOption } from "../components/filter-menu";
import { buildFilterHref } from "./filters";
import { SHOPEE_LISTINGS_PATH } from "./shopee-listings";
import type { createClient } from "./supabase/server";

export type Marketplace = "ml" | "shopee";

/** A ordem do seletor. O rótulo é por código, como os demais enums de `./labels`. */
const ORDEM: readonly Marketplace[] = ["ml", "shopee"];

export const MARKETPLACE_ROTULO: Readonly<Record<Marketplace, string>> = {
  ml: "Mercado Livre",
  shopee: "Shopee",
};

/**
 * Quantas contas (ML) e lojas (Shopee) a pessoa alcança. `null` = a leitura
 * falhou ou a tabela ainda não existe (web publicada antes da migration).
 */
export type ContasPorMarketplace = Readonly<Record<Marketplace, number | null>>;

/**
 * Os marketplaces que o seletor oferece: os que têm pelo menos uma conta ou
 * loja visível, mais o ATIVO — a pessoa já está nele, e tirar a própria opção
 * a deixaria sem saber onde está. Leitura que falhou não vira opção: oferecer
 * um marketplace que não se conseguiu confirmar levaria a uma tela vazia.
 */
export function marketplacesVisiveis(contas: ContasPorMarketplace, ativo: Escopo): Marketplace[] {
  return ORDEM.filter((marketplace) => marketplace === ativo || (contas[marketplace] ?? 0) > 0);
}

/**
 * O recorte do seletor: um marketplace ou TODOS (D-440). "Todos" só existe
 * onde a tela tem um consolidado de verdade, somado no SQL (`/vendas`, sobre o
 * C-53) — a tela que não o oferece simplesmente não passa o destino.
 */
export type Escopo = Marketplace | "todos";

export const ROTULO_TODOS = "Todos os marketplaces";

/**
 * As opções do menu, ou `null` quando só há um marketplace: com um só não há
 * o que escolher, e a tela continua exatamente a de antes. "Todos" vem
 * primeiro — é o recorte mais largo —, e só com dois marketplaces visíveis.
 */
export function opcoesDeMarketplace(
  ativo: Escopo,
  visiveis: readonly Marketplace[],
  destinos: Readonly<Record<Marketplace, string>> & { readonly todos?: string },
): FilterOption[] | null {
  if (visiveis.length < 2) return null;

  const porMarketplace = visiveis.map((marketplace) => ({
    href: destinos[marketplace],
    ativo: marketplace === ativo,
    label: MARKETPLACE_ROTULO[marketplace],
  }));

  return destinos.todos === undefined
    ? porMarketplace
    : [{ href: destinos.todos, ativo: ativo === "todos", label: ROTULO_TODOS }, ...porMarketplace];
}

/** O código do anúncio do Mercado Livre — `MLB` e dígitos. Não existe na Shopee. */
const CODIGO_MLB = /^MLB-?\d+$/iu;

/**
 * A busca de anúncios que sobrevive à troca de marketplace. SKU e nome valem
 * nos dois lados — é justamente "este SKU na outra loja" que a troca serve
 * para responder. O código de anúncio do ML não existe na Shopee e fica para
 * trás. Na volta, a busca passa inteira: um número pode ser o item da Shopee,
 * mas também um SKU, e a tela do ML diz "nenhum anúncio" se não for.
 */
export function buscaCompativel(busca: string | null, destino: Marketplace): string | null {
  const texto = busca?.trim() ?? "";

  if (texto === "") return null;
  if (destino === "shopee" && CODIGO_MLB.test(texto)) return null;

  return texto;
}

/**
 * A lista de anúncios de um marketplace, com a busca que atravessa. Cada tela
 * tem o seu nome de parâmetro (`busca` no ML, `q` na Shopee); o resto do
 * recorte (conta, loja, estado, período) fica para trás — é de um canal só.
 */
export function hrefDosAnuncios(destino: Marketplace, busca: string | null): string {
  const texto = buscaCompativel(busca, destino);

  return destino === "ml"
    ? buildFilterHref("/anuncios", { busca: texto }, 1)
    : buildFilterHref(SHOPEE_LISTINGS_PATH, { q: texto }, 1);
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Contas do Mercado Livre que a pessoa alcança — só o número (`head`), no
 * banco. A RLS de `ml_accounts` já restringe às contas permitidas.
 */
export async function contarContasMl(supabase: Supabase): Promise<number | null> {
  const { count, error } = await supabase.from("ml_accounts").select("id", { count: "exact", head: true });

  return error === null ? count : null;
}

/**
 * Lojas Shopee que a pessoa alcança — só o número, no banco. Conta a loja de
 * teste: é nas telas da Shopee que ela aparece, com o selo "Teste". A RLS das
 * lojas é por ORGANIZAÇÃO (risco S1, `docs/MULTICHANNEL_CONTRACTS.md`): o
 * número não expõe loja nenhuma, e as telas Shopee já existiam para todos.
 */
export async function contarLojasShopee(supabase: Supabase): Promise<number | null> {
  const { count, error } = await supabase.from("shopee_shops").select("id", { count: "exact", head: true });

  return error === null ? count : null;
}
