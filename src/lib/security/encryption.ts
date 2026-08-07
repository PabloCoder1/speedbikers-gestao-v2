import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM =
  "aes-256-gcm";

const VERSION =
  "v1";

function getEncryptionKey() {
  const encodedKey =
    process.env.APP_ENCRYPTION_KEY;

  if (!encodedKey) {
    throw new Error(
      "APP_ENCRYPTION_KEY não está configurada.",
    );
  }

  const key =
    Buffer.from(
      encodedKey,
      "base64",
    );

  if (key.length !== 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY deve possuir exatamente 32 bytes.",
    );
  }

  return key;
}

export function encryptSecret(
  plaintext: string,
) {
  const key =
    getEncryptionKey();

  const iv =
    randomBytes(12);

  const cipher =
    createCipheriv(
      ALGORITHM,
      key,
      iv,
    );

  const encrypted =
    Buffer.concat([
      cipher.update(
        plaintext,
        "utf8",
      ),
      cipher.final(),
    ]);

  const tag =
    cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString(
      "base64url",
    ),
  ].join(".");
}

export function decryptSecret(
  payload: string,
) {
  const parts =
    payload.split(".");

  if (
    parts.length !== 4 ||
    parts[0] !== VERSION
  ) {
    throw new Error(
      "Formato de segredo criptografado inválido.",
    );
  }

  const [
    ,
    encodedIv,
    encodedTag,
    encodedCiphertext,
  ] = parts;

  const key =
    getEncryptionKey();

  const iv =
    Buffer.from(
      encodedIv,
      "base64url",
    );

  const tag =
    Buffer.from(
      encodedTag,
      "base64url",
    );

  const ciphertext =
    Buffer.from(
      encodedCiphertext,
      "base64url",
    );

  const decipher =
    createDecipheriv(
      ALGORITHM,
      key,
      iv,
    );

  decipher.setAuthTag(tag);

  const decrypted =
    Buffer.concat([
      decipher.update(
        ciphertext,
      ),
      decipher.final(),
    ]);

  return decrypted.toString(
    "utf8",
  );
}