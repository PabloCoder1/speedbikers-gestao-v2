import { expect, test } from "@playwright/test";

import {
  E2E_DECISION_TEXT,
  E2E_LISTINGS,
  E2E_LISTING_DECISION_TEXT,
  E2E_LISTING_FULL,
  E2E_LISTING_PRICE_EVENT,
  E2E_LISTING_RELIST,
  E2E_LISTING_TRAFFIC,
} from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/anuncios/[itemId]` — o Dashboard do Anúncio depois da migração para as oito
 * abas (D13).
 *
 * **Esta rota existe desde D-168 e nunca teve e2e.** Ela era uma página de
 * seções verticais; agora tem `ObjectHeader` + `Visão geral | Vendas | Tráfego |
 * Preço | Full | Histórico | Diagnóstico | Decisões`, e cada aba dispara só as
 * suas consultas.
 *
 * O que este teste protege, em ordem de gravidade:
 *
 *  1. **A aba Diagnóstico RECUSA.** Não existe baseline por anúncio, e a
 *     tentação de rodar a fórmula do SKU sobre o recálculo por anúncio produz
 *     um número com a mesma cara e outra definição (D-023). Se um dia a aba
 *     passar a estampar número, este teste fica vermelho.
 *  2. **A tela não republica.** O motor existe e a primeira republicação real é
 *     ato humano deliberado (`docs/HANDOFF.md`). A aba Histórico LÊ o
 *     histórico; nenhum botão dispara.
 *  3. **Full é o mesmo número da lista.** O anúncio tem grão próprio de Full
 *     (D-243); mostrar aqui o total do SKU na conta seria dois números sob o
 *     mesmo rótulo.
 *  4. **Ausência não é zero** nas abas sem dado.
 */

const COM_DADO = E2E_LISTING_TRAFFIC.itemId;
const SEM_DADO = E2E_LISTINGS.find((a) => a.itemId !== COM_DADO && a.vinculo === "nenhum")?.itemId ?? "";

test("Dashboard do Anúncio: cabeçalho, oito abas e a Visão geral com número real", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}`);

  await expect(page.getByRole("heading", { level: 1, name: "Detalhe do anúncio" })).toBeVisible();

  // O identificador é o MLB, em mono acima do título — o cabeçalho de entidade.
  await expect(page.getByText(COM_DADO, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: E2E_LISTINGS.find((a) => a.itemId === COM_DADO)?.title ?? "" }),
  ).toBeVisible();

  // As oito abas do dono, nesta ordem.
  const abas = page.getByRole("navigation", { name: "Abas do anúncio" });

  for (const rotulo of ["Visão geral", "Vendas", "Tráfego", "Preço", "Full", "Histórico", "Diagnóstico", "Decisões"]) {
    await expect(abas.getByRole("link", { name: rotulo, exact: true })).toBeVisible();
  }

  // Visão geral: os quatro indicadores do frame, com os números do seed.
  // O rótulo é casado EXATO: a nota do cartão de Conversão contém a palavra
  // "visitas", e um `hasText` solto pegaria os dois cartões.
  const cartao = (rotulo: string) =>
    page.locator(".sb-stat", { has: page.getByText(rotulo, { exact: true }) }).locator(".sb-stat-value");

  await expect(cartao("Visitas (30d)")).toHaveText(String(E2E_LISTING_TRAFFIC.visits));
  await expect(cartao("Vendas (30d)")).toHaveText(String(E2E_LISTING_TRAFFIC.units));

  // A ação DESTE anúncio (mlb_id) aparece; a do SKU, não.
  await expect(page.getByText("Conferir se o anúncio perdeu exposição antes de mexer no preço.")).toBeVisible();
});

test("Dashboard do Anúncio: Preço e Full mostram o que foi observado, com o mesmo grão da lista", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}?aba=preco`);

  // A mudança de preço observada vem do evento de domínio, formatada como diff.
  await expect(page.getByRole("heading", { name: "Mudanças de preço observadas" })).toBeVisible();

  // Escopado à TABELA: o preço atual também aparece no subtítulo do painel, e
  // o que se afirma aqui é o diff observado (de → para), não o preço de hoje.
  const linhaDoDiff = page.locator("tbody tr").first();

  await expect(linhaDoDiff).toContainText(String(E2E_LISTING_PRICE_EVENT.de).replace(".", ","));
  await expect(linhaDoDiff).toContainText(String(E2E_LISTING_PRICE_EVENT.para).replace(".", ","));

  // Full: o número do ANÚNCIO, o mesmo que a lista mostra (D-243) — não o
  // total do SKU na conta.
  await page.goto(`/anuncios/${COM_DADO}?aba=full`);
  await expect(page.locator(".sb-stat", { hasText: "No Full (este anúncio)" }).locator(".sb-stat-value")).toHaveText(
    String(E2E_LISTING_FULL),
  );
});

test("Dashboard do Anúncio: Histórico lê a republicação e NÃO oferece disparo", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}?aba=historico`);

  await expect(page.getByRole("heading", { name: "Republicações" })).toBeVisible();
  await expect(page.getByText(E2E_LISTING_RELIST.status, { exact: true })).toBeVisible();
  await expect(page.getByText(E2E_LISTING_RELIST.failureReason)).toBeVisible();

  // A guarda que importa: nenhum caminho de UI dispara republicação. O motor
  // vive no worker e na API, e a primeira republicação real é ato humano
  // deliberado (docs/HANDOFF.md).
  await expect(page.getByRole("button", { name: /republicar/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /republicar/i })).toHaveCount(0);
});

test("Dashboard do Anúncio: Diagnóstico recusa por anúncio, e as abas sem dado dizem ausência", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}?aba=diagnostico`);

  // Recusa explícita: não há baseline por anúncio, e a aba manda para o SKU.
  await expect(page.getByText(/baseline do SKU/)).toBeVisible();
  await expect(page.getByRole("link", { name: /abrir o diagnóstico/i })).toBeVisible();
  // E não estampa nenhum número de diagnóstico.
  await expect(page.locator(".sb-stat-value")).toHaveCount(0);

  // O anúncio SEM tráfego: ausência de coleta é dita, não vira zero (D-123).
  await page.goto(`/anuncios/${SEM_DADO}?aba=trafego`);
  await expect(page.getByText(/Nenhum dia com coleta de visitas/)).toBeVisible();

  // E sem vínculo de SKU, o Full não é rastreável — a tela diz isso.
  await page.goto(`/anuncios/${SEM_DADO}?aba=full`);
  await expect(page.getByText(/Sem vínculo de SKU/).first()).toBeVisible();
});

/**
 * Decisões do ANÚNCIO — o embed filtra por `actions.mlb_id`, não por SKU. A
 * decisão do SKU (que o seed também cria) não pode vazar para cá: são duas
 * memórias distintas sobre entidades distintas.
 */
test("Dashboard do Anúncio: Decisões mostra a decisão DESTE anúncio, e só ela", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}?aba=decisoes`);

  await expect(page.getByRole("heading", { name: "Decisões registradas" })).toBeVisible();
  await expect(page.getByText(E2E_LISTING_DECISION_TEXT)).toBeVisible();
  await expect(page.getByText(E2E_DECISION_TEXT)).toHaveCount(0);

  // O retrato do momento vem bruto, sem porcentagem de resultado (D-228).
  await expect(page.getByText(/No momento da decisão/)).toBeVisible();

  // O anúncio sem ação não inventa decisão.
  await page.goto(`/anuncios/${SEM_DADO}?aba=decisoes`);
  await expect(page.getByText(/Nenhuma decisão registrada para este anúncio/)).toBeVisible();
});
