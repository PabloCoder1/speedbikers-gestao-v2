import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const FILES = [
  "app/(app)/faturamento/multicanal.tsx",
  "app/(app)/faturamento/repasse-shopee.tsx",
  "app/(app)/vendas/shopee/devolucoes.tsx",
] as const;

describe("componentes de faturamento/vendas não vazam error.message do Postgres no DOM (D-830)", () => {
  for (const relPath of FILES) {
    it(`${relPath} não passa error.message bruto para detalhe`, () => {
      const source = readFileSync(resolve(process.cwd(), relPath), "utf8");

      expect(source).not.toMatch(/detalhe\s*=\s*\{[^}]*error\.message/u);
      expect(source).not.toMatch(/detalhe\s*:\s*[^,\n}]*error\.message/u);
    });
  }
});
