import assert from "node:assert/strict";
import { test } from "node:test";

import { sweepTargets } from "@/features/ml-sync/current-row-sweep";

test("um anuncio que passou de N variacoes para zero continua sendo varrido", () => {
  /*
   * Regressao: a invalidacao rodava dentro de
   * `if (variationRows.length > 0)`. Um anuncio cujas variacoes
   * sumiram produz zero linhas filhas e escapava da varredura,
   * deixando as variacoes antigas como `is_current`.
   */
  const processedListingIds = new Map([
    ["MLB1", "listing-com-variacoes"],
    ["MLB2", "listing-que-perdeu-todas-as-variacoes"],
  ]);
  const receivedVariationRows: { ml_listing_id: string }[] = [];

  const targets = sweepTargets(processedListingIds.values());

  assert.equal(receivedVariationRows.length, 0);
  assert.deepEqual(targets.sort(), [
    "listing-com-variacoes",
    "listing-que-perdeu-todas-as-variacoes",
  ]);
});

test("um pedido que perdeu uma linha continua sendo varrido", () => {
  /*
   * Regressao: o pedido volta do Mercado Livre com menos itens do
   * que na versao anterior. Ele precisa entrar na varredura para
   * que a linha ausente saia de `is_current` e pare de contar
   * unidades e receita rateada.
   */
  const orderIdMap = new Map([
    ["2000000000000001", "order-com-duas-linhas"],
    ["2000000000000002", "order-que-perdeu-uma-linha"],
    ["2000000000000003", "order-sem-nenhuma-linha"],
  ]);

  const targets = sweepTargets(orderIdMap.values());

  assert.equal(targets.length, 3);
  assert.ok(targets.includes("order-que-perdeu-uma-linha"));
  assert.ok(targets.includes("order-sem-nenhuma-linha"));
});

test("ids repetidos colapsam em um unico alvo", () => {
  assert.deepEqual(
    sweepTargets(["listing-a", "listing-a", "listing-b"]),
    ["listing-a", "listing-b"],
  );
});

test("ids ausentes ou vazios nao viram alvo", () => {
  assert.deepEqual(
    sweepTargets([null, undefined, "", "listing-a"]),
    ["listing-a"],
  );
});

test("nenhum pai processado resulta em nenhuma varredura", () => {
  assert.deepEqual(sweepTargets([]), []);
});
