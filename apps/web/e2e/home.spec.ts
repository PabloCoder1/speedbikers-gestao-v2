import { expect, test } from "@playwright/test";

import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./constants.js";
import { login } from "./helpers.js";

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

  // Como no frame, a grade só desenha as situações DETECTADAS; as medidas e
  // limpas viram a linha "Medidos e limpos" abaixo dela — o número zero não
  // some (medido e limpo é diferente de não medido, D-067), só sai da grade.
  // O seed cobre CINCO das seis situações: uma ação alta, uma de severidade
  // média (a do anúncio, D13), um atendimento aberto, um anúncio pausado com
  // estoque e a notificação que o evento de domínio do anúncio gerou. Só
  // "sem saldo local" e mediação estão em zero — e o zero delas continua
  // visível. O cartão chamava-se "SKUs em ruptura" até a fusão de `/cobertura`
  // com `/reposicao` (D-288): ruptura passou a ter UMA dona, e o que a Home
  // mede — vende e o saldo LOCAL zerou — não é o veredito dela.
  const grade = page.locator(".sb-attention-grid");
  const limpos = page.locator(".sb-attention-clean");

  for (const label of [
    "Ações de impacto alto",
    "Outras ações abertas",
    "Atendimentos abertos",
    "Notificações não lidas",
    "Anúncios pausados",
  ]) {
    await expect(grade.getByRole("heading", { level: 3, name: label })).toBeVisible();
  }

  for (const label of ["SKUs sem saldo local", "Em mediação"]) {
    await expect(limpos.getByRole("link", { name: `0 ${label}` })).toBeVisible();
  }

  // O cartão diz o impacto numa frase, não num número solto; e o CTA é botão.
  await expect(grade.getByText("1 ação de severidade alta aberta", { exact: true })).toBeVisible();
  await expect(page.getByText("5 situações detectadas", { exact: true })).toBeVisible();

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


/**
 * O SELETOR DE JANELA DO GRÁFICO (D-311) — o controle que o frame põe no
 * cabeçalho do painel, e que na V3 estava ocupado por um link para FORA da
 * tela.
 *
 * O caso guarda as duas metades juntas, e a segunda é a que importa: **`?serie=`
 * termina na série**. A faixa de indicadores continua em 30 dias enquanto o
 * gráfico vai a 7 — se um dia alguém ligar o seletor na `janela`, os
 * contadores dos cartões de atenção passam a mudar por causa de um controle
 * que está noutro bloco, e é esta linha que fica vermelha.
 */
test("Home: o seletor do gráfico existe, e ele termina na série", async ({ page }) => {
  await login(page, "/");

  const grafico = page.getByRole("region", { name: "Faturamento diário" });
  const menu = grafico.locator("details.sb-menu");

  // O padrão é 15, e não os 14 do frame: 14 não está na lista fechada do app
  // (`lib/period.ts`), e uma sexta opção só para a Home recriaria a divergência
  // de vocabulário que D-308 fechou.
  await expect(menu.locator("summary")).toContainText("Últimos 15 dias");
  await expect(grafico.getByText(/últimos 15 dias · todas as contas conectadas/)).toBeVisible();

  // A faixa, em 30 dias — o outro bloco, com a outra janela.
  await expect(page.getByText(/últimos 30 dias \(/)).toBeVisible();

  await menu.locator("summary").click();
  await menu.getByRole("link", { name: "Últimos 7 dias" }).click();

  await expect(page).toHaveURL(/\?serie=7$/);
  await expect(grafico.getByText(/últimos 7 dias/)).toBeVisible();

  // A PROVA: a faixa não se mexeu.
  await expect(page.getByText(/últimos 30 dias \(/)).toBeVisible();

  // E o padrão fica FORA da URL: `/` continua sendo o endereço da Home padrão.
  await menu.locator("summary").click();
  await menu.getByRole("link", { name: "Últimos 15 dias" }).click();

  await expect(page).toHaveURL(/\/$/);
});

/**
 * A IDADE DO FATO, NÃO A DO AVISO (D-311).
 *
 * O feed mostrava `notifications.created_at`, o instante em que o fan-out
 * gravou o aviso. O seed torna a diferença visível de propósito: os dois
 * eventos de preço nascem com `occurred_at` de **2 dias** e **1 dia** atrás,
 * enquanto as notificações são gravadas no instante do seed. Lendo a coluna
 * errada, as duas linhas diriam a mesma idade fresca; lendo a certa, elas
 * dizem quando o preço mudou.
 *
 * O desvio máximo já medido nesta casa entre as duas colunas foi de 278 dias
 * (D-060), num backfill — o caso existe para que ninguém volte a coluna.
 */
test("Home: o feed diz a idade do FATO, e não a do aviso", async ({ page }) => {
  await login(page, "/");

  const feed = page.getByRole("region", { name: "Atividade recente" });

  await expect(feed.getByText(/há 2 dias/)).toBeVisible();
  await expect(feed.getByText(/há 1 dia/)).toBeVisible();

  /*
    E a data exata não se perde: ela vive no `title` da linha, que é onde uma
    auditoria vai procurar. `formatAge` devolve `null` acima de sete dias e a
    linha volta a mostrar o absoluto — por isso a asserção é sobre o atributo,
    e não sobre a ausência de data no texto.
  */
  const primeira = feed.locator("small").first();

  await expect(primeira).toHaveAttribute("title", /\d{2}\/\d{2}\/\d{4}/);
});
