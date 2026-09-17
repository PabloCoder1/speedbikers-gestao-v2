/**
 * As contas do rascunho de pedido de compra (D-368) — puras e testáveis, sem
 * React e sem banco.
 *
 * O formulário mostra um resumo ao vivo (itens, unidades, valor estimado) e
 * precisa que ele diga a MESMA coisa que o detalhe do pedido vai dizer depois
 * de salvo: item sem custo não entra na soma como zero, e é contado à parte
 * (D-254). Linha incompleta (sem SKU ou sem quantidade) não entra em nada —
 * é a mesma regra do envio, que a descarta.
 */

export interface ItemRascunho {
  readonly key: string;
  readonly skuId: string | null;
  readonly skuSnapshot: string;
  readonly quantityOrdered: string;
  readonly unitCost: string;
}

export interface ResumoRascunho {
  /** Linhas com SKU e quantidade válida — as que serão gravadas. */
  readonly itens: number;
  readonly unidades: number;
  /** Soma de quantidade × custo das linhas COM custo. `null` quando há itens e nenhum tem custo. */
  readonly valor: number | null;
  readonly semCusto: number;
  /** Linhas preenchidas pela metade (SKU sem quantidade ou vice-versa). */
  readonly incompletas: number;
  /** Chaves das linhas cujo SKU catalogado aparece mais de uma vez. */
  readonly duplicadas: ReadonlySet<string>;
}

/** Número digitado em campo `type="number"`: vazio, NaN ou ≤ 0 é ausência. */
export function numeroPositivo(valor: string): number | null {
  if (valor.trim() === "") return null;

  const n = Number(valor);

  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Custo aceita zero (brinde, bonificação); vazio ou negativo é ausência. */
export function custoInformado(valor: string): number | null {
  if (valor.trim() === "") return null;

  const n = Number(valor);

  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function subtotal(item: Pick<ItemRascunho, "quantityOrdered" | "unitCost">): number | null {
  const qtd = numeroPositivo(item.quantityOrdered);
  const custo = custoInformado(item.unitCost);

  return qtd === null || custo === null ? null : Math.round(qtd * custo * 100) / 100;
}

export function resumirRascunho(itens: readonly ItemRascunho[]): ResumoRascunho {
  let validos = 0;
  let unidades = 0;
  let valor = 0;
  let comCusto = 0;
  let semCusto = 0;
  let incompletas = 0;

  const porSku = new Map<string, string[]>();

  for (const item of itens) {
    const temSku = item.skuSnapshot.trim() !== "";
    const qtd = numeroPositivo(item.quantityOrdered);

    if (!temSku && item.quantityOrdered.trim() === "" && item.unitCost.trim() === "") continue;

    if (!temSku || qtd === null) {
      incompletas += 1;
      continue;
    }

    validos += 1;
    unidades += qtd;

    const linha = subtotal(item);

    if (linha === null) semCusto += 1;
    else {
      comCusto += 1;
      valor += linha;
    }

    if (item.skuId !== null) porSku.set(item.skuId, [...(porSku.get(item.skuId) ?? []), item.key]);
  }

  const duplicadas = new Set<string>();

  for (const chaves of porSku.values()) {
    if (chaves.length > 1) for (const chave of chaves) duplicadas.add(chave);
  }

  return {
    itens: validos,
    unidades: Math.round(unidades * 1000) / 1000,
    valor: validos > 0 && comCusto === 0 ? null : Math.round(valor * 100) / 100,
    semCusto,
    incompletas,
    duplicadas,
  };
}

export interface LinhaColada {
  readonly sku: string;
  readonly quantidade: number | null;
  readonly custo: number | null;
}

/** "10,50" e "10.50" são o mesmo custo; "1.234,56" também. */
function numeroBr(valor: string | undefined): number | null {
  if (valor === undefined) return null;

  let texto = valor.trim().replace(/^R\$\s*/i, "");

  if (texto === "") return null;
  if (texto.includes(",")) texto = texto.replace(/\./g, "").replace(",", ".");

  const n = Number(texto);

  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * "Colar lista": uma linha por item, `SKU  quantidade  custo`, separados por
 * tabulação (planilha), ponto e vírgula ou espaços. Só o SKU é obrigatório.
 * Linha vazia é ignorada; SKU repetido SOMA a quantidade na primeira
 * ocorrência — colar a mesma planilha duas vezes não pode virar duas linhas do
 * mesmo produto.
 */
export function lerListaColada(texto: string, limite = 100): LinhaColada[] {
  const porSku = new Map<string, { sku: string; quantidade: number | null; custo: number | null }>();

  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();

    if (linha === "") continue;

    const partes = linha.split(/\t|;|\s{1,}/).filter((p) => p !== "");
    const sku = partes[0];

    if (sku === undefined) continue;

    // Cabeçalho de planilha ("SKU  Quantidade  Custo") não é item.
    if (/^sku$/i.test(sku) && partes.slice(1).every((p) => Number.isNaN(Number(p.replace(",", "."))))) continue;

    const chave = sku.toUpperCase();
    const quantidade = numeroBr(partes[1]);
    const custo = numeroBr(partes[2]);
    const atual = porSku.get(chave);

    if (atual === undefined) {
      if (porSku.size >= limite) break;
      porSku.set(chave, { sku, quantidade: quantidade !== null && quantidade > 0 ? quantidade : null, custo });
    } else {
      if (quantidade !== null && quantidade > 0) atual.quantidade = (atual.quantidade ?? 0) + quantidade;
      atual.custo ??= custo;
    }
  }

  return [...porSku.values()];
}

/** Data de negócio `AAAA-MM-DD` de hoje em São Paulo — a mesma régua do overview de compras. */
export function hojeSaoPaulo(agora: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}

/** Soma dias a uma data de negócio, sem fuso: a conta é de calendário. */
export function somarDias(data: string, dias: number): string {
  const [ano, mes, dia] = data.split("-").map(Number) as [number, number, number];
  const d = new Date(Date.UTC(ano, mes - 1, dia + dias));

  return d.toISOString().slice(0, 10);
}

/** Dias de calendário entre duas datas de negócio (`b - a`). */
export function diasEntre(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);

  return Math.round(ms / 86_400_000);
}

/** "hoje", "amanhã", "em 15 dias", "há 3 dias" — o prazo ao lado da data escolhida. */
export function prazoPorExtenso(dias: number): string {
  if (dias === 0) return "hoje";
  if (dias === 1) return "amanhã";
  if (dias === -1) return "ontem";

  return dias > 0 ? `em ${String(dias)} dias` : `há ${String(-dias)} dias`;
}
