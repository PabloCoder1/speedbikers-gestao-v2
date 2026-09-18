import { readdirSync, readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O CHECK de `stock_movements.movement_type` contra quem grava no ledger — sem banco.
 *
 * **Por que existe.** O CHECK nao e alterado, e RECRIADO inteiro
 * (`drop constraint` + `add constraint ... check (movement_type in (...))`). Duas
 * frentes que abrem um tipo cada uma, em migrations diferentes, nao conflitam no
 * merge: a que roda por ultimo reescreve a lista SEM o tipo da outra. Foi o que a
 * primeira versao de `20260918000000` (D-352) fazia com o `SAIDA_DOCUMENTO` da
 * `20260917230000` (D-375): com linha dele no banco, o `add constraint` aborta com
 * 23514; sem linha, passa calado, e todo documento de saida aplicado depois leva
 * 23514 no `nfe-import-apply` e trava na fila. Nenhum teste de integracao pegaria
 * a forma calada — ele parte de um banco novo, sem a linha.
 *
 * Este teste le o CHECK que VALE (o do ultimo arquivo que o recria, na ordem em
 * que o `supabase db push` aplica) e exige nele todo tipo que o codigo grava.
 */

const RAIZ = new URL("../../../", import.meta.url);
const MIGRATIONS = new URL("supabase/migrations/", RAIZ);

/**
 * Literais com cara de tipo de movimento que NAO sao tipo de movimento. Cada um
 * com o motivo: a lista e curta de proposito, e quem acrescentar aqui precisa
 * dizer por que o valor nunca vai para `stock_movements`.
 */
const NAO_SAO_MOVIMENTO: Readonly<Record<string, string>> = {
  // `documents.document_type` (D-375): o tipo do DOCUMENTO de onde a saida veio,
  // e nao o do movimento, que e `SAIDA_DOCUMENTO`.
  SAIDA_UPSELLER_PDF: "tipo de documento (D-375)",
};

/**
 * Os tipos que o codigo grava hoje, e onde. Conferido nos dois sentidos: o tipo
 * tem de estar no CHECK, e o arquivo tem de conter o literal — uma lista que
 * mente sobre o escritor deixaria de proteger o tipo que ele grava de verdade.
 */
const TIPOS_GRAVADOS: Readonly<Record<string, string>> = {
  VENDA_ML: "apps/worker/src/handlers/persist-order.ts",
  CANCELAMENTO_ML: "apps/worker/src/handlers/persist-order.ts",
  DEVOLUCAO_ML: "apps/worker/src/handlers/claim-return.ts",
  ESTORNO_PRE_CAPTURA: "apps/worker/src/handlers/persist-order.ts",
  ESTORNO_REVERSAO_EXCEDENTE: "apps/worker/src/handlers/persist-order.ts",
  ESTORNO_FULL: "apps/worker/src/handlers/persist-order.ts",
  ENTRADA_NFE: "apps/worker/src/handlers/nfe-import-apply.ts",
  SAIDA_NFE: "apps/worker/src/handlers/nfe-import-apply.ts",
  SAIDA_DOCUMENTO: "apps/worker/src/handlers/nfe-import-apply.ts",
  AJUSTE_RECONCILIACAO: "apps/worker/src/handlers/reconcile-balances.ts",
};

/** Os prefixos do vocabulario de `movement_type` — o filtro da varredura dos fontes. */
const PADRAO_DE_TIPO = /"((?:ENTRADA|SAIDA|VENDA|CANCELAMENTO|DEVOLUCAO|AJUSTE|RECEBIMENTO|LIBERACAO|ESTORNO)_[A-Z_]+)"/gu;

function semComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/gu, "");
}

/** O CHECK que vale: o do ULTIMO arquivo (em ordem de nome, que e a de aplicacao) que o recria. */
function checkVigente(): { arquivo: string; tipos: string[] } {
  const arquivos = readdirSync(MIGRATIONS)
    .filter((nome) => nome.endsWith(".sql"))
    .sort();
  let vigente: { arquivo: string; tipos: string[] } | null = null;

  for (const arquivo of arquivos) {
    const sql = semComentarios(readFileSync(new URL(arquivo, MIGRATIONS), "utf8"));
    const recriacoes = sql.matchAll(
      /add\s+constraint\s+stock_movements_movement_type_check\s+check\s*\(\s*movement_type\s+in\s*\(([^)]*)\)/giu,
    );

    for (const recriacao of recriacoes) {
      vigente = { arquivo, tipos: [...(recriacao[1] ?? "").matchAll(/'([A-Z_]+)'/gu)].map((valor) => valor[1] ?? "") };
    }
  }

  if (vigente === null) {
    throw new Error("nenhuma migration recria stock_movements_movement_type_check — o teste perdeu o alvo");
  }

  return vigente;
}

function fontesTs(diretorio: URL): URL[] {
  const fontes: URL[] = [];

  for (const nome of readdirSync(diretorio)) {
    const caminho = new URL(nome, diretorio);

    if (statSync(caminho).isDirectory()) {
      fontes.push(...fontesTs(new URL(`${nome}/`, diretorio)));
    } else if (nome.endsWith(".ts") && !nome.endsWith(".test.ts")) {
      fontes.push(caminho);
    }
  }

  return fontes;
}

describe("CHECK de stock_movements.movement_type (sem banco)", () => {
  const vigente = checkVigente();

  it("o CHECK vigente tem todo tipo que o codigo grava, e o escritor declarado contem o literal", () => {
    for (const [tipo, escritor] of Object.entries(TIPOS_GRAVADOS)) {
      expect(vigente.tipos, `${tipo} (gravado em ${escritor}) fora do CHECK de ${vigente.arquivo}`).toContain(tipo);
      expect(readFileSync(new URL(escritor, RAIZ), "utf8"), `${escritor} nao grava mais ${tipo}`).toContain(
        `"${tipo}"`,
      );
    }
  });

  it("todo literal de tipo de movimento no worker e no dominio esta no CHECK vigente", () => {
    const fora: string[] = [];

    for (const fonte of [
      ...fontesTs(new URL("apps/worker/src/", RAIZ)),
      ...fontesTs(new URL("packages/domain/src/", RAIZ)),
    ]) {
      for (const literal of readFileSync(fonte, "utf8").matchAll(PADRAO_DE_TIPO)) {
        const tipo = literal[1] ?? "";

        if (!(tipo in NAO_SAO_MOVIMENTO) && !vigente.tipos.includes(tipo)) {
          fora.push(`${tipo} em ${fonte.pathname}`);
        }
      }
    }

    expect(fora, `fora do CHECK de ${vigente.arquivo}`).toEqual([]);
  });

  it("o CHECK vigente mantem SAIDA_DOCUMENTO (D-375) e ESTORNO_FULL (D-352) juntos, sem repeticao", () => {
    expect(vigente.tipos).toEqual(expect.arrayContaining(["SAIDA_DOCUMENTO", "ESTORNO_FULL"]));
    expect(new Set(vigente.tipos).size).toBe(vigente.tipos.length);
  });
});
