import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * Caixa de Entrada do Atendimento (Fase 7B, D-090) contra Postgres real, com
 * login real.
 *
 * Este spec existe por um motivo específico: D-074, D-075 e D-076 fecharam
 * cada um com a MESMA ressalva — "a tela em si não é visitada por nenhum spec
 * Playwright e não foi aberta manualmente". Três entregas seguidas cujo risco
 * de renderização ficou descoberto. A tela nova não repete isso.
 *
 * O que só um teste assim prova: que o embed de `support_case_links`
 * atravessa a **FK composta** `(support_case_id, organization_id,
 * ml_account_id)` no PostgREST de verdade, e que as duas formas de vínculo
 * chegam à tela — SKU tipado e o `item_id` externo que D-086 preserva quando
 * o anúncio ainda não existe em `listings`.
 */
test("caixa de entrada lista atendimentos abertos e respeita os filtros", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, "/atendimento");

  await expect(page).toHaveURL(/\/atendimento$/);
  await expect(page.getByRole("heading", { level: 1, name: "Caixa de Entrada" })).toBeVisible();

  // O case NOVO aparece com o SKU vindo do vínculo TIPADO, via embed da FK
  // composta — não é dado da própria linha de `support_cases`.
  const openRow = page.getByRole("row", { name: new RegExp(seed.supportOpenExternalId) });
  await expect(openRow).toBeVisible();
  await expect(openRow).toContainText(seed.mlAccountLabel);
  await expect(openRow).toContainText(seed.skuCode);
  await expect(openRow).toContainText("Pergunta");
  await expect(openRow).toContainText("Novo");

  // SKU é o único tipo de referência com rota real hoje (`/skus/[skuId]`).
  await expect(openRow.getByRole("link", { name: seed.skuCode })).toHaveAttribute(
    "href",
    `/skus/${seed.skuId}`,
  );

  // Filtro padrão é "abertos": o RESOLVIDO do seed NÃO pode aparecer.
  await expect(
    page.getByRole("row", { name: new RegExp(seed.supportResolvedExternalId) }),
  ).toHaveCount(0);
});

/**
 * Este teste é também a regressão do bug de redirect achado ao escrevê-lo
 * (D-090): `login()` navega para a URL COM query string sem sessão, o proxy
 * manda para `/login?next=...` e o formulário devolve para cá. Antes da
 * correção, `next` levava só o caminho — a pessoa entrava e caía na tela sem
 * o filtro. Se alguém reintroduzir isso, este teste falha.
 */
test("filtro de status revela o resolvido, com o anúncio ainda não vinculado", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, "/atendimento?status=RESOLVIDO");

  const resolvedRow = page.getByRole("row", { name: new RegExp(seed.supportResolvedExternalId) });
  await expect(resolvedRow).toBeVisible();
  await expect(resolvedRow).toContainText("Resolvido");

  // Fallback externo de D-086: o anúncio não existe em `listings`, então a
  // tela mostra o `item_id` cru — melhor que linha em branco — e SEM link,
  // porque `/anuncios` é lista e não tem página por item.
  await expect(resolvedRow).toContainText(seed.supportResolvedItemId);
  await expect(resolvedRow.getByRole("link", { name: seed.supportResolvedItemId })).toHaveCount(0);

  // E o aberto some quando o filtro é RESOLVIDO — prova que o filtro filtra
  // de verdade, não só destaca a pílula.
  await expect(page.getByRole("row", { name: new RegExp(seed.supportOpenExternalId) })).toHaveCount(0);
});

test("filtro por tipo sem dado mostra estado vazio, não erro", async ({ page }) => {
  // Nenhuma reclamação é ingerida ainda (só perguntas). O caminho vazio é o
  // mais provável em produção nos primeiros dias — precisa dizer isso em vez
  // de parecer falha.
  await login(page, "/atendimento?canal=CLAIM");

  await expect(page.getByText("Nenhum atendimento com esses filtros.")).toBeVisible();

  // Asserção pelo TEXTO do banner, não por `getByRole("alert")`: o Next.js
  // mantém um `#__next-route-announcer__` com `role="alert"` em toda página
  // (live region que anuncia o título na navegação client-side), então
  // "nenhum alert na página" é uma condição que nunca vale num app Next.
  await expect(page.getByText("Não foi possível carregar os atendimentos")).toHaveCount(0);
});
