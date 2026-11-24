import type { Database } from "@sb/db";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";

/*
  FALHA DE TRANSPORTE EM "JÁ FIZ O PEDIDO" E NO CADASTRO DE FORNECEDOR (D-866).
  O POST é bloqueado ANTES do servidor, então nada é gravado: a sugestão do SKU
  do seed e a lista de fornecedores, que outras specs contam, ficam como estavam.
  A repetição segura (mesmo `requestId`, nome único) já é provada pelo banco e
  por `pedido-ja-feito.spec.ts`.
*/

function banco(): ReturnType<typeof createClient<Database>> {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");

  return createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
}

/** Bloqueia a PRIMEIRA Server Action da página `caminho`, antes de chegar ao servidor. */
async function bloquearPrimeiraAcao(page: Page, caminho: string): Promise<() => boolean> {
  let bloqueada = false;

  await page.route(
    (endereco) => endereco.pathname === caminho,
    async (rota) => {
      const pedido = rota.request();

      if (!bloqueada && pedido.method() === "POST" && pedido.headers()["next-action"] !== undefined) {
        bloqueada = true;
        await rota.abort("failed");
      } else {
        await rota.continue();
      }
    },
  );

  return () => bloqueada;
}

test("já fiz o pedido: falha de transporte avisa, libera os botões e o diálogo volta a fechar (D-866)", async ({ page }) => {
  await login(page, `/reposicao?busca=${E2E_SKU_CODE}`);

  const linha = page.locator("tbody tr", { hasText: E2E_SKU_CODE }).first();

  await linha.getByRole("button", { name: "Já fiz o pedido" }).click();

  const dialogo = page.getByRole("dialog");

  await dialogo.getByLabel(/Quantidade encomendada/).fill("5");

  const bloqueada = await bloquearPrimeiraAcao(page, "/reposicao");
  const registrar = dialogo.getByRole("button", { name: "Registrar pedido" });

  await registrar.click();
  await expect(dialogo.getByText("Não foi possível confirmar o registro.")).toBeVisible();
  await expect(registrar).toBeEnabled();
  await expect(dialogo.getByLabel(/Quantidade encomendada/)).toHaveValue("5");
  expect(bloqueada()).toBe(true);

  // Sem o `try`, `gravando` ficava ligado e o diálogo não fechava.
  await dialogo.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialogo).toBeHidden();
});

test("novo fornecedor: falha de transporte avisa, mantém o que foi digitado e não cadastra (D-866)", async ({ page }) => {
  const nome = `Fornecedor transporte e2e ${String(Date.now())}`;

  await login(page, "/fornecedores/novo");
  await page.getByLabel("Nome").fill(nome);

  const bloqueada = await bloquearPrimeiraAcao(page, "/fornecedores/novo");
  const cadastrar = page.getByRole("button", { name: "Cadastrar fornecedor" });

  await cadastrar.click();
  // Sem o `try`, a rejeição ia para a fronteira de erro e o formulário sumia.
  await expect(page.getByText("Não foi possível confirmar se o fornecedor foi cadastrado.")).toBeVisible();
  await expect(cadastrar).toBeEnabled();
  await expect(page.getByLabel("Nome")).toHaveValue(nome);
  expect(bloqueada()).toBe(true);

  const { data, error } = await banco().from("suppliers").select("id").eq("name", nome);

  expect(error).toBeNull();
  expect(data).toHaveLength(0);
});
