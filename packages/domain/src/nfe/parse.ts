/**
 * Parser puro do XML da NF-e (modelo 55, layout 4.00) — recebe o objeto JS
 * já convertido de XML (não a string XML bruta: a biblioteca de parsing
 * fica no worker, mesmo split de `read-excel-file`/`@sb/domain/upseller`;
 * ver `apps/worker/src/xml-reader.ts`).
 *
 * Sem dependência de runtime (nem `zod`) — `@sb/domain` é lógica pura, sem
 * banco, sem rede, sem framework (`docs/ARCHITECTURE.md` secao 7); a
 * primeira versão deste arquivo usava `zod` sem declará-lo em
 * `package.json`, o que só funcionou localmente por resolução acidental do
 * pnpm e quebrou o CI (instalação limpa) — achado corrigido em 2026-08-22.
 * Validação manual, campo a campo, com um pequeno conjunto de helpers.
 *
 * Campos confirmados contra a documentação oficial, lida ao vivo em
 * 2026-08-22 (`docs/NFE.md` secao 2) e VALIDADOS contra o primeiro XML real
 * de fornecedor recebido do usuário no mesmo dia — REGRA ABSOLUTA
 * equivalente à do Mercado Livre (`docs/MERCADO_LIVRE.md`), aplicada aqui a
 * um padrão do governo brasileiro em vez de uma API de terceiro.
 *
 * `<det>` pode ser objeto único (nota com 1 item) ou array (2+ itens) no
 * XML — normalizado para array SEMPRE pelo parser bruto do worker (opção
 * `isArray` do `fast-xml-parser`), então esta função pode assumir array.
 *
 * **Ordem dos elementos no XML real não segue a sequência do XSD oficial**
 * (o exemplo real trouxe `infAdic`/`infRespTec` antes de `ide`/`emit`/
 * `det`) — provavelmente reformatado pelo serviço de consulta usado pelo
 * usuário (`meudanfe.com.br`), não o XML original transmitido à SEFAZ. Não
 * afeta este parser: acesso é por NOME de propriedade, nunca por posição.
 */

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
  /**
   * Direção DO ESTOQUE DA PRÓPRIA ORGANIZAÇÃO — não uma leitura direta de
   * `ide/tpNF` (ver `resolveOperationType` abaixo para o motivo).
   */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** String não vazia, ou `null`. Trata `undefined`/número/objeto como ausente — não lança. */
function str(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return null;
}

function decimal(value: unknown): number | null {
  const raw = str(value);

  if (raw === null) {
    return null;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : null;
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Decide ENTRADA/SAIDA comparando `emit`/`dest` do XML contra o CNPJ da
 * PRÓPRIA organização — não `ide/tpNF` sozinho.
 *
 * **Achado ao analisar o primeiro XML real de fornecedor (2026-08-22)**:
 * `tpNF` reflete a operação DO EMITENTE do documento, não da Speed Bikers.
 * Uma compra de fornecedor chega com `tpNF=1` ("saída" do lado de quem
 * vendeu) — que é o OPOSTO de "entrada no nosso estoque". Confirmado pelo
 * próprio exemplo real: `natOp="VENDA P/FORA DO ESTADO"` (nome da operação
 * do ponto de vista de quem vende) + `tpNF=1` + `emit`=fornecedor +
 * `dest`=Speed Bikers — uma COMPRA seria incorretamente classificada como
 * SAIDA se `tpNF` fosse usado diretamente. A fonte de verdade é sempre
 * "a Speed Bikers é emitente ou destinatária desta nota", nunca `tpNF`
 * isolado (ver D-053, `docs/DECISIONS.md`).
 */
function resolveOperationType(
  emitCnpj: string,
  destCnpj: string | null,
  ownCnpj: string,
): { ok: true; value: "ENTRADA" | "SAIDA" } | { ok: false; reason: string } {
  const own = onlyDigits(ownCnpj);
  const emit = onlyDigits(emitCnpj);
  const dest = destCnpj === null ? null : onlyDigits(destCnpj);

  if (dest !== null && dest === own) {
    return { ok: true, value: "ENTRADA" };
  }

  if (emit === own) {
    return { ok: true, value: "SAIDA" };
  }

  return {
    ok: false,
    reason: `nem emitente (${emitCnpj}) nem destinatário (${destCnpj ?? "ausente"}) correspondem ao CNPJ da organização`,
  };
}

function parseItem(raw: unknown, position: number): { ok: true; value: ParsedNfeItem } | { ok: false; reason: string } {
  if (!isRecord(raw)) {
    return { ok: false, reason: `item ${String(position + 1)}: formato inesperado` };
  }

  const prod = raw.prod;

  if (!isRecord(prod)) {
    return { ok: false, reason: `item ${String(position + 1)}: prod ausente` };
  }

  const supplierCode = str(prod.cProd);
  const description = str(prod.xProd);
  const unit = str(prod.uCom);
  const quantity = decimal(prod.qCom);
  const unitValue = decimal(prod.vUnCom);
  const totalValue = decimal(prod.vProd);

  if (supplierCode === null || description === null || unit === null) {
    return { ok: false, reason: `item ${String(position + 1)}: cProd/xProd/uCom ausente` };
  }

  if (quantity === null || unitValue === null || totalValue === null) {
    return { ok: false, reason: `item ${String(position + 1)}: valor numérico inválido em prod` };
  }

  const rawEan = str(prod.cEAN);
  const ean = rawEan === null || NO_GTIN_VALUES.has(rawEan.trim().toUpperCase()) ? null : rawEan;

  return {
    ok: true,
    value: {
      position,
      supplierCode,
      ean,
      description,
      ncm: str(prod.NCM),
      cfop: str(prod.CFOP),
      unit,
      quantity,
      unitValue,
      totalValue,
    },
  };
}

/**
 * `root` é o objeto devolvido pelo parser XML bruto (worker), já com `det`
 * normalizado para array. Aceita tanto o envelope `nfeProc` (NFe + protocolo
 * de autorização) quanto `NFe` sozinho — um fornecedor pode mandar só a nota,
 * sem o protocolo anexado (`docs/NFE.md` secao 2).
 *
 * `ownCnpj`: CNPJ da própria organização (`organizations.cnpj`), 14 dígitos
 * com ou sem máscara — usado para decidir a direção do movimento (ver
 * `resolveOperationType`).
 */
export function parseNfeXmlObject(root: unknown, ownCnpj: string): ParseNfeResult {
  const envelope = isRecord(root) && "nfeProc" in root ? root.nfeProc : root;

  if (!isRecord(envelope) || !isRecord(envelope.NFe) || !isRecord(envelope.NFe.infNFe)) {
    return { ok: false, reason: "XML não corresponde ao layout NF-e esperado: NFe/infNFe ausente" };
  }

  const infNFe = envelope.NFe.infNFe;

  const id = str(infNFe["@_Id"]);

  if (id === null || !/^NFe\d{44}$/.test(id)) {
    return { ok: false, reason: "XML não corresponde ao layout NF-e esperado: Id deve ser 'NFe' + 44 dígitos" };
  }

  const ide = infNFe.ide;

  if (!isRecord(ide)) {
    return { ok: false, reason: "XML não corresponde ao layout NF-e esperado: ide ausente" };
  }

  const documentNumber = str(ide.nNF);
  const series = str(ide.serie);
  const dhEmi = str(ide.dhEmi);
  const tpNF = str(ide.tpNF);

  if (documentNumber === null || series === null || dhEmi === null) {
    return { ok: false, reason: "XML não corresponde ao layout NF-e esperado: ide/nNF, serie ou dhEmi ausente" };
  }

  if (tpNF !== "0" && tpNF !== "1") {
    return { ok: false, reason: `ide/tpNF inesperado: ${tpNF ?? "ausente"} (esperado '0' ou '1')` };
  }

  const issueDate = new Date(dhEmi);

  if (Number.isNaN(issueDate.getTime())) {
    return { ok: false, reason: "ide/dhEmi não é uma data válida" };
  }

  const emit = infNFe.emit;

  if (!isRecord(emit)) {
    return { ok: false, reason: "XML não corresponde ao layout NF-e esperado: emit ausente" };
  }

  const issuerCnpj = str(emit.CNPJ);
  const issuerName = str(emit.xNome);

  if (issuerCnpj === null || issuerName === null) {
    return { ok: false, reason: "XML não corresponde ao layout NF-e esperado: emit/CNPJ ou emit/xNome ausente" };
  }

  const dest = isRecord(infNFe.dest) ? infNFe.dest : null;
  const recipientCnpj = dest === null ? null : str(dest.CNPJ);
  const recipientName = dest === null ? null : str(dest.xNome);

  const direction = resolveOperationType(issuerCnpj, recipientCnpj, ownCnpj);

  if (!direction.ok) {
    return { ok: false, reason: direction.reason };
  }

  const detRaw = infNFe.det;

  if (!Array.isArray(detRaw) || detRaw.length === 0) {
    return { ok: false, reason: "nota sem item" };
  }

  const items: ParsedNfeItem[] = [];

  for (const [index, raw] of detRaw.entries()) {
    const parsedItem = parseItem(raw, index);

    if (!parsedItem.ok) {
      return { ok: false, reason: parsedItem.reason };
    }

    items.push(parsedItem.value);
  }

  return {
    ok: true,
    value: {
      accessKey: id.slice(3),
      operationType: direction.value,
      documentNumber,
      series,
      issueDate,
      issuerCnpj,
      issuerName,
      recipientCnpj,
      recipientName,
      items,
    },
  };
}
