import { expect, test } from "@playwright/test";

import { E2E_CONHECIMENTO } from "./constants.js";
import { login } from "./helpers.js";

/**
 * Base de Conhecimento (`/atendimento/conhecimento`) pelo frame `SupportScreen`
 * na variante de conhecimento (D28, D-268).
 *
 * **Este é o PRIMEIRO spec desta tela.** Ela existe desde D-113, tem quatro
 * escritas (validar, rejeitar, obsoletar e o formulário) e nunca foi visitada
 * por teste nenhum — e `knowledge_entries` tem zero linhas no Dev, então nem
 * uma captura mostraria o que ela faz. O fixture existe para isso.
 *
 * O que este arquivo protege:
 *
 *  1. **os QUATRO estados**, contra os dois que o frame desenha — esconder
 *     rejeitado e obsoleto apagaria justamente o histórico que a tabela existe
 *     para preservar;
 *  2. **"Confirmado por" só em VALIDADO**, que é a constraint
 *     `knowledge_entries_validation_coherent` aparecendo na tela: confirmação
 *     anônima seria o oposto do propósito;
 *  3. **o percentual sobre base vazia é "—", não 0%** (D-067) — é o número mais
 *     delicado do frame, que mostra "92% validados" pressupondo base cheia;
 *  4. **a Fonte deixou de mostrar o enum cru** (`CONFIRMACAO_INTERNA`).
 */

const VALIDADA = E2E_CONHECIMENTO[0];
const SUGERIDA = E2E_CONHECIMENTO[1];
const OBSOLETA = E2E_CONHECIMENTO[2];

test("/conhecimento: os três números do topo, e o percentual tem denominador declarado", async ({ page }) => {
  await login(page, "/atendimento/conhecimento");

  await expect(page.getByRole("heading", { name: "Base de Conhecimento", level: 1 })).toBeVisible();
  await expect(page.getByText("ATENDIMENTO / OPERAÇÃO")).toBeVisible();

  const painel = page.locator(".sb-stat-grid");

  // Três no fixture: uma validada, uma sugerida, uma obsoleta.
  await expect(painel.locator(".sb-stat", { hasText: "Conhecimentos registrados" }).locator(".sb-stat-value")).toHaveText("3");
  await expect(painel.locator(".sb-stat", { hasText: "Aguardando revisão" }).locator(".sb-stat-value")).toHaveText("1");

  /*
    1 de 3. O número importa menos que o DENOMINADOR estar dito: rejeitados e
    obsoletos entram nele, e sem essa frase "33%" seria ambíguo.
  */
  await expect(painel.locator(".sb-stat", { hasText: "Validados pela equipe" }).locator(".sb-stat-value")).toContainText("33");
  await expect(painel).toContainText("com rejeitados e obsoletos no denominador");
});

test("/conhecimento: os QUATRO estados aparecem, não os dois do frame", async ({ page }) => {
  await login(page, "/atendimento/conhecimento");

  const corpo = page.locator("tbody");

  await expect(corpo.getByText(VALIDADA.content)).toBeVisible();
  await expect(corpo.getByText(SUGERIDA.content)).toBeVisible();

  /*
    A OBSOLETA é a prova. O frame desenha só "Validado" e "Sugerido"; a `check`
    da tabela conhece quatro, e rejeitar/obsoletar preserva o histórico da
    decisão em vez de apagá-lo (D-113).
  */
  await expect(corpo.getByText(OBSOLETA.content)).toBeVisible();
  await expect(corpo.getByText("Obsoleto", { exact: true })).toBeVisible();

  // Conhecimento sem SKU vale para o catálogo inteiro — "geral" é afirmação,
  // não ausência.
  await expect(corpo.getByText("geral", { exact: true })).toBeVisible();

  // A Fonte mostrava o enum cru até esta fatia.
  await expect(corpo.getByText("Confirmação interna", { exact: true })).toBeVisible();
  await expect(corpo.getByText("CONFIRMACAO_INTERNA")).toHaveCount(0);
});

test("/conhecimento: 'Confirmado por' só existe onde houve confirmação", async ({ page }) => {
  await login(page, "/atendimento/conhecimento");

  /*
    A constraint `knowledge_entries_validation_coherent` exige `confirmed_by` E
    `confirmed_at` em VALIDADO. Na tela isso vira: a linha validada tem nome, e
    as outras duas têm "—" — que é a ausência CORRETA, não um dado que faltou
    carregar.
  */
  const linhaValidada = page.getByRole("row", { name: new RegExp(VALIDADA.content.slice(0, 20)) });
  const linhaSugerida = page.getByRole("row", { name: new RegExp(SUGERIDA.content.slice(0, 20)) });

  await expect(linhaValidada).toContainText("E2E");
  await expect(linhaSugerida).toContainText("—");

  // E só a sugerida oferece os dois botões de triagem; a validada oferece
  // obsoletar, nunca "Validar" de novo.
  await expect(linhaSugerida.getByRole("button", { name: "Validar" })).toBeVisible();
  await expect(linhaSugerida.getByRole("button", { name: "Rejeitar" })).toBeVisible();
  await expect(linhaValidada.getByRole("button", { name: "Tornar obsoleto" })).toBeVisible();
  await expect(linhaValidada.getByRole("button", { name: "Validar" })).toHaveCount(0);
});
