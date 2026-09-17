/**
 * A triagem dos arquivos ANTES de subir (D-375) — pura, sem React.
 *
 * O que decide de verdade é a `api`, que olha os primeiros bytes
 * (`formatoDoArquivo` em `apps/api/src/nfe-import.ts`). Aqui a checagem é de
 * cortesia: dizer "isto é uma planilha" na hora, em vez de gastar o envio de 20
 * MB para receber a mesma recusa depois.
 *
 * Por isso ela é frouxa de propósito — **um arquivo aceito aqui ainda pode ser
 * recusado lá**, e o texto da tela nunca promete o contrário.
 */

/** O mesmo teto da `api` (`MAX_PDF_UPLOAD_BYTES`). */
export const MAX_BYTES = 20 * 1024 * 1024;

export interface ArquivoTriado {
  readonly nome: string;
  readonly bytes: number;
  /** `null` quando a extensão e o tipo não dizem qual é — o envio segue mesmo assim. */
  readonly formato: "XML" | "PDF" | null;
  /** Preenchido só quando o arquivo NÃO deve subir. */
  readonly recusa: string | null;
}

const EXTENSAO = /\.([a-z0-9]+)$/i;

/** "1,4 MB" — o tamanho como quem envia o lê. */
export function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;

  const kb = bytes / 1024;

  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0).replace(".", ",")} kB`;

  const mb = kb / 1024;

  return `${mb.toFixed(mb < 10 ? 1 : 0).replace(".", ",")} MB`;
}

export function triar(arquivo: { name: string; size: number; type: string }): ArquivoTriado {
  const extensao = EXTENSAO.exec(arquivo.name)?.[1]?.toLowerCase() ?? null;
  const tipo = arquivo.type.toLowerCase();

  const formato: "XML" | "PDF" | null =
    extensao === "pdf" || tipo === "application/pdf"
      ? "PDF"
      : extensao === "xml" || tipo.includes("xml")
        ? "XML"
        : null;

  const base = { nome: arquivo.name, bytes: arquivo.size, formato };

  if (arquivo.size === 0) {
    return { ...base, recusa: "arquivo vazio" };
  }

  if (arquivo.size > MAX_BYTES) {
    return { ...base, recusa: `acima de ${tamanhoLegivel(MAX_BYTES)}` };
  }

  /*
    Extensão que claramente não é documento: planilha do UpSeller tem tela
    própria (`/importacoes`), e imagem de tela não tem texto para ler.
  */
  if (formato === null && extensao !== null && ["xlsx", "xls", "csv", "png", "jpg", "jpeg", "zip"].includes(extensao)) {
    return {
      ...base,
      recusa: extensao === "xlsx" || extensao === "xls" || extensao === "csv"
        ? "planilha vai em Importações, não aqui"
        : "não é XML nem PDF",
    };
  }

  return { ...base, recusa: null };
}
