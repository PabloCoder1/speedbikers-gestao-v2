/**
 * `/faturamento` com MAIS DE UM MARKETPLACE (D-442, etapa T5 da frente
 * multicanal), sobre o contrato C-58 (`get_shopee_faturamento`, D-437).
 *
 * `/faturamento` sem `marketplace` continua sendo a tela do Mercado Livre de
 * sempre (`get_faturamento`, D-356). `marketplace=shopee` é a conta da própria
 * Shopee — resultado = recebido (escrow) − custo — e `marketplace=todos` põe os
 * dois LADO A LADO, sem total: o resultado do ML (`docs/METRICS.md` 5F) e o da
 * Shopee (5U) têm componentes diferentes, e somá-los daria um número sem
 * definição. A receita consolidada, que soma, mora em `/vendas` (C-53).
 *
 * Aqui mora só o que a tela decide: o endereço de cada troca, a forma das
 * linhas e a ordem da comparação. **Nada aqui soma** — cada número já veio do
 * SQL.
 */

import type { Database } from "@sb/db";

import type { DegrauDaCascata, ImpostoDoPeriodo, ResumoFaturamento, SkuFaturamento } from "./faturamento";
import { hrefDoRecorte, type ContaDoSeletor, type EscopoVendas, type Periodo } from "./vendas-multicanal";

export interface RecorteDeFaturamento {
  readonly escopo: EscopoVendas;
  readonly periodo: Periodo;
  /** Só existe no recorte Shopee: as lojas marcadas (`contas=a,b`). */
  readonly contas: readonly ContaDoSeletor[] | null;
}

/**
 * O endereço de `/faturamento` com um recorte trocado. Os parâmetros são os de
 * `/vendas` (`marketplace`, período, `contas`), para trocar de tela levar tudo
 * junto. **As lojas só valem no recorte Shopee:** no "Todos" o lado do Mercado
 * Livre é `get_faturamento`, que aceita uma conta só — um recorte de várias
 * contas mostraria o ML inteiro ao lado de uma Shopee recortada.
 */
export function hrefDeFaturamento(atual: RecorteDeFaturamento, troca: Partial<RecorteDeFaturamento> = {}): string {
  const escopo = troca.escopo ?? atual.escopo;
  const contas = escopo === "shopee" ? (troca.contas === undefined ? atual.contas : troca.contas) : null;

  return hrefDoRecorte(
    "/faturamento",
    { escopo: atual.escopo, periodo: atual.periodo, contas: atual.contas, metrica: "faturamento" },
    { escopo, periodo: troca.periodo ?? atual.periodo, contas },
  );
}

/** Uma linha de `get_shopee_faturamento` (C-58). Loja nunca lida: tudo nulo. */
export interface LinhaFaturamentoShopee {
  readonly nivel: "TOTAL" | "CONTA";
  readonly account_id: string | null;
  readonly account_name: string | null;
  readonly environment: string | null;
  readonly pedidos: number | null;
  readonly receita_bruta: number | null;
  readonly pedidos_sem_receita: number | null;
  readonly pedidos_cobertos: number | null;
  readonly receita_coberta: number | null;
  readonly recebido_coberto: number | null;
  readonly custo_produtos: number | null;
  readonly resultado_venda: number | null;
  readonly margem_venda: number | null;
  readonly pedidos_definitivos: number | null;
  readonly resultado_definitivo: number | null;
  readonly pedidos_provisorios: number | null;
  readonly resultado_provisorio: number | null;
  readonly pedidos_sem_financeiro: number | null;
  readonly pedidos_sem_sku: number | null;
  readonly pedidos_sem_custo: number | null;
  readonly pedidos_custo_atual: number | null;
  readonly pedidos_sem_aliquota: number | null;
  readonly imposto_coberto: number | null;
  readonly resultado_apos_imposto: number | null;
  readonly margem_apos_imposto: number | null;
  readonly ultima_atualizacao: string | null;
  /**
   * D-485: os ajustes que a Shopee cobra DEPOIS do repasse (negativo = cobrado),
   * já dentro do resultado. Ausente (`undefined`) antes da 20261016220000; nulo
   * quando nenhum coberto trouxe o campo.
   */
  readonly ajustes_cobertos?: number | null;
  /** D-487: o Ads CPC da loja no período e o rateado pela receita coberta. Ausentes antes da 20261016230000. */
  readonly investimento_ads?: number | null;
  readonly ads_rateado?: number | null;
  /** D-487: lucro após imposto e Ads (5K, no SQL) e a margem dele. Nulos sem alíquota ou sem o Ads do período inteiro. */
  readonly resultado_contribuicao?: number | null;
  readonly margem_contribuicao?: number | null;
}

/**
 * O TOTAL e as lojas. O TOTAL só existe com alguma loja live já lida — sem
 * ele, nada do recorte é somável (só loja de teste, ou nenhuma lida), e a tela
 * diz isso em vez de mostrar zero. Arrumação, sem conta.
 */
export function separarLinhasShopee(linhas: readonly LinhaFaturamentoShopee[]): {
  total: LinhaFaturamentoShopee | null;
  lojas: LinhaFaturamentoShopee[];
} {
  return {
    total: linhas.find((linha) => linha.nivel === "TOTAL") ?? null,
    lojas: linhas.filter((linha) => linha.nivel === "CONTA"),
  };
}

/** Loja de teste: aparece na tabela, marcada, e nunca entra nas somas. */
export function lojaDeTeste(linha: LinhaFaturamentoShopee): boolean {
  return linha.environment !== null && linha.environment !== "live";
}

/** Loja cujos pedidos nunca foram lidos: a linha vem toda nula, e mostra "—". */
export function lojaNuncaLida(linha: LinhaFaturamentoShopee): boolean {
  return linha.pedidos === null;
}

export interface MotivoForaDaCobertura {
  readonly chave: "sem_receita" | "sem_financeiro" | "sem_sku" | "sem_custo";
  readonly rotulo: string;
  readonly pedidos: number;
  readonly nota: string;
  /** Onde se resolve, quando é na mão de quem lê. */
  readonly link: { readonly href: string; readonly texto: string } | null;
}

/**
 * Por que os pedidos que faltam ficaram fora do resultado — os contadores do
 * C-58, na ordem em que o pedido avança. **Um pedido pode ter mais de um
 * motivo** (sem financeiro E sem SKU, por exemplo): as contagens não somam até
 * os pedidos fora da cobertura, e a tela diz isso.
 */
export function motivosForaDaCobertura(linha: LinhaFaturamentoShopee): MotivoForaDaCobertura[] {
  return [
    {
      chave: "sem_receita" as const,
      rotulo: "Sem receita conhecida",
      pedidos: linha.pedidos_sem_receita ?? 0,
      nota: "item de preço zero antes do financeiro: a receita não é inventada",
      link: null,
    },
    {
      chave: "sem_financeiro" as const,
      rotulo: "Aguardando o financeiro",
      pedidos: linha.pedidos_sem_financeiro ?? 0,
      nota: "o recebido (escrow) ainda não foi lido da Shopee",
      link: null,
    },
    {
      chave: "sem_sku" as const,
      rotulo: "Sem produto vinculado",
      pedidos: linha.pedidos_sem_sku ?? 0,
      nota: "sem produto não há custo",
      link: { href: "/anuncios/shopee", texto: "vincular anúncios da Shopee" },
    },
    {
      chave: "sem_custo" as const,
      rotulo: "Produto sem custo",
      pedidos: linha.pedidos_sem_custo ?? 0,
      nota: "custo vazio ou zero não é somado",
      link: { href: "/produtos", texto: "ver produtos" },
    },
  ];
}

export type FormatoDaComparacao = "moeda" | "contagem" | "percentual";

export interface LinhaDaComparacao {
  readonly rotulo: string;
  readonly formato: FormatoDaComparacao;
  readonly ml: number | null;
  readonly shopee: number | null;
  /** O que o número é em cada canal, quando a definição não é a mesma. */
  readonly definicao: { readonly ml: string; readonly shopee: string } | null;
}

/**
 * A comparação de `marketplace=todos`, linha a linha: o mesmo nome de cada lado
 * só onde a medida é a mesma (receita, compras, custo — a regra de custo da
 * Shopee foi provada igual à do ML, D-437); onde não é (o recebido, e por
 * consequência resultado e margem), a definição de cada canal vai junto.
 *
 * O "recebido" do ML é o dos pedidos COBERTOS (`margem_operacional_coberta`),
 * para ficar sobre os mesmos pedidos do resultado — como o da Shopee.
 */
export function linhasDaComparacao(
  ml: { readonly resumo: ResumoFaturamento; readonly imposto: ImpostoDoPeriodo | null } | null,
  shopee: LinhaFaturamentoShopee | null,
  /** O lucro após imposto e Ads do ML pela regra dos indicadores da central (`lucroDoMercadoLivre`). */
  lucroMl: number | null = null,
): LinhaDaComparacao[] {
  const r = ml?.resumo ?? null;
  // D-485 pela PRESENÇA da coluna: antes da 20261016220000 o resultado da Shopee ainda é recebido − custo.
  const comAjustes = shopee?.ajustes_cobertos !== undefined;

  return [
    { rotulo: "Receita bruta", formato: "moeda", ml: r?.receita_bruta ?? null, shopee: shopee?.receita_bruta ?? null, definicao: null },
    {
      rotulo: "Compras",
      formato: "contagem",
      ml: r?.compras ?? null,
      shopee: shopee?.pedidos ?? null,
      definicao: { ml: "o pack (o carrinho do comprador)", shopee: "o pedido (já é o carrinho)" },
    },
    {
      rotulo: "Receita coberta",
      formato: "moeda",
      ml: r?.receita_coberta ?? null,
      shopee: shopee?.receita_coberta ?? null,
      definicao: {
        ml: "pedidos com frete observado, custo conhecido e um produto",
        shopee: "pedidos com financeiro lido, produto e custo em todos os itens",
      },
    },
    {
      rotulo: "Recebido",
      formato: "moeda",
      ml: r?.margem_operacional_coberta ?? null,
      shopee: shopee?.recebido_coberto ?? null,
      definicao: {
        ml: "receita − comissão − frete do vendedor; taxa fixa, parcelamento e Mercado Pago ficam fora",
        shopee: "o escrow: já sem comissão, taxas de serviço e transação, frete, cupons da loja e afiliados",
      },
    },
    {
      rotulo: "Custo dos produtos",
      formato: "moeda",
      ml: r?.custo_produtos ?? null,
      shopee: shopee?.custo_produtos ?? null,
      definicao: null,
    },
    {
      rotulo: "Resultado da venda",
      formato: "moeda",
      ml: r?.resultado_venda ?? null,
      shopee: shopee?.resultado_venda ?? null,
      definicao: {
        ml: "recebido − custo, pela conta do ML",
        shopee: comAjustes
          ? "recebido + ajustes depois do repasse − custo, pela conta da Shopee"
          : "recebido − custo, pela conta da Shopee",
      },
    },
    {
      rotulo: "Margem sobre a venda",
      formato: "percentual",
      ml: r?.margem_venda ?? null,
      shopee: shopee?.margem_venda ?? null,
      definicao: null,
    },
    {
      rotulo: "Resultado após imposto",
      formato: "moeda",
      ml: ml?.imposto?.resultado_apos_imposto ?? null,
      shopee: shopee?.resultado_apos_imposto ?? null,
      definicao: null,
    },
    {
      // D-487/D-498: a regra do 5K nos dois -- o Ads rateado pela receita coberta, sem custos fixos.
      rotulo: "Lucro após imposto e Ads",
      formato: "moeda",
      ml: lucroMl,
      shopee: shopee?.resultado_contribuicao ?? null,
      definicao: {
        ml: "Product Ads rateado pela receita coberta; sem custos fixos",
        shopee: "Ads CPC da loja rateado pela receita coberta (o GMV Max fica fora); sem custos fixos",
      },
    },
  ];
}


// ---------------------------------------------------------------------------
// T5b (D-452): a composição do recebido, a série diária e os produtos, sobre o
// C-61 (D-443) -- os MESMOS pedidos cobertos do C-58.
// ---------------------------------------------------------------------------

type Funcoes = Database["public"]["Functions"];

/** Uma linha de `get_shopee_faturamento_composicao` (TOTAL ou uma loja). */
export type ComposicaoShopee = Funcoes["get_shopee_faturamento_composicao"]["Returns"][number];

/** Um dia de `get_shopee_faturamento_diario`. */
export type DiaShopee = Funcoes["get_shopee_faturamento_diario"]["Returns"][number];

/** Um SKU de `get_shopee_faturamento_por_sku`. */
export type SkuShopee = Funcoes["get_shopee_faturamento_por_sku"]["Returns"][number];

type ChaveDoComponente =
  | "comissao"
  | "taxa_servico"
  | "taxa_transacao"
  | "frete_loja"
  | "frete_devolucao"
  | "cupom_loja"
  | "afiliados"
  | "taxa_por_pedido"
  | "protecao_envio"
  | "outros";

/**
 * Os componentes que a Shopee desconta antes de repassar o recebido (escrow),
 * na ordem da fórmula oficial (C-61). "Outros" é o que a lista não explica --
 * fecha a conta `receita − componentes − outros = recebido` e pode ser
 * negativo (crédito, como um repasse de desconto da Shopee).
 *
 * A proteção de envio (D-483, D-492) era o "outros" inteiro na leitura real e
 * ganhou degrau próprio, logo antes dele.
 */
export const COMPONENTES_DO_RECEBIDO: readonly { chave: ChaveDoComponente; rotulo: string }[] = [
  { chave: "comissao", rotulo: "Comissão da Shopee" },
  { chave: "taxa_servico", rotulo: "Taxa de serviço" },
  { chave: "taxa_transacao", rotulo: "Taxa de transação" },
  { chave: "frete_loja", rotulo: "Frete pago pela loja" },
  { chave: "frete_devolucao", rotulo: "Frete de devolução" },
  { chave: "cupom_loja", rotulo: "Cupons da loja" },
  { chave: "afiliados", rotulo: "Comissão de afiliados" },
  { chave: "taxa_por_pedido", rotulo: "Taxa por pedido" },
  { chave: "protecao_envio", rotulo: "Proteção de envio" },
  { chave: "outros", rotulo: "Outros (fecha com o recebido)" },
];

function faixa(a: number, b: number): { inicio: number; largura: number } {
  const limitar = (v: number): number => Math.min(1, Math.max(0, v));
  const inicio = limitar(Math.min(a, b));

  return { inicio, largura: limitar(Math.max(a, b)) - inicio };
}

/** O degrau da D-485: o mesmo nome da linha informativa que ele substitui. */
export const AJUSTES_DEPOIS_DO_REPASSE = "Ajustes depois do repasse";

export interface CascataShopee {
  readonly degraus: DegrauDaCascata[];
  /** Componentes que nenhum pedido coberto informou: NULO no contrato, fora da cascata -- e ditos. */
  readonly naoInformados: string[];
  /** Componentes informados que deram zero no período: fora das barras, ditos numa linha. */
  readonly zerados: string[];
}

/**
 * "Para onde vai o dinheiro" na Shopee (D-452): da receita coberta ao
 * resultado, componente a componente, TUDO sobre os mesmos pedidos cobertos.
 * O custo e o resultado vêm do C-58 (`get_shopee_faturamento`), que cobre os
 * mesmos pedidos; o resto, do C-61.
 *
 * É uma cascata de verdade: cada componente começa onde o anterior terminou --
 * e um crédito (componente negativo) sobe em vez de descer. O recebido recomeça
 * do zero. Nada é somado aqui: os valores vêm prontos, e a identidade da
 * composição é do banco.
 */
export function montarCascataShopee(
  composicao: ComposicaoShopee | null,
  custo: number | null,
  resultado: number | null,
  /** `ajustes_cobertos` do C-58 (D-485); `undefined` = o banco antes da 20261016220000. */
  ajustes?: number | null,
): CascataShopee | null {
  if (composicao === null) return null;

  const receita = composicao.receita_coberta;
  const recebido = composicao.recebido_coberto;

  if (
    (composicao.pedidos_cobertos ?? 0) === 0 ||
    receita === null ||
    receita <= 0 ||
    recebido === null ||
    custo === null ||
    resultado === null
  ) {
    return null;
  }

  const f = (valor: number): number => valor / receita;
  const degraus: DegrauDaCascata[] = [
    { chave: "receita", rotulo: "Receita das vendas", metricId: "shopee_receita_bruta", tipo: "total", valor: receita, fracao: 1, ...faixa(0, 1) },
  ];
  const naoInformados: string[] = [];
  const zerados: string[] = [];
  let nivel = 1;

  for (const componente of COMPONENTES_DO_RECEBIDO) {
    const valor = composicao[componente.chave];

    // Coluna ausente (o banco antes da D-483, ainda no tipo): fora da cascata e sem
    // nota. Desde a fase 2 (16/10) o `outros` já é o restante, sem a taxa.
    if (valor === undefined) continue;

    if (valor === null) {
      naoInformados.push(componente.rotulo);
      continue;
    }

    if (valor === 0) {
      zerados.push(componente.rotulo);
      continue;
    }

    const proximo = nivel - f(valor);

    degraus.push({
      chave: componente.chave,
      rotulo: componente.rotulo,
      metricId: "shopee_composicao_recebido",
      tipo: "deducao",
      // Desconto é negativo; crédito (componente negativo) fica positivo.
      valor: -valor,
      fracao: -f(valor),
      ...faixa(proximo, nivel),
    });
    nivel = proximo;
  }

  degraus.push(
    {
      chave: "recebido",
      rotulo: "Recebido da Shopee",
      metricId: "shopee_recebido",
      tipo: "subtotal",
      valor: recebido,
      fracao: f(recebido),
      ...faixa(0, Math.abs(f(recebido))),
    },
  );

  /*
    D-485: o ajuste que a Shopee cobra DEPOIS do repasse (ela libera o escrow
    cheio e cobra à parte) entra no resultado -- e aqui, entre o recebido e o
    custo, para a cascata fechar: resultado = recebido + ajustes − custo, no SQL.
    Pela PRESENÇA da coluna: ausente, a cascata de antes. Nulo (nenhum coberto
    trouxe o campo) e zero são ditos como os componentes; o custo começa onde
    o ajuste terminou.
  */
  let antesDoCusto = f(recebido);

  if (ajustes === null) {
    naoInformados.push(AJUSTES_DEPOIS_DO_REPASSE);
  } else if (ajustes === 0) {
    zerados.push(AJUSTES_DEPOIS_DO_REPASSE);
  } else if (ajustes !== undefined) {
    const depois = antesDoCusto + f(ajustes);

    degraus.push({
      chave: "ajustes",
      rotulo: AJUSTES_DEPOIS_DO_REPASSE,
      metricId: "shopee_ajustes_pos_repasse",
      tipo: "deducao",
      // Cobrado é negativo, como as deduções; um crédito sobe.
      valor: ajustes,
      fracao: f(ajustes),
      ...faixa(depois, antesDoCusto),
    });
    antesDoCusto = depois;
  }

  degraus.push(
    {
      chave: "custo",
      rotulo: "Custo dos produtos",
      metricId: "shopee_custo_produtos",
      tipo: "deducao",
      valor: -custo,
      fracao: -f(custo),
      ...faixa(f(resultado), antesDoCusto),
    },
    {
      chave: "resultado",
      rotulo: "Resultado da venda",
      metricId: "shopee_resultado_venda",
      tipo: "resultado",
      valor: resultado,
      fracao: f(resultado),
      ...faixa(0, Math.abs(f(resultado))),
    },
  );

  return { degraus, naoInformados, zerados };
}

/**
 * O SKU da Shopee na forma da lista de produtos do Faturamento (a mesma do
 * ML, `ListaProdutos`). Comissão e frete do ML não existem aqui: nulos. É
 * mudar de nome, não calcular. Receita DESCONHECIDA (só itens de preço zero)
 * não vira zero: o SKU sai da lista, e quem chama diz isso.
 */
export function skuParaALista(sku: SkuShopee): SkuFaturamento | null {
  if (sku.receita_bruta === null) return null;

  return {
    sku_id: sku.sku_id,
    sku: sku.sku,
    title: sku.title,
    custo_atual: sku.custo_atual,
    unidades: sku.unidades,
    pedidos: sku.pedidos,
    receita_bruta: sku.receita_bruta,
    pedidos_cobertos: sku.pedidos_cobertos,
    taxas_ml: null,
    receita_coberta: sku.receita_coberta,
    frete_vendedor: null,
    custo_produtos: sku.custo_produtos,
    resultado_venda: sku.resultado_venda,
    margem_venda: sku.margem_venda,
  };
}
