import { expect, test } from "@playwright/test";

import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./constants.js";

/**
 * `/vendas` — a migração da composição para o Figma (D6).
 *
 * **O que este teste protege não é a aparência, é o que a aparência quase
 * levou junto.** Os filtros de conta, marca e período eram três linhas de
 * pílulas e viraram três menus `<details>` na barra do cabeçalho. Toda a
 * lógica de URL continua a mesma — `buildHref` não mudou —, mas a forma de
 * chegar até ela mudou inteira, e um `href` montado sem um dos parâmetros
 * silenciosamente descarta um recorte: a tela continua respondendo, com o
 * recorte errado.
 *
 * Por isso a asserção é de COMPOSIÇÃO de filtros: aplicar conta, depois marca,
 * depois período, depois métrica, e exigir que os quatro sobrevivam juntos na
 * URL. É o caso que o formulário de período personalizado já tinha errado uma
 * vez (o `metric` se perdia, e o gráfico voltava para faturamento sozinho) —
 * e agora o `marca`/`semMarca` entrou na mesma conta.
 */
test("/vendas: conta, marca, período e métrica compõem sem se descartar", async ({ page }) => {
  await page.goto("/login?next=%2Fvendas");
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/vendas$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  const menus = page.locator("details.sb-menu");

  // Conta.
  await menus.nth(0).locator("summary").click();
  await menus.nth(0).getByRole("link", { name: "Loja E2E" }).click();
  await expect(page).toHaveURL(/account=e2e-loja/);

  // Marca — "Sem marca" NÃO é ausência de filtro (D-237): é a venda que
  // nenhuma marca alcança.
  await menus.nth(1).locator("summary").click();
  await menus.nth(1).getByRole("link", { name: "Sem marca" }).click();
  await expect(page).toHaveURL(/semMarca=1/);
  await expect(page).toHaveURL(/account=e2e-loja/);

  // Período.
  await menus.nth(2).locator("summary").click();
  await menus.nth(2).getByRole("link", { name: "Últimos 7 dias" }).click();
  await expect(page).toHaveURL(/days=7/);

  // Métrica, pelo controle segmentado que substituiu as pílulas do gráfico.
  await page.locator(".sb-segmented").getByRole("link", { name: "Unidades" }).click();

  // Os quatro, juntos. É esta linha que pega o recorte descartado em silêncio.
  await expect(page).toHaveURL(/account=e2e-loja/);
  await expect(page).toHaveURL(/semMarca=1/);
  await expect(page).toHaveURL(/days=7/);
  await expect(page).toHaveURL(/metric=unidades/);

  // E o rótulo de cada menu diz o estado — sem isso o filtro fica aplicado e
  // invisível, que é pior do que não ter filtro.
  await expect(menus.nth(0).locator("summary")).toContainText("Loja E2E");
  await expect(menus.nth(1).locator("summary")).toContainText("Sem marca");
  await expect(menus.nth(2).locator("summary")).toContainText("Últimos 7 dias");
});
