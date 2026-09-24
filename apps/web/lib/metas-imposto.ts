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
    if (limpo.indexOf(",") !== limpo.lastIndexOf(",")) return null;
    normal = limpo.replace(/\./g, "").replace(",", ".");
  } else if ((limpo.match(/\./g) ?? []).length > 1 || /^\d{1,3}\.\d{3}$/.test(limpo)) {
    normal = limpo.replace(/\./g, "");
  } else {
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
  if (n < 0 || n >= 100) return { ok: false, erro: "A alíquota fica entre 0% e 100%." };

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

/** Nota opcional: vazia vira `null`; mais de 300 caracteres é recusada (o CHECK do banco). */
export function lerNota(texto: string): Leitura<string | null> {
  const nota = texto.trim();

  if (nota.length > 300) return { ok: false, erro: "A nota tem mais de 300 caracteres." };

  return { ok: true, valor: nota === "" ? null : nota };
}

const NOME_DO_MES = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });

/** "2026-09-01" → "setembro de 2026". */
export function rotuloDoMes(primeiroDia: string): string {
  return NOME_DO_MES.format(new Date(`${primeiroDia}T00:00:00Z`));
}

/** Fração → "6,5%" com até três casas, sem zero sobrando ("6%", "6,25%"). */
export function formatarAliquota(fracao: number): string {
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(fracao * 100)}%`;
}
