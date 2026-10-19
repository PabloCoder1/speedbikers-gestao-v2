import { digitos, type DirecaoDocumento, type TipoDocumento } from "./tipos.js";

/**
 * A nota de VENDA de marketplace não baixa o estoque pela importação (D-497).
 *
 * A venda paga do Mercado Livre já baixa o estoque ao ser lida (`VENDA_ML`), e
 * a da Shopee passa a baixar com a D-495; a devolução do Mercado Livre já
 * repõe (`DEVOLUCAO_ML`). A nota fiscal da MESMA venda, importada em
 * /notas-fiscais, baixaria (ou reporia) de novo -- e a reconciliação (D-132)
 * não desfaz, porque o movimento entra no alvo e no saldo.
 *
 * O que separa "venda de marketplace" de "venda de balcão" é o INTERMEDIADOR da
 * NF-e (`ide/indIntermed` = 1 e o grupo `infIntermed`, NT 2020.006, campos
 * B25c e YB01/YB02), obrigatório desde 2021 na venda por plataforma de
 * terceiros. O dono confirmou (19/10/2026) que a empresa também vende fora dos
 * marketplaces: a nota dessas vendas é baixa legítima e continua entrando.
 *
 * As listas de CFOP são as do Anexo II do Convênio s/nº de 15/12/1970, na
 * redação do Ajuste SINIEF 03/24 (efeitos a partir de 01/06/2024), lida no
 * portal do CONFAZ em 19/10/2026 ("CFOP_CVSN_1.6.24"): todo título que começa
 * com "Venda " nos grupos 5.100, 6.100, 7.100, 5.400 e 6.400, mais o simples
 * faturamento da venda para entrega futura (5.922/6.922, que não tem saída
 * física); e a devolução dessas vendas nos grupos 1.200, 2.200, 3.200, 1.400 e
 * 2.400. Ficam de fora a venda de bem do ativo (5.551) e de combustível
 * (5.65x), que não são mercadoria da operação, e as devoluções deles.
 */

const CFOP_VENDA: ReadonlySet<string> = new Set([
  "5101", "5102", "5103", "5104", "5105", "5106", "5109", "5110", "5111", "5112", "5113", "5114", "5115",
  "5116", "5117", "5118", "5119", "5120", "5122", "5123", "5129", "5401", "5402", "5403", "5405", "5922",
  "6101", "6102", "6103", "6104", "6105", "6106", "6107", "6108", "6109", "6110", "6111", "6112", "6113",
  "6114", "6115", "6116", "6117", "6118", "6119", "6120", "6122", "6123", "6129", "6401", "6402", "6403",
  "6404", "6922", "7101", "7102", "7105", "7106", "7127", "7129",
]);

const CFOP_DEVOLUCAO_DE_VENDA: ReadonlySet<string> = new Set([
  "1201", "1202", "1203", "1204", "1212", "1410", "1411",
  "2201", "2202", "2203", "2204", "2212", "2410", "2411",
  "3201", "3202", "3211", "3212",
]);

/**
 * A RAIZ do CNPJ (8 dígitos, matriz e filiais) dos intermediadores cujas vendas
 * a V3 já baixa pelo pedido: o Mercado Livre (EBAZAR.COM.BR LTDA., 03.007.331)
 * e a Shopee (SHPS, 35.635.824). Outro intermediador (Kwai, Temu, TikTok) não
 * tem baixa pelo pedido na V3: a nota dele continua entrando, e a reconciliação
 * com a planilha do UpSeller segue valendo. Raiz que não casar só deixa a nota
 * entrar como hoje -- nunca recusa uma venda de balcão, que não tem intermediador.
 */
const INTERMEDIADORES_COM_BAIXA_PELO_PEDIDO: ReadonlyMap<string, "ML" | "SHOPEE"> = new Map([
  ["03007331", "ML"],
  ["35635824", "SHOPEE"],
]);

export type CodigoRecusaDocumento = "SAIDA_VENDA_MARKETPLACE" | "DEVOLUCAO_VENDA_MARKETPLACE" | "VENDA_PEDE_XML";

export interface RecusaDocumento {
  readonly codigo: CodigoRecusaDocumento;
  readonly motivo: string;
}

export interface DocumentoParaRecusa {
  readonly tipo: TipoDocumento;
  readonly direcao: DirecaoDocumento;
  /** CNPJ do intermediador da NF-e (YB02), só quando `indIntermed` = 1. */
  readonly intermediadorCnpj: string | null;
  readonly cfops: readonly (string | null)[];
}

/** "5.102", "5102" → "5102"; lixo de layout ("1/00 6152") não é CFOP. */
export function normalizarCfop(cfop: string | null): string | null {
  const d = digitos(cfop);

  return d.length === 4 ? d : null;
}

/** O marketplace do intermediador, quando a V3 já baixa a venda dele pelo pedido. */
export function marketplaceDoIntermediador(cnpj: string | null): "ML" | "SHOPEE" | null {
  const d = digitos(cnpj);

  return d.length === 14 ? (INTERMEDIADORES_COM_BAIXA_PELO_PEDIDO.get(d.slice(0, 8)) ?? null) : null;
}

/**
 * Por que o documento não pode mexer no estoque, ou `null` quando pode.
 *
 * O CFOP decide se a nota é de venda ou de devolução de venda pelo que ela É,
 * não pela direção que a V3 deu -- a nota de entrada própria da devolução e a
 * de saída da venda têm a casa como emitente. O pedido de saída do UpSeller e o
 * envio ao Full não têm CFOP: ficam com as regras deles (D-375).
 */
export function recusaDeVendaDeMarketplace(documento: DocumentoParaRecusa): RecusaDocumento | null {
  const cfops = documento.cfops.map(normalizarCfop).filter((c): c is string => c !== null);
  const venda = cfops.some((c) => CFOP_VENDA.has(c));
  const devolucao = cfops.some((c) => CFOP_DEVOLUCAO_DE_VENDA.has(c));

  if (!venda && !devolucao) return null;

  if (documento.tipo === "DANFE_PDF") {
    return {
      codigo: "VENDA_PEDE_XML",
      motivo:
        "nota de venda ou de devolução de venda em PDF: o DANFE não diz se a venda foi pelo marketplace — envie o XML da nota",
    };
  }

  if (documento.tipo !== "NFE_XML") return null;

  const marketplace = marketplaceDoIntermediador(documento.intermediadorCnpj);

  if (marketplace === null) return null;

  const canal = marketplace === "ML" ? "Mercado Livre" : "Shopee";

  return venda
    ? {
        codigo: "SAIDA_VENDA_MARKETPLACE",
        motivo: `nota de venda feita pelo ${canal}: o estoque já baixa pelo pedido, e a nota baixaria de novo`,
      }
    : {
        codigo: "DEVOLUCAO_VENDA_MARKETPLACE",
        motivo: `nota de devolução de venda feita pelo ${canal}: a devolução do pedido já repõe o estoque, e a nota reporia de novo`,
      };
}

/** O tipo como a coluna `documents.document_type` o guarda. */
const TIPO_DA_COLUNA: Readonly<Record<string, TipoDocumento>> = {
  NFE: "NFE_XML",
  DANFE_PDF: "DANFE_PDF",
  SAIDA_UPSELLER_PDF: "SAIDA_UPSELLER_PDF",
  ENVIO_FULL_ML_PDF: "ENVIO_FULL_ML_PDF",
};

/**
 * A mesma guarda sobre o documento JÁ GRAVADO -- a api, na confirmação, e o
 * worker, na aplicação, a repetem (cada camada se defende sozinha, como a
 * recusa do envio ao Full). Documento lido antes da guarda chega aqui sem
 * intermediador: fica com a recusa do DANFE, se for o caso, e entra como antes.
 */
export function recusaDoDocumentoGravado(documento: {
  readonly documentType: string | null;
  readonly operationType: string | null;
  readonly intermediaryCnpj: string | null;
  readonly cfops: readonly (string | null)[];
}): RecusaDocumento | null {
  const tipo = documento.documentType === null ? undefined : TIPO_DA_COLUNA[documento.documentType];

  if (tipo === undefined || (documento.operationType !== "ENTRADA" && documento.operationType !== "SAIDA")) return null;

  return recusaDeVendaDeMarketplace({
    tipo,
    direcao: documento.operationType,
    intermediadorCnpj: documento.intermediaryCnpj,
    cfops: documento.cfops,
  });
}
