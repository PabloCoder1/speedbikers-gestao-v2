import { expect, test } from "@playwright/test";

import { E2E_SUGESTOES } from "./constants.js";
import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * Central de Sugestões (`/sugestoes`) pelo frame `CentralScreen` na variação de
 * ideias (D30, D-270).
 *
 * **Este é o PRIMEIRO spec desta tela**, que tem duas escritas — mudar o status
 * e estruturar com IA (D-112) — e nunca foi visitada por teste nenhum.
 *
 * O que este arquivo protege:
 *
 *  1. **o mestre-detalhe com seleção na URL** — sem isso o link para uma
 *     sugestão não existiria e o voltar do navegador não funcionaria;
 *  2. **o texto original preservado**, que é a promessa escrita da página: a
 *     versão estruturada pela IA acompanha, nunca substitui;
 *  3. **a sugestão AINDA NÃO estruturada diz isso**, em vez de abrir um painel
 *     vazio — a estruturação é sob demanda, não automática;
 *  4. **a janela declarada**, que a tela não tinha: ela lia SEM LIMITE e
 *     imprimia `rows.length` como total (a forma do defeito de D-263).
 */

test("/sugestoes: falha de conexão conserva o texto e permite nova tentativa", async ({ page }) => {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const texto = "E2E: conservar esta sugestão após a falha de conexão.";
  const lista = () => db.from("feature_suggestions").select("original_text,status")
    .eq("organization_id", seed.organizationId).eq("created_by", seed.userId).eq("original_text", texto);

  try {
    await login(page, "/sugestoes");
    const campo = page.getByRole("textbox", { name: "Sugerir uma melhoria" });
    await campo.fill(texto);
    const enviar = page.getByRole("button", { name: "Enviar sugestão", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await enviar.click();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar o envio" })).toBeVisible();
    await expect(enviar).toBeEnabled();
    await expect(campo).toHaveValue(texto);
    expect(caiu()).toBe(true);
    const antes = await lista();
    expect(antes.error).toBeNull();
    expect(antes.data).toEqual([]);

    await enviar.click();
    await expect(page.getByText("Enviada.", { exact: true })).toBeVisible();
    await expect(campo).toHaveValue("");
    const depois = await lista();
    expect(depois.error).toBeNull();
    expect(depois.data).toEqual([{ original_text: texto, status: "nova" }]);
  } finally {
    const limpeza = await db.from("feature_suggestions").delete().eq("organization_id", seed.organizationId)
      .eq("created_by", seed.userId).eq("original_text", texto);
    expect.soft(limpeza.error).toBeNull();
  }
});

test("/sugestoes: o detalhe abre na mais recente e diz que ela não foi estruturada", async ({ page }) => {
  await login(page, "/sugestoes");

  await expect(page.getByRole("heading", { name: "Sugestões de Melhoria", level: 1 })).toBeVisible();
  await expect(page.getByText("CENTRAL / EVOLUÇÃO DO PRODUTO")).toBeVisible();

  const detalhe = page.getByRole("region", { name: "Detalhe da sugestão" });

  /*
    Sem `?sugestao=` o detalhe abre na primeira da lista — a mais recente, que
    no seed é a CRUA. Prova o caminho que o frame não desenha: estruturação é
    sob demanda (D-112), então uma sugestão recém-escrita não tem os nove
    campos, e a tela diz isso em vez de abrir vazia.
  */
  await expect(detalhe).toContainText(E2E_SUGESTOES.crua.originalText);
  await expect(detalhe).toContainText("Ainda não estruturada");

  // O texto original aparece sempre, sob o rótulo que o separa da versão da IA.
  await expect(detalhe).toContainText("COMO FOI ESCRITO");

  // A JANELA que a tela não tinha.
  await expect(page.getByText(/2 sugestões registradas/)).toBeVisible();
});

test("/sugestoes: escolher no mestre abre o detalhe, e a seleção mora na URL", async ({ page }) => {
  await login(page, "/sugestoes");

  await page.getByRole("link", { name: new RegExp(E2E_SUGESTOES.estruturada.title) }).click();

  // Sem a seleção na URL, este link não existiria e o voltar não funcionaria.
  await expect(page).toHaveURL(/sugestao=/);

  const detalhe = page.getByRole("region", { name: "Detalhe da sugestão" });

  /*
    Os campos estruturados, com os rótulos da casa. O frame desenha CINCO
    (Problema, Objetivo, Benefício, Critério de aceite, Dependências); a tabela
    tem NOVE, e esconder os preenchidos por não estarem no desenho seria jogar
    fora trabalho que a IA já fez.
  */
  await expect(detalhe.getByText("Problema", { exact: true })).toBeVisible();
  await expect(detalhe.getByText(E2E_SUGESTOES.estruturada.problem)).toBeVisible();
  await expect(detalhe.getByText(E2E_SUGESTOES.estruturada.objective)).toBeVisible();

  /*
    E O TEXTO ORIGINAL CONTINUA LÁ. É a promessa que a página faz por escrito —
    a versão da IA acompanha, nunca substitui a palavra da pessoa.
  */
  await expect(detalhe).toContainText(E2E_SUGESTOES.estruturada.originalText);

  // Como ADMIN, o seletor de status oferece os SETE estados, não os três que o
  // frame desenha.
  const seletor = detalhe.getByLabel("Status da sugestão");

  await expect(seletor).toBeVisible();
  await expect(seletor.locator("option")).toHaveCount(7);
});

test("/sugestoes: enviar e alterar o status persiste após recarregar", async ({ page }) => {
  const texto = "Mostrar a data da última revisão da lista de fornecedores.";
  await login(page, "/sugestoes");

  await page.getByRole("textbox", { name: "Sugerir uma melhoria" }).fill(texto);
  await page.getByRole("button", { name: "Enviar sugestão" }).click();
  await expect(page.getByText("Enviada.", { exact: true })).toBeVisible();

  const detalhe = page.getByRole("region", { name: "Detalhe da sugestão" });
  await expect(detalhe).toContainText(texto);

  const status = detalhe.getByLabel("Status da sugestão");
  await expect(status).toHaveValue("nova");
  await status.selectOption("em_analise");
  await expect(status).toHaveValue("em_analise");

  await page.reload();
  await expect(detalhe).toContainText(texto);
  await expect(status).toHaveValue("em_analise");
});
