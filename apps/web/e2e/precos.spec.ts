import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { E2E_LISTING_PRICE_EVENT, E2E_LISTING_PRICE_EVENT_ALTA } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/precos` — Histórico de Preços depois da migração para o frame
 * `IntelligenceScreen type="pricing"` (D24, D-264): faixa de quatro cartões +
 * painel com a tabela das alterações observadas.
 *
 * **A recusa central é uma PROMESSA, não um número.** O frame traz o bloco
 * "Dados Insuficientes para Análise Causal" já escrito, e a premissa dele é
 * verdadeira — a tela dizia isso desde D-172. O que ficou de fora é a frase
 * seguinte: "o sistema apresentará tendências quando o volume de dados
 * estabilizar (geralmente após 7 dias da mudança)". Nada implementa isso, e
 * prometer comportamento futuro com prazo faz o operador esperar por uma tela
 * que não vai mudar.
 *
 * O que mais este arquivo protege:
 *
 *  1. **os chips da faixa cumprem o que prometem** (D-242) — clicar em
 *     "Aumentos" mostra exatamente o aumento, e "Anúncios afetados" NÃO tem
 *     chip porque nenhum filtro devolve aquele conjunto;
 *  2. **a coluna Direção**, que é a pista textual da variação — antes ela se
 *     distinguia só por cor e sinal;
 *  3. **a data de início da série vem do BANCO**, não de uma constante: era
 *     `SERIES_START_LABEL` cravado no código, certo para a única organização
 *     com dado e errado para a segunda (classe D-234).
 */

test("/precos: a faixa conta o mesmo recorte da tabela, e a tabela diz a direção", async ({ page }) => {
  await login(page, "/precos");

  await expect(page.getByRole("heading", { name: "Histórico de Preços", level: 1 })).toBeVisible();
  await expect(page.getByText("INTELIGÊNCIA / PREÇOS")).toBeVisible();

  const faixa = page.locator(".sb-kpi-strip");

  /*
    Duas alterações no seed, uma para cada lado — e a soma fecha: os cartões
    contam O MESMO conjunto que a tabela mostra (D-236), então nunca discordam
    dela.
  */
  await expect(faixa.locator(".sb-kpi", { hasText: "Alterações" }).locator(".sb-kpi-value")).toHaveText("2");
  await expect(faixa.locator(".sb-kpi", { hasText: "Aumentos" }).locator(".sb-kpi-value")).toHaveText("1");
  await expect(faixa.locator(".sb-kpi", { hasText: "Reduções" }).locator(".sb-kpi-value")).toHaveText("1");
  await expect(
    faixa.locator(".sb-kpi", { hasText: "Anúncios afetados" }).locator(".sb-kpi-value"),
  ).toHaveText("2");

  /*
    As duas linhas, com os dois sentidos e a pista TEXTUAL de cada um.

    Escopado ao `tbody` e EXATO de proposito: `getByText` casa substring sem
    diferenciar caixa, entao "AUMENTO" solto pega tambem o rotulo "Aumentos"
    do cartao e a opcao "Aumentos" do menu de direcao.
  */
  const corpo = page.locator("tbody");

  await expect(page.getByText(`R$ ${E2E_LISTING_PRICE_EVENT.para.toFixed(2).replace(".", ",")}`)).toBeVisible();
  await expect(corpo.getByText("AUMENTO", { exact: true })).toBeVisible();
  await expect(corpo.getByText("REDUÇÃO", { exact: true })).toBeVisible();
});

test("/precos: o aviso diz por que NÃO afirma impacto, e não promete prazo", async ({ page }) => {
  await login(page, "/precos");

  const aviso = page.locator(".sb-note");

  await expect(aviso).toContainText("DADOS INSUFICIENTES PARA ANÁLISE CAUSAL");
  await expect(aviso).toContainText("Afirmar impacto exigiria comparar a venda em janelas equivalentes");

  /*
    A ressalva de D-226, que impede a leitura errada: o evento é diff entre
    snapshots de 6 em 6 horas, então uma mudança feita e desfeita entre duas
    varreduras não deixa registro.
  */
  await expect(aviso).toContainText("ausência de linha não é preço estável");

  /*
    A PROMESSA DO FRAME NÃO APARECE. Ele conclui que o sistema mostrará
    tendências "após 7 dias da mudança" — nada calcula isso, e o prazo faria o
    operador esperar por uma tela que não vai mudar.
  */
  await expect(page.getByText(/7 dias/)).toHaveCount(0);
  await expect(page.getByText(/tendências/i)).toHaveCount(0);

  /*
    O "Exportar Relatório" do frame FOI ENTREGUE em D-292 — D-264 o havia
    recusado como botão sem função ("botão que não faz nada é pior que botão
    nenhum") e registrado como candidata a fatia própria. O que continua
    valendo daquela recusa é a forma: não é botão, é LINK para uma rota que
    devolve arquivo.
  */
  await expect(page.getByRole("button", { name: /Exportar/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Exportar XLSX" })).toHaveAttribute(
    "href",
    "/precos/export/xlsx",
  );
});

/**
 * A EXPORTAÇÃO (D-292), e o que ela promete: **o arquivo é o RECORTE que está
 * na tela**, não "tudo". Um botão que ignorasse os filtros entregaria uma
 * planilha que não corresponde à tela de onde saiu — e ninguém confere
 * planilha contra tela.
 */
test("/precos: o link de exportação carrega o recorte, e o arquivo vem de verdade", async ({ page }) => {
  await login(page, "/precos?direcao=down&de=2026-09-01");

  const link = page.getByRole("link", { name: "Exportar XLSX" });

  // O recorte viaja no href — e a PÁGINA não: a planilha é o recorte inteiro.
  await expect(link).toHaveAttribute("href", "/precos/export/xlsx?direcao=down&de=2026-09-01");

  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);

  // O nome carrega o período: dois recortes diferentes não se sobrescrevem na
  // pasta de Downloads nem se confundem.
  expect(download.suggestedFilename()).toBe("historico-de-precos-2026-09-01-a-hoje.xlsx");

  /*
    E é um XLSX de verdade, não uma página de erro com nome de planilha: todo
    arquivo do formato começa com a assinatura ZIP `PK`.
  */
  const caminho = await download.path();
  const conteudo = await readFile(caminho);

  expect(conteudo.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(conteudo.byteLength).toBeGreaterThan(1000);
});

test("/precos: o chip da faixa mostra exatamente as linhas que ele conta", async ({ page }) => {
  await login(page, "/precos");

  const faixa = page.locator(".sb-kpi-strip");

  /*
    D-242 — a diferença entre promessa e enfeite. O cartão diz "Aumentos 1";
    clicar tem de mostrar aquele um, e só ele.
  */
  await faixa.locator(".sb-kpi", { hasText: "Aumentos" }).getByRole("link", { name: "ver lista" }).click();

  await expect(page).toHaveURL(/direcao=up/);
  const corpo = page.locator("tbody");

  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(corpo.getByText("AUMENTO", { exact: true })).toBeVisible();
  await expect(corpo.getByText("REDUÇÃO", { exact: true })).toHaveCount(0);

  // O anúncio do aumento não tem SKU — a célula diz isso em vez de inventar.
  await expect(page.getByRole("link", { name: E2E_LISTING_PRICE_EVENT_ALTA.itemId })).toBeVisible();
  await expect(page.getByText("sem vínculo")).toBeVisible();

  /*
    E o cartão que NÃO tem chip: nenhum filtro devolve "os N anúncios
    afetados" — cada um pode ter várias alterações —, então um link ali
    mentiria sobre o destino. A ausência é a decisão.
  */
  const afetados = faixa.locator(".sb-kpi", { hasText: "Anúncios afetados" });

  await expect(afetados.getByRole("link", { name: "ver lista" })).toHaveCount(0);
});
