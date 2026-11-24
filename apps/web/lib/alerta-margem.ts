/**
 * Alerta de venda abaixo da margem (D-858) — a peça PURA do formulário em
 * `/central/limites`: lê o que a pessoa digitou com as mesmas regras dos
 * CHECKs de `margin_alert_settings` (o erro sai ao lado do campo, não como "o
 * banco recusou") e descreve a configuração para quem só lê.
 */

export interface ConfiguracaoDoAlerta {
  readonly enabled: boolean;
  /** Frações: 0,30 = 30%. */
  readonly default_min_margin: number;
  readonly imported_min_margin: number;
  readonly imported_brands: readonly string[];
  readonly email_recipients: readonly string[];
}

/** Os padrões da migration: os do dono, de 23/11. */
export const ALERTA_PADRAO: ConfiguracaoDoAlerta = {
  enabled: true,
  default_min_margin: 0.3,
  imported_min_margin: 0.4,
  imported_brands: ["NAVETEC", "OFF RACER", "OFF VOLT"],
  email_recipients: [],
};

export type CampoDoAlerta = "enabled" | "default_min_margin" | "imported_min_margin" | "imported_brands" | "email_recipients";

export const MAX_DESTINATARIOS = 20;
const MAX_MARCAS = 50;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

/** "30", "30,5", "30%" → 0,30 / 0,305. Entre 0 e 99,99. */
function lerMeta(texto: string, rotulo: string): { ok: true; valor: number } | { ok: false; erro: string } {
  const limpo = texto.trim().replace(/%$/u, "").trim().replace(",", ".");

  if (limpo === "" || !/^-?\d+(\.\d+)?$/u.test(limpo)) {
    return { ok: false, erro: `Escreva ${rotulo} em porcentagem, como 30 ou 32,5.` };
  }

  const pct = Number(limpo);

  if (pct < 0 || pct >= 100) return { ok: false, erro: `${rotulo[0]?.toUpperCase() ?? ""}${rotulo.slice(1)} vai de 0 a 99,99%.` };

  return { ok: true, valor: Math.round(pct * 100) / 10_000 };
}

/** Uma entrada por linha, vírgula ou ponto e vírgula; sem repetir. */
function itens(texto: string, separador: RegExp): string[] {
  return texto
    .split(separador)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

export function lerFormularioDoAlerta(
  campo: (nome: CampoDoAlerta) => string,
): { readonly ok: true; readonly valores: ConfiguracaoDoAlerta } | { readonly ok: false; readonly erros: Partial<Record<CampoDoAlerta, string>> } {
  const erros: Partial<Record<CampoDoAlerta, string>> = {};

  const padrao = lerMeta(campo("default_min_margin"), "a margem mínima dos demais produtos");
  const importada = lerMeta(campo("imported_min_margin"), "a margem mínima das marcas importadas");

  if (!padrao.ok) erros.default_min_margin = padrao.erro;
  if (!importada.ok) erros.imported_min_margin = importada.erro;

  const marcas: string[] = [];

  for (const marca of itens(campo("imported_brands"), /[\n;,]+/u)) {
    const normal = marca.replace(/\s+/gu, " ").toUpperCase();

    if (!marcas.includes(normal)) marcas.push(normal);
  }

  if (marcas.length > MAX_MARCAS) erros.imported_brands = `No máximo ${String(MAX_MARCAS)} marcas.`;

  const emails: string[] = [];
  const invalidos: string[] = [];

  for (const email of itens(campo("email_recipients"), /[\s;,]+/u)) {
    const normal = email.toLowerCase();

    if (!EMAIL.test(normal) || normal.length > 254) invalidos.push(email);
    else if (!emails.includes(normal)) emails.push(normal);
  }

  if (invalidos.length > 0) {
    erros.email_recipients = `${invalidos.length === 1 ? "Este e-mail não parece válido" : "Estes e-mails não parecem válidos"}: ${invalidos.join(", ")}.`;
  } else if (emails.length > MAX_DESTINATARIOS) {
    erros.email_recipients = `No máximo ${String(MAX_DESTINATARIOS)} e-mails.`;
  }

  if (!padrao.ok || !importada.ok || Object.keys(erros).length > 0) return { ok: false, erros };

  return {
    ok: true,
    valores: {
      enabled: campo("enabled") === "on",
      default_min_margin: padrao.valor,
      imported_min_margin: importada.valor,
      imported_brands: marcas,
      email_recipients: emails,
    },
  };
}

/** A linha do banco (numeric chega como número ou texto) → a configuração; sem linha, os padrões. */
export function lerAlerta(row: Partial<Record<CampoDoAlerta, unknown>> | null): ConfiguracaoDoAlerta {
  if (row === null) return ALERTA_PADRAO;

  const numero = (v: unknown, padrao: number): number => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;

    return Number.isFinite(n) ? n : padrao;
  };
  const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  return {
    enabled: row.enabled !== false,
    default_min_margin: numero(row.default_min_margin, ALERTA_PADRAO.default_min_margin),
    imported_min_margin: numero(row.imported_min_margin, ALERTA_PADRAO.imported_min_margin),
    imported_brands: lista(row.imported_brands),
    email_recipients: lista(row.email_recipients),
  };
}

/** 0,3 → "30"; 0,325 → "32,5": o valor como a pessoa escreve no campo. */
export function metaComoTexto(fracao: number): string {
  return (Math.round(fracao * 10_000) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}
