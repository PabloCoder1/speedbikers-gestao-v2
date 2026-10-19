import { expect, test } from "@playwright/test";

import { descricaoValida } from "../lib/vitals-elemento.js";

import { login } from "./helpers.js";

/**
 * O REPORTER DE PRODUÇÃO DIZ O ELEMENTO, PELA FORMA (D-516).
 *
 * O LCP sai no primeiro clique ou tecla (D-507) e, desde a D-516, leva o
 * elemento: a tag, as classes `sb-*` e a seção em que ele mora, pela posição —
 * nunca texto, `id` ou rótulo. O `page.route` segura o envio para ler o que o
 * navegador mandaria ao log, e responde no lugar da rota.
 */

interface Envio {
  name: string;
  value: number;
  path: string;
  softNav?: boolean;
  el?: string;
}

test("o LCP de uma carga completa vai com o elemento, na forma que a rota aceita", async ({ page }) => {
  await login(page, "/central");
  await page.waitForURL((url) => url.pathname === "/central");

  const enviados: Envio[] = [];

  await page.route("**/api/vitals", async (route) => {
    enviados.push(route.request().postDataJSON() as Envio);
    await route.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' });
  });

  // A carga COMPLETA: a entrada pelo login é navegação suave, e o reporter mede o documento.
  await page.reload();
  await page.getByRole("heading", { level: 1 }).click();

  await expect.poll(() => enviados.find((envio) => envio.name === "LCP")).toBeTruthy();

  const lcp = enviados.find((envio) => envio.name === "LCP");

  expect(lcp?.path).toBe("/central");
  expect(lcp?.softNav).toBe(false);
  expect(descricaoValida(lcp?.el)).toBe(true);

  // A aba se esconde: o CLS sai. A /central não desloca desde a D-515, e sem deslocamento não há elemento.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(() => enviados.find((envio) => envio.name === "CLS")).toBeTruthy();

  const cls = enviados.find((envio) => envio.name === "CLS");

  expect(cls?.value).toBe(0);
  expect(cls?.el).toBeUndefined();
});
