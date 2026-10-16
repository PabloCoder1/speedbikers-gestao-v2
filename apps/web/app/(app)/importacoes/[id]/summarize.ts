/**
 * Resumo legível da linha lida do arquivo.
 *
 * A conferência mostra o que o sistema ENTENDEU, não o que estava escrito. É
 * essa diferença que a tela existe para revelar: se o preço `174,90` virou
 * `17490`, a planilha continua certa e só o resumo denuncia.
 *
 * O `payload` chega como `jsonb`, portanto `unknown` de verdade — foi gravado
 * por uma versão anterior do parser e pode não ter o formato de hoje. Por isso
 * cada campo é lido com verificação, e um formato inesperado degrada para uma
 * linha vazia em vez de derrubar a página.
 */

const MONEY = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const DECIMAL = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });

type Payload = Record<string, unknown>;

function asObject(value: unknown): Payload | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : null;
}

function text(payload: Payload, key: string): string | null {
  const value = payload[key];

  return typeof value === "string" && value !== "" ? value : null;
}

function num(payload: Payload, key: string): number | null {
  const value = payload[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function join(parts: (string | null)[]): string {
  const kept = parts.filter((part): part is string => part !== null);

  return kept.length === 0 ? "—" : kept.join(" · ");
}

function money(payload: Payload, key: string, label: string): string | null {
  const value = num(payload, key);

  return value === null ? null : `${label} ${MONEY.format(value)}`;
}

function quantity(payload: Payload, key: string, label: string): string | null {
  const value = num(payload, key);

  return value === null ? null : `${label} ${DECIMAL.format(value)}`;
}

function summarizeLink(payload: Payload): string {
  const ref = asObject(payload.ref);

  const target =
    ref === null
      ? null
      : ref.kind === "USER_PRODUCT"
        ? text(ref, "userProductId")
        : join([text(ref, "itemId"), text(ref, "variationId")]);

  return join([text(payload, "storeLabel"), target]);
}

export function summarize(kind: string, rawPayload: unknown): string {
  const payload = asObject(rawPayload);

  if (payload === null) return "—";

  if (kind === "PRODUCTS") {
    return join([
      text(payload, "title"),
      text(payload, "brand"),
      money(payload, "retailPrice", "venda"),
      money(payload, "purchaseCost", "custo"),
      payload.isDiscontinued === true ? "estoque inativo" : null,
    ]);
  }

  if (kind === "KITS") {
    return join([
      text(payload, "componentSku"),
      quantity(payload, "quantity", "x"),
      text(payload, "kitTitle"),
    ]);
  }

  if (kind === "LINKS") {
    return summarizeLink(payload);
  }

  // STOCK
  return join([
    text(payload, "warehouse"),
    quantity(payload, "onHand", "atual"),
    quantity(payload, "available", "disponível"),
    quantity(payload, "reserved", "reservado"),
    money(payload, "averageCost", "custo médio"),
  ]);
}
