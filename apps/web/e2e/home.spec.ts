import { expect, test } from "@playwright/test";

import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./constants.js";

/**
 * Home orientada à atenção (D4).
 *
 * **A asserção que mais vale é a negativa.** O contador de notificações da Home
 * pedia `.select("id")` numa tabela que NÃO TEM coluna `id` — a chave de
 * `notification_recipients` é composta `(notification_id, user_id)`. O
 * PostgREST recusava, e a tela mostrava "Não foi possível carregar" desde que o
 * card existe. Nunca funcionou.
 *
 * Ninguém viu porque a regra D-067 manda falha aparecer como "—" em vez de
 * zero: a tela estava CERTA em não fingir um número, e o "—" passa por
 * discrição em vez de defeito. Só apareceu quando a fatia visual abriu a
 * tela renderizada e perguntou por que aquele card estava diferente.
 *
 * Por isso o teste não afirma um número — afirma que NENHUM card falhou. É a
 * forma que pega a próxima coluna errada, em qualquer um dos seis cards, sem
 * precisar saber qual.
 */
test("Home: os seis cards de atenção carregam, e nenhum deles falha", async ({ page }) => {
  // Navegação explícita para `/login?next=%2F`, o mesmo padrão de
  // `login.spec.ts`: o caminho "abrir `/` sem sessão e ser mandado ao login"
  // já é o assunto de um teste próprio lá, e repeti-lo aqui só acrescentaria
  // uma corrida de redirect ao teste que quer falar da Home.
  await page.goto("/login?next=%2F");
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/$/);
  // O `<h1>` é a saudação quando o perfil tem `full_name`, e a pergunta do
  // produto quando não tem. O que NÃO muda é o painel de atenção — é ele que
  // este teste está protegendo.
  await expect(page.getByRole("region", { name: "Atenção necessária" })).toBeVisible();

  const cards = [
    "SKUs em ruptura",
    "Em mediação",
    "Ações de impacto alto",
    "Outras ações abertas",
    "Atendimentos abertos",
    "Notificações não lidas",
  ];

  for (const label of cards) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  // A guarda de verdade: leitura que falha vira "—" e este aviso (D-067). Um
  // único card falhando reprova a suíte, e o nome dele sai no diff.
  //
  // `exact: true` NÃO é enfeite: `getByText` casa por SUBSTRING e ignora
  // maiúscula, e o próprio texto de abertura da Home diz "medido e limpo é
  // diferente de não medido". Sem `exact`, o teste reprovava a tela por causa
  // da frase que explica a tela.
  await expect(page.getByText("Não foi possível carregar", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Não medido", { exact: true })).toHaveCount(0);

  // Comparação de período existe e NÃO é porcentagem (D-023): a tela mostra os
  // dois valores lado a lado, e o rótulo do anterior é o que prova isso.
  await expect(page.getByText("Indicadores gerais", { exact: true })).toBeVisible();
  // O id da métrica sai em todas as células da faixa, com dado ou sem — é a
  // rastreabilidade até `metric_definitions`, e não depende do seed ter
  // métrica calculada (com a tabela vazia a tela diz "nunca calculado", que é
  // o estado certo, e a linha de "período anterior" nem existe).
  await expect(page.getByText("receita_bruta", { exact: true })).toBeVisible();

  // Os dois painéis da grade inferior, que o frame do Figma põe lado a lado.
  await expect(page.getByRole("region", { name: "Faturamento diário" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Atividade recente" })).toBeVisible();
});
