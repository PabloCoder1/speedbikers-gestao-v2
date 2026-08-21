import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptToken, encryptToken, loadEncryptionKey } from "./token-cipher.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

describe("loadEncryptionKey", () => {
  it("decodifica uma chave base64 de 32 bytes", () => {
    const key = loadEncryptionKey(KEY.toString("base64"));

    expect(key.byteLength).toBe(32);
    expect(key.equals(KEY)).toBe(true);
  });

  it("rejeita chave curta em vez de aceitar em silêncio", () => {
    expect(() => loadEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("rejeita chave longa", () => {
    expect(() => loadEncryptionKey(randomBytes(48).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("encryptToken / decryptToken", () => {
  it("decifra exatamente o texto cifrado", () => {
    const plaintext = "APP_USR-123456-090515-abcdef-1234567";
    const ciphertext = encryptToken(plaintext, KEY);

    expect(decryptToken(ciphertext, KEY)).toBe(plaintext);
  });

  it("nunca deixa o texto claro reconhecível no ciphertext", () => {
    const plaintext = "TG-5b9032b4e23464aed1f959f-1234567";
    const ciphertext = encryptToken(plaintext, KEY);

    expect(ciphertext).not.toContain(plaintext);
    expect(ciphertext.toLowerCase()).not.toContain(Buffer.from(plaintext).toString("base64").toLowerCase());
  });

  it("produz um ciphertext diferente a cada chamada, mesmo texto e chave — IV aleatório", () => {
    const plaintext = "mesmo-token";

    expect(encryptToken(plaintext, KEY)).not.toBe(encryptToken(plaintext, KEY));
  });

  it("recusa decifrar com a chave errada — authTag do GCM pega isso", () => {
    const ciphertext = encryptToken("segredo", KEY);

    expect(() => decryptToken(ciphertext, OTHER_KEY)).toThrow();
  });

  it("recusa decifrar ciphertext adulterado", () => {
    const ciphertext = encryptToken("segredo", KEY);
    const raw = Buffer.from(ciphertext, "base64");

    // Vira o último byte do ciphertext em si (depois de iv + authTag).
    raw[raw.byteLength - 1] = (raw[raw.byteLength - 1] ?? 0) ^ 0xff;

    expect(() => decryptToken(raw.toString("base64"), KEY)).toThrow();
  });
});
