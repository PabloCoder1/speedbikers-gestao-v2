import { expect, test } from "@playwright/test";

import { E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD } from "./constants.js";
import { login, loginAs } from "./helpers.js";

/**
 * Administração de Usuários (`/usuarios`) pelo frame `AdminScreen` na variação
 * de acessos (D31, D-271).
 *
 * **Este spec nasce de um defeito VIVO que ele existe para não deixar voltar.**
 *
 * A tela lia `organization_members` com `.maybeSingle()` **sem filtrar por
 * usuário**. Sob RLS aquela leitura devolve TODOS os membros da organização;
 * com dois, o PostgREST responde `PGRST116`, `data` vira nulo, e a tela dizia
 * *"Sua conta não está associada a nenhuma organização"* — para o próprio
 * ADMIN.
 *
 * É a classe que D-234 corrigiu em ~25 telas e que passou por esta. E a ironia
 * explica por que ninguém viu: `/usuarios` é justamente onde se cadastra o
 * segundo usuário, ou seja, **a tela que o ato quebra é a tela que o ato usa**.
 *
 * O seed tem DOIS membros exatamente para que este arquivo fique vermelho se
 * alguém reintroduzir a leitura sem filtro.
 */

test("/usuarios: com DOIS membros a tela abre — a regressão de D-234", async ({ page }) => {
  await login(page, "/usuarios");

  await expect(page.getByRole("heading", { name: "Usuários", level: 1 })).toBeVisible();

  /*
    A FRASE QUE NÃO PODE VOLTAR. Ela é correta para quem realmente não tem
    organização; era o sintoma do defeito para quem tem.
  */
  await expect(page.getByText(/não está associada a nenhuma organização/)).toHaveCount(0);

  /*
    Os DOIS membros do seed aparecem. O escopo é o painel de gerenciamento
    porque o histórico embaixo também nomeia as duas pessoas — "E2E" solto
    casaria nas duas tabelas.
  */
  const gerenciar = page.getByRole("region", { name: "Gerenciar acessos" });

  await expect(gerenciar.getByRole("cell", { name: "E2E", exact: true })).toBeVisible();
  await expect(gerenciar.getByRole("cell", { name: "E2E Gestor", exact: true })).toBeVisible();
});

test("/usuarios: o histórico de acesso mostra as duas entradas que o banco gravou", async ({ page }) => {
  await login(page, "/usuarios");

  /*
    O histórico não é escrito pela tela: `organization_access_events` é
    append-only e preenchido por trigger. Ou seja, o seed cria os dois membros
    e o BANCO registra as duas entradas — se elas não estiverem aqui, o
    registro de auditoria parou de funcionar, e isso é silencioso.
  */
  const historico = page.getByRole("region", { name: "Histórico de acesso" });

  await expect(historico.getByRole("cell", { name: "entrou como ADMIN" })).toBeVisible();
  await expect(historico.getByRole("cell", { name: "entrou como GESTOR" })).toBeVisible();

  // A janela é declarada, não implícita — a leitura tem `limit(50)` (D-131).
  await expect(historico.getByText(/50 mudanças mais recentes/)).toBeVisible();
});

test("/usuarios: a faixa tem os CINCO papéis do check, não os três do frame", async ({ page }) => {
  await login(page, "/usuarios");

  const faixa = page.locator(".sb-kpi-strip");

  /*
    O frame dá cartão a Administradores, Gestores e Operadores. O `check` de
    `organization_members` conhece CINCO: ADMIN, GESTOR, ANALISTA, OPERADOR e
    VISUALIZADOR. Com três, os cartões deixariam de fechar com o total no dia
    em que alguém for cadastrado como analista — a mesma aritmética que
    denunciou o frame da Central Full (D-265).
  */
  await expect(faixa.locator(".sb-kpi", { hasText: "Membros" }).locator(".sb-kpi-value")).toHaveText("2");
  await expect(faixa.locator(".sb-kpi", { hasText: "Administrador" }).locator(".sb-kpi-value")).toHaveText("1");
  await expect(faixa.locator(".sb-kpi", { hasText: "Gestor" }).locator(".sb-kpi-value")).toHaveText("1");

  // Os três papéis sem ninguém aparecem em ZERO — esconder linha vazia é que
  // faria os cartões mentirem sobre o que existe (D-250).
  for (const papel of ["Analista", "Operador", "Visualizador"]) {
    await expect(faixa.locator(".sb-kpi", { hasText: papel }).locator(".sb-kpi-value")).toHaveText("0");
  }
});

test("/usuarios: as três colunas sem fonte do frame não entraram", async ({ page }) => {
  await login(page, "/usuarios");

  /*
    "Convites Pendentes" (cartão) e "Status" (coluna): não existe tabela de
    convite no esquema, então todo membro está ativo por construção — um cartão
    sempre em zero e uma coluna de um valor só prometeriam um fluxo que a tela
    não tem.
  */
  await expect(page.getByText(/Convites Pendentes/i)).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Status" })).toHaveCount(0);

  /*
    "Último Acesso": é `auth.users.last_sign_in_at`, e o PostgREST não expõe o
    schema `auth` — nenhuma coluna nem função em `public` o alcança (medido).
    "Desde" fica no lugar, que é `created_at` do vínculo.
  */
  await expect(page.getByRole("columnheader", { name: /Último acesso/i })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Desde" })).toBeVisible();

  // E o e-mail sob o nome: `profiles` tem só id, full_name e carimbos.
  await expect(page.getByText(/@speedbikers/)).toHaveCount(0);
});

test("/usuarios: o GESTOR vê a tela em leitura, e o papel lido é o DELE", async ({ page }) => {
  await loginAs(page, E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD, "/usuarios");

  /*
    Este é o caso que prova que a correção lê o membro CERTO, e não um membro
    qualquer. `currentMembership` filtra por `auth.uid()`; a leitura antiga
    devolvia a lista inteira e não sabia dizer de quem era o papel.

    Para o GESTOR a tela é somente leitura, e o texto abaixo do título é a
    forma visível disso.
  */
  await expect(page.getByText(/somente leitura para você/)).toBeVisible();

  // Sem seletor de papel: os controles de escrita só aparecem para ADMIN.
  await expect(page.getByRole("combobox")).toHaveCount(0);

  /*
    E o histórico some — não por a tela escondê-lo, mas porque a policy de
    `organization_access_events` só devolve linhas para ADMIN. Esconder é
    conveniência; quem recusa é o banco (D-175).
  */
  await expect(page.getByRole("region", { name: "Histórico de acesso" })).toHaveCount(0);
});
