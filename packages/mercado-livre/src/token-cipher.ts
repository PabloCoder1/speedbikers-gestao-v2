import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Cifra dos tokens do Mercado Livre em repouso (D-046).
 *
 * `ml_credentials.access_token_ciphertext`/`refresh_token_ciphertext` guardam
 * o resultado de `encryptToken`; nunca o texto claro. A chave nunca é lida do
 * banco — vem do Secret Manager em produção, de `.env.local` localmente
 * (`docs/ARCHITECTURE.md` secao 18).
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Decodifica a chave de `MERCADO_LIVRE_...`/`ML_TOKEN_ENCRYPTION_KEY` (base64)
 * e confere o tamanho ANTES de qualquer cifra — uma chave curta silenciosamente
 * aceita pelo Node só falharia na hora de decifrar, longe da causa.
 */
export function loadEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");

  if (key.byteLength !== KEY_BYTES) {
    throw new Error(
      `ML_TOKEN_ENCRYPTION_KEY precisa decodificar para ${String(KEY_BYTES)} bytes (AES-256); recebeu ${String(key.byteLength)}.`,
    );
  }

  return key;
}

/**
 * Cifra um token com AES-256-GCM. IV aleatório por chamada — nunca reaproveitado.
 *
 * Saída: base64(iv || authTag || ciphertext), um único campo `text`, compatível
 * com as colunas `*_ciphertext` de `ml_credentials`.
 */
export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decifra um token gravado por `encryptToken`.
 *
 * O `authTag` do GCM detecta chave errada ou ciphertext corrompido/adulterado
 * — `decipher.final()` lança nesses casos, nunca devolve texto incorreto em
 * silêncio.
 */
export function decryptToken(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
