/**
 * A leitura de `get_listings_link_overview` (D-376) e as peças puras de
 * `/vinculacoes` — sem React e sem banco, para serem testáveis.
 *
 * A RPC devolve `jsonb`, que o gerador declara como `Json`. Um `as` aceitaria
 * qualquer coisa, e um campo renomeado no SQL chegaria como `undefined` e sairia
 * "—" na tela, que se lê como "não observado" (D-131). Cada campo é conferido,
 * e uma resposta fora do contrato é recusada INTEIRA — o desenho de
 * `lib/replenishment-overview.ts` e `lib/suppliers-overview.ts`.
 *
 * Recusar INTEIRA é o que faz o caminho antigo (as cinco chamadas a
 * `get_listings_dashboard`) continuar valendo enquanto a migration não chega ao
 * banco: a página tenta a leitura nova, e só volta ao caminho antigo quando
 * esta função devolve `null`.
 *
 * Nada aqui soma: contagens, percentuais e valores vêm do SQL.
 */

/** Os três valores de `link_state` (D-122) — nulo nunca quer dizer "sem vínculo". */
export type EstadoDoVinculo = "linked" | "linked_variation" | "unlinked";

export interface LinhaAnuncioVisao {
  readonly listing_id: string;
  readonly item_id: string;
  readonly title: string | null;
  readonly price: number | null;
  readonly ml_account_id: string;
  readonly account_label: string;
  readonly account_slug: string | null;
  readonly sku_id: string | null;
  readonly sku: string | null;
  readonly link_state: EstadoDoVinculo;
  readonly units_sold: number;
  readonly gross_revenue: number;
  /** NULA sem snapshot de Full: ausência de dado não é estoque zero (D-067). */
  readonly full_quantity: number | null;
}

export interface ContagensVinculos {
  readonly todos: number;
  readonly vinculados: number;
  /** Quantos dos vinculados são por VARIAÇÃO — a distinção que D-122 mediu. */
  readonly por_variacao: number;
  readonly sem_vinculo: number;
  readonly vendidos_sem_vinculo: number;
  /** Sem vínculo e sem venda na janela — o resto de `sem_vinculo`, contado no SQL. */
  readonly parados_sem_vinculo: number;
  readonly receita_sem_vinculo: number;
  readonly unidades_sem_vinculo: number;
  /** Segue a conta escolhida, mas IGNORA a busca: a fila do ERP não tem título nem MLB. */
  readonly candidatos_abertos: number;
}

export interface ContaNaComparacao {
  readonly ml_account_id: string;
  readonly account_label: string;
  readonly account_slug: string | null;
  readonly listings_total: number;
  readonly com_vinculo: number;
  readonly sem_vinculo: number;
  /** NULO sem anúncio nenhum: "0%" afirmaria que nenhum está vinculado (D-254). */
  readonly pct_vinculado: number | null;
  readonly vendidos_sem_vinculo: number;
  readonly receita_sem_vinculo: number;
  readonly candidatos_abertos: number;
}

export interface VisaoVinculacoes {
  readonly total: number;
  readonly contagens: ContagensVinculos;
  readonly porConta: readonly ContaNaComparacao[];
  readonly linhas: readonly LinhaAnuncioVisao[];
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

const ESTADOS: readonly string[] = ["linked", "linked_variation", "unlinked"];

const CONTAGENS = [
  "todos",
  "vinculados",
  "por_variacao",
  "sem_vinculo",
  "vendidos_sem_vinculo",
  "parados_sem_vinculo",
  "receita_sem_vinculo",
  "unidades_sem_vinculo",
  "candidatos_abertos",
] as const;

const NUMEROS_DA_CONTA = [
  "listings_total",
  "com_vinculo",
  "sem_vinculo",
  "vendidos_sem_vinculo",
  "receita_sem_vinculo",
  "candidatos_abertos",
] as const;

function lerLinha(v: unknown): LinhaAnuncioVisao | null {
  if (!ehObj(v)) return null;
  if (typeof v.listing_id !== "string" || typeof v.item_id !== "string") return null;
  if (typeof v.ml_account_id !== "string" || typeof v.account_label !== "string") return null;
  if (typeof v.link_state !== "string" || !ESTADOS.includes(v.link_state)) return null;
  if (!textoOuNulo(v.title) || !textoOuNulo(v.sku) || !textoOuNulo(v.sku_id) || !textoOuNulo(v.account_slug)) {
    return null;
  }
  if (!numOuNulo(v.price) || !numOuNulo(v.full_quantity)) return null;
  if (!ehNum(v.units_sold) || !ehNum(v.gross_revenue)) return null;

  return {
    listing_id: v.listing_id,
    item_id: v.item_id,
    title: v.title,
    price: v.price,
    ml_account_id: v.ml_account_id,
    account_label: v.account_label,
    account_slug: v.account_slug,
    sku_id: v.sku_id,
    sku: v.sku,
    link_state: v.link_state as EstadoDoVinculo,
    units_sold: v.units_sold,
    gross_revenue: v.gross_revenue,
    full_quantity: v.full_quantity,
  };
}

function lerConta(v: unknown): ContaNaComparacao | null {
  if (!ehObj(v)) return null;
  if (typeof v.ml_account_id !== "string" || typeof v.account_label !== "string") return null;
  if (!textoOuNulo(v.account_slug) || !numOuNulo(v.pct_vinculado)) return null;
  if (NUMEROS_DA_CONTA.some((campo) => !ehNum(v[campo]))) return null;

  const numero = (campo: (typeof NUMEROS_DA_CONTA)[number]): number => v[campo] as number;

  return {
    ml_account_id: v.ml_account_id,
    account_label: v.account_label,
    account_slug: v.account_slug,
    listings_total: numero("listings_total"),
    com_vinculo: numero("com_vinculo"),
    sem_vinculo: numero("sem_vinculo"),
    pct_vinculado: v.pct_vinculado,
    vendidos_sem_vinculo: numero("vendidos_sem_vinculo"),
    receita_sem_vinculo: numero("receita_sem_vinculo"),
    candidatos_abertos: numero("candidatos_abertos"),
  };
}

export function lerVisaoVinculacoes(bruto: unknown): VisaoVinculacoes | null {
  if (!ehObj(bruto)) return null;
  if (!ehNum(bruto.total) || !ehObj(bruto.contagens)) return null;
  if (!Array.isArray(bruto.linhas) || !Array.isArray(bruto.por_conta)) return null;

  const cru = bruto.contagens;

  if (CONTAGENS.some((campo) => !ehNum(cru[campo]))) return null;

  const contagem = (campo: (typeof CONTAGENS)[number]): number => cru[campo] as number;

  const linhas: LinhaAnuncioVisao[] = [];

  for (const item of bruto.linhas) {
    const linha = lerLinha(item);

    if (linha === null) return null;

    linhas.push(linha);
  }

  const porConta: ContaNaComparacao[] = [];

  for (const item of bruto.por_conta) {
    const conta = lerConta(item);

    if (conta === null) return null;

    porConta.push(conta);
  }

  return {
    total: bruto.total,
    contagens: {
      todos: contagem("todos"),
      vinculados: contagem("vinculados"),
      por_variacao: contagem("por_variacao"),
      sem_vinculo: contagem("sem_vinculo"),
      vendidos_sem_vinculo: contagem("vendidos_sem_vinculo"),
      parados_sem_vinculo: contagem("parados_sem_vinculo"),
      receita_sem_vinculo: contagem("receita_sem_vinculo"),
      unidades_sem_vinculo: contagem("unidades_sem_vinculo"),
      candidatos_abertos: contagem("candidatos_abertos"),
    },
    porConta,
    linhas,
  };
}

/**
 * A COR DE CADA CONTA.
 *
 * A conta aparece em toda linha da tabela e em toda linha da comparação; um
 * selo colorido deixa a leitura de "qual conta" pré-atenta sem gastar uma
 * coluna de texto com ela. Não há cor de conta no modelo, então a tela escolhe.
 *
 * **Por POSIÇÃO na lista ordenada, não por hash do id.** A primeira versão
 * tirava o tom de um hash do uuid, e com quatro contas e seis tons a chance de
 * duas caírem na mesma cor passa de 60% — duas contas com o mesmo selo é pior
 * que selo nenhum. Pela posição, as seis primeiras contas são sempre
 * distintas, e a ordem é a mesma da lista (por rótulo), então a cor só muda se
 * uma conta nova entrar ANTES dela no alfabeto.
 *
 * Os seis tons são tinta da casa; nenhum é o vermelho de perigo, que nesta tela
 * significa "vendeu sem vínculo" e não pode virar decoração.
 */
export const TONS_DE_CONTA = 6;

export function tonsDasContas(idsNaOrdemDaTela: readonly string[]): ReadonlyMap<string, number> {
  const tons = new Map<string, number>();

  idsNaOrdemDaTela.forEach((id, posicao) => {
    tons.set(id, posicao % TONS_DE_CONTA);
  });

  return tons;
}

/** As iniciais que cabem no selo da conta — "Speedbikers (loja 2)" vira "S2". */
export function iniciaisDaConta(label: string): string {
  const palavras = label
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((p) => p !== "");

  if (palavras.length === 0) return "?";

  const primeira = palavras[0] ?? "";
  const ultima = palavras.length > 1 ? (palavras[palavras.length - 1] ?? "") : "";
  // "loja 2" → o número é o que distingue as duas contas com o mesmo nome.
  const segunda = /^\d+$/.test(ultima) ? ultima : ultima.slice(0, 1);

  return (primeira.slice(0, 1) + segunda).toUpperCase().slice(0, 2);
}
