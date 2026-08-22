import { z } from "zod";

/**
 * Parser puro do XML da NF-e (modelo 55, layout 4.00) — recebe o objeto JS
 * já convertido de XML (não a string XML bruta: a biblioteca de parsing
 * fica no worker, mesmo split de `read-excel-file`/`@sb/domain/upseller`;
 * ver `apps/worker/src/xml-reader.ts`).
 *
 * Campos confirmados contra a documentação oficial, lida ao vivo em
 * 2026-08-22 (`docs/NFE.md` secao 2) — REGRA ABSOLUTA equivalente à do
 * Mercado Livre (`docs/MERCADO_LIVRE.md`), aplicada aqui a um padrão do
 * governo brasileiro em vez de uma API de terceiro. Não confirmado ainda:
 * XML real de fornecedor da Speed Bikers (`docs/NFE.md` secao 3) — este
 * parser segue o layout oficial, mas pode precisar de ajuste quando um
 * arquivo real aparecer (encoding, campos opcionais preenchidos de forma
 * inesperada por um emissor específico).
 *
 * `<det>` pode ser objeto único (nota com 1 item) ou array (2+ itens) no
 * XML — normalizado para array SEMPRE pelo parser bruto do worker (opção
 * `isArray` do `fast-xml-parser`), então esta função pode assumir array.
 */

const itemSchema = z.object({
  "@_nItem": z.string().min(1),
  prod: z.object({
    cProd: z.string().min(1),
    cEAN: z.string(),
    xProd: z.string().min(1),
    NCM: z.string().optional(),
    CFOP: z.string().optional(),
    uCom: z.string().min(1),
    qCom: z.string().min(1),
    vUnCom: z.string().min(1),
    vProd: z.string().min(1),
  }),
});

const infNFeSchema = z.object({
  "@_Id": z.string().regex(/^NFe\d{44}$/, "Id deve ser 'NFe' + 44 dígitos"),
  ide: z.object({
    nNF: z.string().min(1),
    serie: z.string().min(1),
    dhEmi: z.string().min(1),
    /** `0` = entrada, `1` = saída — `docs/NFE.md` secao 2.2. */
    tpNF: z.enum(["0", "1"]),
  }),
  emit: z.object({
    CNPJ: z.string().min(1),
    xNome: z.string().min(1),
  }),
  dest: z
    .object({
      CNPJ: z.string().optional(),
      xNome: z.string().optional(),
    })
    .optional(),
  det: z.array(itemSchema).min(1, "nota sem item"),
});

const nfeRootSchema = z.object({
  NFe: z.object({
    infNFe: infNFeSchema,
  }),
});

export interface ParsedNfeItem {
  readonly position: number;
  /** Código do produto NO FORNECEDOR — texto livre, sem padrão entre emissores (`docs/NFE.md` secao 3). */
  readonly supplierCode: string;
  /** `null` quando o item não tem código de barras (`cEAN` = "SEM GTIN" ou vazio). */
  readonly ean: string | null;
  readonly description: string;
  readonly ncm: string | null;
  readonly cfop: string | null;
  readonly unit: string;
  readonly quantity: number;
  readonly unitValue: number;
  readonly totalValue: number;
}

export interface ParsedNfe {
  /** 44 dígitos, sem o prefixo "NFe" do atributo `Id`. */
  readonly accessKey: string;
  readonly operationType: "ENTRADA" | "SAIDA";
  readonly documentNumber: string;
  readonly series: string;
  readonly issueDate: Date;
  readonly issuerCnpj: string;
  readonly issuerName: string;
  readonly recipientCnpj: string | null;
  readonly recipientName: string | null;
  readonly items: readonly ParsedNfeItem[];
}

export type ParseNfeResult = { ok: true; value: ParsedNfe } | { ok: false; reason: string };

const NO_GTIN_VALUES = new Set(["SEM GTIN", ""]);

function parseDecimal(raw: string): number | null {
  const value = Number(raw);

  return Number.isFinite(value) ? value : null;
}

/**
 * `root` é o objeto devolvido pelo parser XML bruto (worker), já com `det`
 * normalizado para array. Aceita tanto o envelope `nfeProc` (NFe + protocolo
 * de autorização) quanto `NFe` sozinho — um fornecedor pode mandar só a nota,
 * sem o protocolo anexado (`docs/NFE.md` secao 2).
 */
export function parseNfeXmlObject(root: unknown): ParseNfeResult {
  const envelope = typeof root === "object" && root !== null && "nfeProc" in root ? root.nfeProc : root;

  const parsed = nfeRootSchema.safeParse(envelope);

  if (!parsed.success) {
    return { ok: false, reason: `XML não corresponde ao layout NF-e esperado: ${parsed.error.issues[0]?.message ?? "formato inválido"}` };
  }

  const { infNFe } = parsed.data.NFe;
  const accessKey = infNFe["@_Id"].slice(3);

  const items: ParsedNfeItem[] = [];

  for (const [index, item] of infNFe.det.entries()) {
    const quantity = parseDecimal(item.prod.qCom);
    const unitValue = parseDecimal(item.prod.vUnCom);
    const totalValue = parseDecimal(item.prod.vProd);

    if (quantity === null || unitValue === null || totalValue === null) {
      return { ok: false, reason: `item ${String(index + 1)}: valor numérico inválido em prod` };
    }

    items.push({
      position: index,
      supplierCode: item.prod.cProd,
      ean: NO_GTIN_VALUES.has(item.prod.cEAN.trim().toUpperCase()) ? null : item.prod.cEAN,
      description: item.prod.xProd,
      ncm: item.prod.NCM ?? null,
      cfop: item.prod.CFOP ?? null,
      unit: item.prod.uCom,
      quantity,
      unitValue,
      totalValue,
    });
  }

  const issueDate = new Date(infNFe.ide.dhEmi);

  if (Number.isNaN(issueDate.getTime())) {
    return { ok: false, reason: "ide/dhEmi não é uma data válida" };
  }

  return {
    ok: true,
    value: {
      accessKey,
      operationType: infNFe.ide.tpNF === "0" ? "ENTRADA" : "SAIDA",
      documentNumber: infNFe.ide.nNF,
      series: infNFe.ide.serie,
      issueDate,
      issuerCnpj: infNFe.emit.CNPJ,
      issuerName: infNFe.emit.xNome,
      recipientCnpj: infNFe.dest?.CNPJ ?? null,
      recipientName: infNFe.dest?.xNome ?? null,
      items,
    },
  };
}
