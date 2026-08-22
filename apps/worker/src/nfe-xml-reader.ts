import { Storage } from "@google-cloud/storage";
import { XMLParser } from "fast-xml-parser";

import type { NfeXmlReader } from "./handlers/nfe-import-parse.js";

/**
 * Conversão de XML bruto para objeto JS — a única peça deste fluxo que
 * conhece `fast-xml-parser`. `packages/domain/src/nfe/parse.ts` (puro)
 * recebe só o objeto já convertido, mesmo split de `read-excel-file`/
 * `@sb/domain/upseller` (`apps/worker/src/sheet-reader.ts`).
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

export function createNfeXmlReader(bucketName: string, storage = new Storage()): NfeXmlReader {
  const bucket = storage.bucket(bucketName);

  return {
    read: async (storagePath) => {
      const [buffer] = await bucket.file(storagePath).download();

      return parser.parse(buffer.toString("utf-8")) as unknown;
    },
  };
}
