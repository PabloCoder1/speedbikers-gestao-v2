/**
 * Os campos do cadastro de meta e de alíquota (D-395), lidos como a pessoa
 * escreve — sem React e sem banco, para ser testável.
 *
 * Quem cadastra digita "2.800.000", "R$ 2.800.000,00" ou "6,5%". A conversão
 * mora aqui, e o banco recebe número; o CHECK de lá continua sendo a última
 * palavra (`revenue_goal > 0`, `0 <= rate < 1`).
 */

export type Leitura<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly erro: string };

const MES = /^(\d{4})-(\d{2})$/;
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Número escrito em pt-BR ou com ponto decimal.
 *
 * - com vírgula, ela é o decimal e os pontos são milhar ("2.800.000,50");
 * - sem vírgula e com mais de um ponto, os pontos são milhar ("2.800.000");
 * - sem vírgula e com UM ponto seguido de exatamente três dígitos, é milhar
 *   ("2.800" → 2800) — é assim que se escreve dinheiro no Brasil;
 * - qualquer outro ponto é decimal ("6.5").
 */
export function numeroDigitado(texto: string): number | null {
  const limpo = texto.replace(/R\$/gi, "").replace(/%/g, "").replace(/\s/g, "");

  if (limpo === "" || !/^[\d.,]+$/.test(limpo)) return null;

  let normal: string;

  if (limpo.includes(",")) {
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$/.test(limpo)) return null;
    normal = limpo.replace(/\./g, "").replace(",", ".");
  } else if ((limpo.match(/\./g) ?? []).length > 1 || /^\d{1,3}\.\d{3}$/.test(limpo)) {
    if (!/^\d{1,3}(?:\.\d{3})+$/.test(limpo)) return null;
    normal = limpo.replace(/\./g, "");
  } else {
    if (!/^\d+(?:\.\d+)?$/.test(limpo)) return null;
    normal = limpo;
  }

  const n = Number(normal);

  return Number.isFinite(n) ? n : null;
}

/** Meta em reais: positiva, com no máximo dois decimais e abaixo de um trilhão. */
export function lerValorEmReais(texto: string): Leitura<number> {
  const n = numeroDigitado(texto);

  if (n === null) return { ok: false, erro: "Escreva o valor em reais, por exemplo 2.800.000." };
  if (n <= 0) return { ok: false, erro: "A meta precisa ser maior que zero." };
  if (n >= 1e12) return { ok: false, erro: "Valor grande demais para uma meta mensal." };

  return { ok: true, valor: Math.round(n * 100) / 100 };
}

/**
 * Alíquota em porcentagem ("6,5" ou "6,5%") → fração (0.065). Até três casas
 * na porcentagem, que é o que `numeric(7,5)` guarda.
 */
export function lerPercentual(texto: string): Leitura<number> {
  const n = numeroDigitado(texto);

  if (n === null) return { ok: false, erro: "Escreva a alíquota em porcentagem, por exemplo 6,5." };
  if (n < 0 || n >= 100) return { ok: false, erro: "A alíquota fica de 0% a 99,999%." };

  const fracao = Math.round(n * 1000) / 100000;

  if (Math.abs(fracao * 100 - n) > 1e-9) return { ok: false, erro: "Use no máximo três casas decimais." };

  return { ok: true, valor: fracao };
}

/** `<input type="month">` → o primeiro dia do mês, como o banco guarda. */
export function lerMes(texto: string): Leitura<string> {
  const m = MES.exec(texto.trim());
  const mes = m === null ? NaN : Number(m[2]);

  if (m === null || mes < 1 || mes > 12) return { ok: false, erro: "Escolha o mês da meta." };

  return { ok: true, valor: `${m[1] ?? ""}-${m[2] ?? ""}-01` };
}

/** `<input type="date">`, conferida de verdade (31/02 não passa). */
export function lerData(texto: string): Leitura<string> {
  const m = DATA.exec(texto.trim());

  if (m === null) return { ok: false, erro: "Escolha a data de início da vigência." };

  const data = new Date(`${texto.trim()}T00:00:00Z`);

  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== texto.trim()) {
    return { ok: false, erro: "Data inválida." };
  }

  return { ok: true, valor: texto.trim() };
}

/** O marketplace de uma meta própria (D-473, C-66): só os dois que o banco aceita. */
export type MarketplaceDaMeta = "ML" | "SHOPEE";

export function lerMarketplaceDaMeta(texto: string): Leitura<MarketplaceDaMeta> {
  const valor = texto.trim();

  return valor === "ML" || valor === "SHOPEE" ? { ok: true, valor } : { ok: false, erro: "Escolha o marketplace da meta." };
}

/** O nome do marketplace de uma meta; um código que a tela não conhece nunca aparece cru. */
export function rotuloDoMarketplaceDaMeta(codigo: string): string {
  if (codigo === "ML") return "Mercado Livre";
  if (codigo === "SHOPEE") return "Shopee";

  return "Outro marketplace";
}

/** "do Mercado Livre", "da Shopee": o nome com a preposição que o português pede. */
export function doMarketplaceDaMeta(codigo: string): string {
  if (codigo === "ML") return "do Mercado Livre";
  if (codigo === "SHOPEE") return "da Shopee";

  return "de outro marketplace";
}

/** Nota opcional: vazia vira `null`; mais de 300 caracteres é recusada (o CHECK do banco). */
export function lerNota(texto: string): Leitura<string | null> {
  const nota = texto.trim();

  if (nota.length > 300) return { ok: false, erro: "A nota tem mais de 300 caracteres." };

  return { ok: true, valor: nota === "" ? null : nota };
}

const NOME_DO_MES = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });

/** "2026-09-01" → "setembro de 2026". */
export function rotuloDoMes(primeiroDia: string): string {
  const validada = lerData(primeiroDia);

  if (!validada.ok) return primeiroDia;

  return NOME_DO_MES.format(new Date(`${validada.valor}T00:00:00Z`));
}

/** Fração → "6,5%" com até três casas, sem zero sobrando ("6%", "6,25%"). */
export function formatarAliquota(fracao: number): string {
  if (!Number.isFinite(fracao)) return "—";

  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(fracao * 100)}%`;
}

// ─── Metas financeiras expandidas (`financial_goals`) ─────────────────────

export type TipoMetaFinanceira =
  | "faturamento_bruto"
  | "receita_liquida"
  | "lucro_liquido"
  | "margem_produto"
  | "margem_contribuicao"
  | "margem_liquida"
  | "quantidade_vendas"
  | "ticket_medio"
  | "investimento_ads"
  | "reducao_despesas"
  | "eficiencia_logistica";

export type UnidadeMetaFinanceira = "moeda" | "percentual" | "contagem";

export const TIPOS_META_FINANCEIRA: readonly {
  readonly id: TipoMetaFinanceira;
  readonly rotulo: string;
  readonly unidade: UnidadeMetaFinanceira;
  readonly dica: string;
}[] = [
  { id: "lucro_liquido", rotulo: "Lucro líquido gerencial", unidade: "moeda", dica: "Alvo mensal em R$" },
  { id: "receita_liquida", rotulo: "Receita líquida", unidade: "moeda", dica: "Alvo mensal em R$" },
  { id: "margem_produto", rotulo: "Margem do produto (%)", unidade: "percentual", dica: "Alvo em % (fórmula oficial)" },
  { id: "margem_contribuicao", rotulo: "Margem de contribuição (%)", unidade: "percentual", dica: "Alvo em %" },
  { id: "margem_liquida", rotulo: "Margem líquida final (%)", unidade: "percentual", dica: "Alvo em %" },
  { id: "quantidade_vendas", rotulo: "Quantidade de vendas", unidade: "contagem", dica: "Pedidos válidos no mês" },
  { id: "ticket_medio", rotulo: "Ticket médio", unidade: "moeda", dica: "Alvo em R$" },
  { id: "investimento_ads", rotulo: "Orçamento / Teto de Ads", unidade: "moeda", dica: "Teto mensal de investimento em R$" },
  { id: "reducao_despesas", rotulo: "Teto / Meta de despesas fixas", unidade: "moeda", dica: "Alvo mensal em R$" },
  { id: "eficiencia_logistica", rotulo: "Eficiência logística (frete % receita)", unidade: "percentual", dica: "Teto de frete % sobre a receita" },
  { id: "faturamento_bruto", rotulo: "Faturamento bruto (por conta/marca)", unidade: "moeda", dica: "Alvo mensal em R$" },
];

export type EscopoMetaFinanceira = "global" | "marketplace" | "account" | "brand";

export const ESCOPOS_META_FINANCEIRA: readonly { readonly id: EscopoMetaFinanceira; readonly rotulo: string }[] = [
  { id: "global", rotulo: "Empresa inteira (global)" },
  { id: "marketplace", rotulo: "Marketplace específico" },
  { id: "account", rotulo: "Conta específica" },
  { id: "brand", rotulo: "Marca específica" },
];

export function lerTipoMetaFinanceira(texto: string): Leitura<TipoMetaFinanceira> {
  const valor = texto.trim();
  const encontrado = TIPOS_META_FINANCEIRA.find((t) => t.id === valor);
  return encontrado !== undefined
    ? { ok: true, valor: encontrado.id }
    : { ok: false, erro: "Escolha um indicador financeiro válido." };
}

export function lerEscopoMetaFinanceira(texto: string): Leitura<EscopoMetaFinanceira> {
  const valor = texto.trim();
  const encontrado = ESCOPOS_META_FINANCEIRA.find((e) => e.id === valor);
  return encontrado !== undefined
    ? { ok: true, valor: encontrado.id }
    : { ok: false, erro: "Escolha o escopo da meta." };
}

export function unidadeMetaFinanceira(tipo: TipoMetaFinanceira): UnidadeMetaFinanceira {
  return TIPOS_META_FINANCEIRA.find((t) => t.id === tipo)?.unidade ?? "moeda";
}

export function rotuloTipoMetaFinanceira(tipo: string): string {
  return TIPOS_META_FINANCEIRA.find((t) => t.id === tipo)?.rotulo ?? tipo;
}

export function rotuloEscopoMetaFinanceira(escopo: string, referencia: string | null): string {
  const base = ESCOPOS_META_FINANCEIRA.find((e) => e.id === escopo)?.rotulo ?? escopo;
  return referencia !== null && referencia !== "" ? `${base}: ${referencia}` : base;
}

/** Lê o alvo conforme a unidade do indicador: moeda (>0), percentual (0..99,99% -> fração) ou contagem (inteiro >0). */
export function lerAlvoMetaFinanceira(texto: string, tipo: TipoMetaFinanceira): Leitura<number> {
  const unidade = unidadeMetaFinanceira(tipo);

  if (unidade === "percentual") {
    return lerPercentual(texto);
  }

  if (unidade === "contagem") {
    const n = numeroDigitado(texto);
    if (n === null || !Number.isInteger(n) || n <= 0) {
      return { ok: false, erro: "Informe uma quantidade inteira maior que zero." };
    }
    return { ok: true, valor: n };
  }

  return lerValorEmReais(texto);
}

export interface AvaliacaoMetaFinanceira {
  readonly status: "ok" | "atencao" | "perigo" | "neutro";
  readonly rotulo: string;
}

/**
 * Avalia o realizado contra o alvo de uma meta financeira respeitando a
 * polaridade de cada indicador (em teto de Ads, despesas e frete %, ficar
 * abaixo do alvo é positivo; em lucro, receita, margens, ticket e vendas,
 * atingir ou superar o alvo é positivo).
 */
export function avaliarMetaFinanceira(
  tipo: TipoMetaFinanceira,
  alvo: number,
  realizado: number | null,
): AvaliacaoMetaFinanceira {
  if (realizado === null || !Number.isFinite(realizado) || !Number.isFinite(alvo) || alvo <= 0) {
    return { status: "neutro", rotulo: "sem base atual" };
  }

  const menorMelhor = tipo === "investimento_ads" || tipo === "reducao_despesas" || tipo === "eficiencia_logistica";

  if (menorMelhor) {
    const uso = realizado / alvo;
    if (uso <= 0.9) return { status: "ok", rotulo: `${String(Math.round(uso * 100))}% do teto` };
    if (uso <= 1) return { status: "atencao", rotulo: `${String(Math.round(uso * 100))}% do teto` };
    return { status: "perigo", rotulo: `acima do teto (${String(Math.round(uso * 100))}%)` };
  }

  const atingimento = realizado / alvo;
  if (atingimento >= 1) return { status: "ok", rotulo: `${String(Math.round(atingimento * 100))}% atingido` };
  if (atingimento >= 0.85) return { status: "atencao", rotulo: `${String(Math.round(atingimento * 100))}% atingido` };
  return { status: "perigo", rotulo: `${String(Math.round(atingimento * 100))}% atingido` };
}
