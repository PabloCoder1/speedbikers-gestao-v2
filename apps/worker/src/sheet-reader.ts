import { Storage } from "@google-cloud/storage";
import { readSheet } from "read-excel-file/node";

import type { SheetReader } from "./handlers/erp-import-parse.js";

/**
 * Leitor de planilha do bucket `erp-imports`.
 *
 * `read-excel-file` foi escolhida no lugar do `exceljs`: 2,5 MB contra 21,8 MB
 * instalados, e o worker só precisa LER. Medido nos arquivos reais — 23.925
 * linhas em 647 ms com 176 MB de RSS, folgado nos 512 MB do container.
 *
 * Usa `readSheet`, não o export padrão: na versão 9 o padrão devolve o array de
 * planilhas, enquanto `readSheet` devolve as linhas. Os tipos declaram os dois
 * corretamente.
 *
 * Se algum dia um arquivo crescer a ponto de carregar tudo em memória doer, a
 * saída é o leitor em streaming do `exceljs` — não aumentar a memória do
 * container.
 */
export function createSheetReader(bucketName: string, storage = new Storage()): SheetReader {
  const bucket = storage.bucket(bucketName);

  return {
    read: async (storagePath) => {
      const [buffer] = await bucket.file(storagePath).download();

      return await readSheet(buffer, 1);
    },
  };
}
