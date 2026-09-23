/**
 * A leitura de `get_faturamento` (D-356): contrato conferido, tom da margem e
 * geometria das barras — sem React e sem banco, para ser testável.
 *
 * A RPC devolve `jsonb`, que o gerador de tipos declara como `Json`. Um `as` na
 * tela aceitaria qualquer coisa: um campo renomeado no SQL chegaria como
 * `undefined`, e o `formatCurrency` o mostraria como "—", que se lê como "não
 * observado" — um número errado com aparência de certo (D-131). Aqui cada campo
 * é conferido, e uma resposta fora do contrato é recusada INTEIRA.
 *
 * Nada aqui soma dinheiro: toda soma e toda margem vêm do SQL
 * (`docs/ARCHITECTURE.md` §21). Este módulo lê, dá tom e posiciona.
 */

/** Abaixo disto a margem pede atenção — o mesmo corte da lista "menor margem" da RPC. */
export const MARGEM_MINIMA = 0.1;

const RESUMO_CONTAGENS = [
  "pedidos",
  "compras",
  "unidades",
  "receita_bruta",
  "taxas_ml",
  "pedidos_com_custos",
  "pedidos_cobertos",
  "pedidos_custo_atual",
  "pedidos_sem_sku",
  "pedidos_sem_custo",
  "pedidos_sem_frete",
  "pedidos_multi_item",
] as const;

const RESUMO_ANULAVEIS = [
  "ticket_medio",
  "preco_medio",
  "comissao_percentual",
  "receita_com_custos",
  "taxas_ml_com_custos",
  "frete_vendedor",
  "desconto_vendedor",
  "margem_operacional",
  "frete_medio_pedido",
  "receita_coberta",
  "taxas_ml_cobertas",
  "frete_vendedor_coberto",
  "margem_operacional_coberta",
  "custo_produtos",
  "resultado_venda",
  "margem_venda",
] as const;

const DIA_CONTAGENS = ["pedidos", "receita_bruta"] as const;
const DIA_ANULAVEIS = ["taxas_ml", "frete_vendedor", "receita_coberta", "resultado_venda", "margem_venda"] as const;

const CONTA_CONTAGENS = ["pedidos", "receita_bruta", "pedidos_com_custos", "pedidos_cobertos"] as const;
const CONTA_ANULAVEIS = [
  "taxas_ml",
  "frete_vendedor",
  "margem_operacional",
  "receita_coberta",
  "resultado_venda",
  "margem_venda",
] as const;

const SKU_CONTAGENS = ["unidades", "pedidos", "receita_bruta", "pedidos_cobertos"] as const;
const SKU_ANULAVEIS = [
  "taxas_ml",
  "receita_coberta",
  "frete_vendedor",
  "custo_produtos",
  "resultado_venda",
  "margem_venda",
] as const;

type Campos<C extends string, A extends string> = Readonly<Record<C, number> & Record<A, number | null>>;

export type ResumoFaturamento = Campos<(typeof RESUMO_CONTAGENS)[number], (typeof RESUMO_ANULAVEIS)[number]>;

export type DiaFaturamento = Readonly<{ dia: string }> &
  Campos<(typeof DIA_CONTAGENS)[number], (typeof DIA_ANULAVEIS)[number]>;

export type ContaFaturamento = Readonly<{ ml_account_id: string; conta: string }> &
  Campos<(typeof CONTA_CONTAGENS)[number], (typeof CONTA_ANULAVEIS)[number]>;

export type SkuFaturamento = Readonly<{ sku_id: string; sku: string; title: string | null; custo_atual: boolean }> &
  Campos<(typeof SKU_CONTAGENS)[number], (typeof SKU_ANULAVEIS)[number]>;

export interface ProdutosDoFaturamento {
  readonly maiorReceita: readonly SkuFaturamento[];
  readonly menorMargem: readonly SkuFaturamento[];
  readonly skusComVenda: number;
  readonly skusAbaixoDaMargem: number;
  readonly skusMargemNegativa: number;
}

/**
 * O imposto do período (D-395), pela alíquota vigente no dia de cada pedido.
 *
 * Os campos chegam no resumo de `get_faturamento` só depois da migration
 * `20260923100100`. A web da `main` vai ao ar antes de a migration passar pelo
 * workflow de produção, então a AUSÊNCIA dos campos não é contrato quebrado:
 * é "este banco ainda não calcula imposto", e o bloco inteiro vira `null`.
 * Presentes, eles são conferidos como os demais — um só fora do formato recusa
 * a resposta inteira.
 */
export interface ImpostoDoPeriodo {
  readonly pedidos_sem_aliquota: number;
  /** A alíquota, quando uma só vale para todos os pedidos do período. */
  readonly aliquota_unica: number | null;
  /** NULL quando algum pedido do período não tem alíquota: nunca parcial. */
  readonly imposto_estimado: number | null;
  readonly imposto_coberto: number | null;
  readonly resultado_apos_imposto: number | null;
  readonly margem_apos_imposto: number | null;
}

const IMPOSTO_ANULAVEIS = [
  "aliquota_unica",
  "imposto_estimado",
  "imposto_coberto",
  "resultado_apos_imposto",
  "margem_apos_imposto",
] as const;

export interface Faturamento {
  readonly resumo: ResumoFaturamento;
  /** `null` quando o banco ainda não tem o imposto de D-395. */
  readonly imposto: ImpostoDoPeriodo | null;
  /** `null` quando a leitura foi pedida sem detalhe (o período anterior). */
  readonly diario: readonly DiaFaturamento[] | null;
  readonly porConta: readonly ContaFaturamento[] | null;
  readonly produtos: ProdutosDoFaturamento | null;
}

class ForaDoContrato extends Error {}

type Registro = Readonly<Record<string, unknown>>;

function registro(valor: unknown): Registro {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new ForaDoContrato("objeto esperado");
  }

  return valor as Registro;
}

/** Aceita número e texto numérico; `null` é `null`. Qualquer outra coisa — `undefined` inclusive — é contrato quebrado. */
function numeroOuNulo(valor: unknown, chave: string): number | null {
  if (valor === null) return null;
  if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  if (typeof valor === "string" && valor.trim() !== "" && Number.isFinite(Number(valor))) return Number(valor);

  throw new ForaDoContrato(chave);
}

function contagem(r: Registro, chave: string): number {
  const n = numeroOuNulo(r[chave], chave);

  if (n === null) throw new ForaDoContrato(chave);

  return n;
}

function campos<C extends string, A extends string>(
  r: Registro,
  contagens: readonly C[],
  anulaveis: readonly A[],
): Campos<C, A> {
  const saida: Record<string, number | null> = {};

  for (const chave of contagens) {
    saida[chave] = contagem(r, chave);
  }

  for (const chave of anulaveis) {
    // Ausente não é nulo: `null` é "não observado", e a chave sumida é o SQL
    // que mudou sem a tela saber.
    if (!(chave in r)) throw new ForaDoContrato(chave);

    saida[chave] = numeroOuNulo(r[chave], chave);
  }

  return saida as Campos<C, A>;
}

function texto(r: Registro, chave: string): string {
  const valor = r[chave];

  if (typeof valor !== "string") throw new ForaDoContrato(chave);

  return valor;
}

function textoOuNulo(r: Registro, chave: string): string | null {
  const valor = r[chave];

  if (valor === null) return null;
  if (typeof valor !== "string") throw new ForaDoContrato(chave);

  return valor;
}

function lista<T>(valor: unknown, ler: (r: Registro) => T): T[] {
  if (!Array.isArray(valor)) throw new ForaDoContrato("lista esperada");

  return valor.map((item: unknown) => ler(registro(item)));
}

function lerSku(r: Registro): SkuFaturamento {
  const custoAtual = r.custo_atual;

  if (typeof custoAtual !== "boolean") throw new ForaDoContrato("custo_atual");

  return {
    sku_id: texto(r, "sku_id"),
    sku: texto(r, "sku"),
    title: textoOuNulo(r, "title"),
    custo_atual: custoAtual,
    ...campos(r, SKU_CONTAGENS, SKU_ANULAVEIS),
  };
}

/** Lê a resposta de `get_faturamento`; `null` quando ela não cumpre o contrato. */
export function lerFaturamento(valor: unknown): Faturamento | null {
  try {
    const raiz = registro(valor);
    const produtos = raiz.por_sku === null ? null : registro(raiz.por_sku);
    const resumo = registro(raiz.resumo);

    return {
      resumo: campos(resumo, RESUMO_CONTAGENS, RESUMO_ANULAVEIS),
      imposto: "pedidos_sem_aliquota" in resumo ? campos(resumo, ["pedidos_sem_aliquota"], IMPOSTO_ANULAVEIS) : null,
      diario:
        raiz.diario === null
          ? null
          : lista(raiz.diario, (r) => ({ dia: texto(r, "dia"), ...campos(r, DIA_CONTAGENS, DIA_ANULAVEIS) })),
      porConta:
        raiz.por_conta === null
          ? null
          : lista(raiz.por_conta, (r) => ({
              ml_account_id: texto(r, "ml_account_id"),
              conta: texto(r, "conta"),
              ...campos(r, CONTA_CONTAGENS, CONTA_ANULAVEIS),
            })),
      produtos:
        produtos === null
          ? null
          : {
              maiorReceita: lista(produtos.maior_receita, lerSku),
              menorMargem: lista(produtos.menor_margem, lerSku),
              skusComVenda: contagem(produtos, "skus_com_venda"),
              skusAbaixoDaMargem: contagem(produtos, "skus_margem_abaixo_10"),
              skusMargemNegativa: contagem(produtos, "skus_margem_negativa"),
            },
    };
  } catch (erro) {
    if (erro instanceof ForaDoContrato) return null;

    throw erro;
  }
}

export type TomDaMargem = "neutro" | "ok" | "atencao" | "perigo";

/** Sem margem é neutro, nunca "ok": a ausência de cobertura não é uma margem boa. */
export function tomDaMargem(margem: number | null): TomDaMargem {
  if (margem === null) return "neutro";
  if (margem < 0) return "perigo";
  if (margem < MARGEM_MINIMA) return "atencao";

  return "ok";
}

/** Fração de um todo, para LEITURA (cobertura, participação). `null` quando falta um lado ou o todo é zero — nunca 0% fingido. */
export function participacao(parte: number | null, todo: number | null): number | null {
  if (parte === null || todo === null || todo === 0) return null;

  return parte / todo;
}

export interface DegrauDaCascata {
  readonly chave: "receita" | "comissao" | "frete" | "recebido" | "custo" | "resultado";
  readonly rotulo: string;
  readonly metricId: string;
  readonly tipo: "total" | "deducao" | "subtotal" | "resultado";
  /** Em reais, com sinal: dedução é negativa. */
  readonly valor: number;
  /** Fração da receita coberta, com sinal. */
  readonly fracao: number;
  /** Onde a barra começa e quanto ocupa, em fração da receita, já limitadas a 0..1. */
  readonly inicio: number;
  readonly largura: number;
}

function faixa(a: number, b: number): { inicio: number; largura: number } {
  const limitar = (v: number): number => Math.min(1, Math.max(0, v));
  const inicio = limitar(Math.min(a, b));

  return { inicio, largura: limitar(Math.max(a, b)) - inicio };
}

/**
 * A cascata "para onde vai o dinheiro", TODA sobre os pedidos cobertos.
 *
 * Misturar subconjuntos — receita de todos os pedidos, custo só dos cobertos —
 * desenharia uma margem que nenhum pedido teve. Por isso cada degrau vem de uma
 * chave `*_coberta` do SQL, e sem cobertura não há cascata.
 *
 * As barras são uma cascata de verdade: cada dedução começa onde o degrau
 * anterior terminou, e o subtotal recomeça do zero.
 */
export function montarCascata(resumo: ResumoFaturamento): DegrauDaCascata[] | null {
  const receita = resumo.receita_coberta;
  const comissao = resumo.taxas_ml_cobertas;
  const frete = resumo.frete_vendedor_coberto;
  const recebido = resumo.margem_operacional_coberta;
  const custo = resumo.custo_produtos;
  const resultado = resumo.resultado_venda;

  if (
    resumo.pedidos_cobertos === 0 ||
    receita === null ||
    receita <= 0 ||
    comissao === null ||
    frete === null ||
    recebido === null ||
    custo === null ||
    resultado === null
  ) {
    return null;
  }

  const f = (valor: number): number => valor / receita;

  return [
    { chave: "receita", rotulo: "Receita das vendas", metricId: "receita_bruta", tipo: "total", valor: receita, fracao: 1, ...faixa(0, 1) },
    {
      chave: "comissao",
      rotulo: "Comissão do Mercado Livre",
      metricId: "taxas_ml",
      tipo: "deducao",
      valor: -comissao,
      fracao: -f(comissao),
      ...faixa(1 - f(comissao), 1),
    },
    {
      chave: "frete",
      rotulo: "Frete pago pelo vendedor",
      metricId: "frete_vendedor",
      tipo: "deducao",
      valor: -frete,
      fracao: -f(frete),
      ...faixa(f(recebido), 1 - f(comissao)),
    },
    {
      chave: "recebido",
      rotulo: "Recebido após o Mercado Livre",
      metricId: "margem_operacional_pedido",
      tipo: "subtotal",
      valor: recebido,
      fracao: f(recebido),
      ...faixa(0, Math.abs(f(recebido))),
    },
    {
      chave: "custo",
      rotulo: "Custo dos produtos",
      metricId: "custo_produtos_vendidos",
      tipo: "deducao",
      valor: -custo,
      fracao: -f(custo),
      ...faixa(f(resultado), f(recebido)),
    },
    {
      chave: "resultado",
      rotulo: "Resultado da venda",
      metricId: "resultado_venda",
      tipo: "resultado",
      valor: resultado,
      fracao: f(resultado),
      // Resultado negativo desenha a barra do mesmo tamanho, e a tela a pinta de perigo.
      ...faixa(0, Math.abs(f(resultado))),
    },
  ];
}

export interface EscalaDaMargem {
  /** Altura da linha do zero, em fração do gráfico, a partir da base. */
  readonly zero: number;
  /** Quantas unidades de margem a altura inteira representa. */
  readonly total: number;
}

/** A margem desenhada vai de −100% a +100%; o número exato continua na leitura do dia. */
const MARGEM_DESENHADA = 1;

function limitarMargem(margem: number): number {
  return Math.max(-MARGEM_DESENHADA, Math.min(MARGEM_DESENHADA, margem));
}

/**
 * UMA escala para cima e para baixo do zero: centímetro de margem positiva e
 * negativa medem a mesma coisa. O teto nunca fica abaixo de 15%, para a linha de
 * referência de 10% caber no gráfico mesmo num período de margem baixa.
 */
export function escalaDasMargens(margens: readonly (number | null)[]): EscalaDaMargem {
  const valores = margens.filter((m): m is number => m !== null).map(limitarMargem);
  const positivo = Math.max(MARGEM_MINIMA * 1.5, ...valores);
  const negativo = Math.max(0, ...valores.map((m) => -m));
  const total = positivo + negativo;

  return { zero: negativo / total, total };
}

/** Base e altura da barra de um dia, em fração da altura do gráfico. */
export function barraDaMargem(margem: number, escala: EscalaDaMargem): { base: number; altura: number } {
  const limitada = limitarMargem(margem);
  const altura = Math.abs(limitada) / escala.total;

  return limitada >= 0 ? { base: escala.zero, altura } : { base: escala.zero - altura, altura };
}
