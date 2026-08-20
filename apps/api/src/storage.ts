import { Storage } from "@google-cloud/storage";

import type { FileStore } from "./erp-import.js";

/**
 * Bucket `erp-imports` no Cloud Storage.
 *
 * O arquivo do ERP nunca vira coluna do Postgres — mesma regra do payload bruto
 * do Mercado Livre (D-015). O banco guarda o caminho e o hash; o conteúdo fica
 * no bucket, com acesso concedido por bucket à service account do serviço.
 */
export function createFileStore(bucketName: string, storage = new Storage()): FileStore {
  const bucket = storage.bucket(bucketName);

  return {
    upload: async (path, body, contentType) => {
      await bucket.file(path).save(Buffer.from(body), {
        contentType,
        // `resumable` desligado: os arquivos são pequenos e o upload em uma
        // requisição evita o estado intermediário de uma sessão retomável.
        resumable: false,
      });
    },
  };
}
