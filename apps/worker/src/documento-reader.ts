import { Storage } from "@google-cloud/storage";
import { XMLParser } from "fast-xml-parser";

import type { DocumentoReader } from "./handlers/nfe-import-parse.js";

/**
 * O arquivo do documento, vindo do bucket — a borda deste fluxo.
 *
 * Duas formas, porque são dois formatos (D-375):
 *
 *   `lerXml`    converte o XML em objeto aqui, e só o objeto chega ao parser
 *               puro (`packages/domain/src/nfe/parse.ts`). Esta é a única peça
 *               que conhece `fast-xml-parser`, mesmo split de
 *               `read-excel-file`/`@sb/domain/upseller` (`sheet-reader.ts`).
 *   `lerBytes`  devolve os bytes como estão. O PDF é aberto em
 *               `documentos/pdf-texto.ts` (zlib, sem dependência nova) e só as
 *               linhas posicionadas chegam ao domínio.
 *
 * `isArray` força `det` (item da nota) a ser SEMPRE array, mesmo com um
 * item só — sem isso, uma NF-e de item único produziria um objeto em vez de
 * array de 1, e o parser puro precisaria tratar os dois formatos. Resolver
 * aqui, na borda, evita essa armadilha clássica de conversão XML->JSON em
 * qualquer lugar que consumir o resultado.
 *
 * `parseTagValue: false`: números continuam string (`"100.0000"`, não
 * `100`). Conversão automática destruiria campos que PARECEM número mas são
 * texto (`cProd`, `cNF`) — a conversão explícita, campo a campo, fica no
 * parser puro, que sabe exatamente quais campos são numéricos de verdade.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  isArray: (tagName) => tagName === "det",
});

export function createDocumentoReader(bucketName: string, storage = new Storage()): DocumentoReader {
  const bucket = storage.bucket(bucketName);
  const baixar = async (storagePath: string): Promise<Buffer> => {
    const [buffer] = await bucket.file(storagePath).download();

    return buffer;
  };

  return {
    lerXml: async (storagePath) => parser.parse((await baixar(storagePath)).toString("utf-8")) as unknown,
    lerBytes: async (storagePath) => new Uint8Array(await baixar(storagePath)),
  };
}
