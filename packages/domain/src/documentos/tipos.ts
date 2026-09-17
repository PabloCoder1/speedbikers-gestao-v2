/**
 * O que a V3 sabe ler de um documento de estoque (D-375).
 *
 * São quatro layouts, e os quatro respondem à MESMA pergunta: que itens
 * entraram ou saíram, e em que quantidade.
 *
 *   NFE_XML             o XML da NF-e (o caminho de sempre, D-053)
 *   DANFE_PDF           o PDF da mesma nota, quando só ele chega
 *   SAIDA_UPSELLER_PDF  "Pedido de Saída" impresso do UpSeller
 *   ENVIO_FULL_ML_PDF   "instruções de preparação" do envio ao Full
 *
 * **O XML continua sendo o preferido, e a tela diz isso.** Ele traz CNPJ,
 * chave, CFOP e valores conferidos pela SEFAZ; o PDF traz o que o emissor
 * imprimiu. Quando os dois chegam, vale o XML.
 */

/**
 * O texto de um PDF, já EXTRAÍDO — o domínio não abre arquivo.
 *
 * A extração usa `zlib` e mora no worker (`apps/worker/src/documentos`), pelo
 * mesmo motivo que o XML é convertido lá e só o objeto chega aqui: este pacote
 * é puro e roda também no navegador. O que o domínio recebe é a página já em
 * pedaços posicionados.
 */
export interface CelulaPdf {
  readonly x: number;
  readonly texto: string;
}

export interface PedacoPdf {
  /** Índice do stream de conteúdo — na prática, a página. */
  readonly pagina: number;
  readonly x: number;
  readonly y: number;
  readonly texto: string;
}

export interface LinhaPdf {
  readonly pagina: number;
  readonly y: number;
  /** As células da linha, da esquerda para a direita. */
  readonly celulas: readonly CelulaPdf[];
  /** As células juntas — o jeito mais simples de casar um rótulo. */
  readonly texto: string;
}

export type TipoDocumento = "NFE_XML" | "DANFE_PDF" | "SAIDA_UPSELLER_PDF" | "ENVIO_FULL_ML_PDF";

export type DirecaoDocumento = "ENTRADA" | "SAIDA";

export interface ItemLido {
  /** Posição na origem, começando em 1 — é ela que casa com `document_items.position`. */
  readonly posicao: number;
  /** O código do item NA ORIGEM: `cProd` da NF-e, o SKU impresso do UpSeller, o SKU do anúncio no ML. */
  readonly codigo: string;
  readonly descricao: string;
  readonly quantidade: number;
  readonly unidade: string | null;
  readonly ean: string | null;
  /** Classificação fiscal — só NF-e e DANFE trazem; documento de separação, não. */
  readonly ncm: string | null;
  readonly cfop: string | null;
  /** Nulo quando o documento não traz valor — pedido de saída e envio ao Full não trazem. */
  readonly valorUnitario: number | null;
  readonly valorTotal: number | null;
}

export interface DocumentoLido {
  readonly tipo: TipoDocumento;
  readonly direcao: DirecaoDocumento;
  /** Número do documento: `nNF`, "OUT12467", "#77036991". */
  readonly numero: string | null;
  readonly serie: string | null;
  /** 44 dígitos — só NF-e/DANFE têm. */
  readonly chave: string | null;
  /** ISO 8601 quando o documento traz data; nulo quando não traz. */
  readonly emitidoEm: string | null;
  readonly emitenteCnpj: string | null;
  readonly emitenteNome: string | null;
  /**
   * A linha que explica o documento a quem confere: o armazém e a observação do
   * pedido de saída, o número do envio no Full. Vai para a tela, não para o
   * ledger.
   */
  readonly referencia: string | null;
  readonly itens: readonly ItemLido[];
}

export type LeituraDocumento =
  | { readonly ok: true; readonly valor: DocumentoLido }
  | { readonly ok: false; readonly motivo: string };

/** "1.000,0000" e "7,9541" — o formato brasileiro que os três PDFs usam. */
export function numeroBr(bruto: string | undefined): number | null {
  if (bruto === undefined) return null;

  const limpo = bruto.replace(/[^\d.,-]/g, "").trim();

  if (limpo === "") return null;

  // Ponto é separador de milhar; vírgula é decimal.
  const normalizado = limpo.replace(/\./g, "").replace(",", ".");
  const valor = Number.parseFloat(normalizado);

  return Number.isFinite(valor) ? valor : null;
}

/** Só os dígitos — CNPJ, chave de acesso e EAN chegam com pontuação variada. */
export function digitos(bruto: string | null | undefined): string {
  return (bruto ?? "").replace(/\D/g, "");
}
