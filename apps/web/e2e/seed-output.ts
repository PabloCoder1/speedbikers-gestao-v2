/**
 * Forma dos IDs que `seed.ts` grava depois de popular o Supabase local, e o
 * caminho fixo onde ele grava — compartilhado entre o seed (escreve) e os
 * specs (leem) sem que os specs precisem importar `seed.ts` (que roda
 * `main()` no top level).
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SeedOutput {
  organizationId: string;
  userId: string;
  skuId: string;
  skuCode: string;
  documentId: string;
  documentItemId: number;
}

export const SEED_OUTPUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), ".seed-output.json");

export async function readSeedOutput(): Promise<SeedOutput> {
  const raw = await readFile(SEED_OUTPUT_PATH, "utf-8");

  return JSON.parse(raw) as SeedOutput;
}
