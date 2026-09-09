import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * Central de Notificações (`/notificacoes`) pelo frame `CentralScreen` na
 * variação de alertas (D29, D-269).
 *
 * **Este é o PRIMEIRO spec desta tela**, que tem duas escritas (marcar uma como
 * lida e marcar todas) e nunca foi visitada por teste nenhum.
 *
 * O que este arquivo protege:
 *
 *  1. **a contagem que D-183 corrigiu** — `unreadCount` já foi
 *     `rows.filter(...).length`, contando as não lidas ENTRE AS 100
 *     CARREGADAS. Com 42.511 notificações e 8.350 não lidas no Dev, o botão
 *     "Marcar todas como lidas" SUMIA depois de ler as 100 mais recentes,
 *     deixando milhares sem forma de limpar. A contagem vem de `count: exact`,
 *     e este teste existe para que ela não volte a sair da lista;
 *  2. **o painel de detalhe do frame NÃO entrou** — ele repete os campos da
 *     linha e acrescenta um "Impacto estimado R$ 8.400" que não tem fonte:
 *     `notifications` tem QUATRO colunas e zero de impacto (D-023).
 */

test("/notificacoes: a janela e as não lidas vêm de contagem própria, não da lista", async ({ page }) => {
  await login(page, "/notificacoes");

  await expect(page.getByRole("heading", { name: "Central de Notificações", level: 1 })).toBeVisible();
  await expect(page.getByText("CENTRAL / ALERTAS")).toBeVisible();

  /*
    O subtítulo do painel carrega os DOIS fatos: a janela declarada e as não
    lidas. O seed tem duas notificações, ambas não lidas.
  */
  const painel = page.getByRole("region", { name: "Eventos recentes" });

  await expect(painel).toContainText("2 não lida(s)");

  /*
    O BOTÃO QUE SUMIA. Ele só aparece com `unreadCount > 0`, e enquanto a
    contagem saía da página carregada bastava ler as 100 mais recentes para
    ele desaparecer com milhares ainda por ler (D-183).
  */
  await expect(page.getByRole("button", { name: /Marcar todas/i })).toBeVisible();
});

test("/notificacoes: o detalhe do frame não entrou, e o motivo é a falta de fonte", async ({ page }) => {
  await login(page, "/notificacoes");

  /*
    O frame desenha um painel de detalhe ao lado da lista. Ele repete selo,
    título e subtítulo da linha, e acrescenta duas coisas: um "Impacto
    estimado" e uma linha do tempo de contexto.

    O impacto NÃO TEM FONTE — `notifications` tem quatro colunas (id,
    organization_id, domain_event_id, created_at) e nem ela nem `domain_events`
    têm coluna de impacto. Seria número sintetizado (D-023).
  */
  await expect(page.getByText(/Impacto estimado/i)).toHaveCount(0);
  await expect(page.getByText("DETALHE DO EVENTO")).toHaveCount(0);

  /*
    O "Filtrar" do cabeçalho do frame continua fora, e agora por um motivo mais
    forte do que "é funcionalidade": ele sugere um MENU de filtros —
    severidade, tipo, conta — que ninguém pediu e nenhum número sustenta. O
    que entrou em D-290 foi a única candidata que D-269 registrou COM número
    (8.350 não lidas de 42.511), e ela é duas pílulas, não um menu.
  */
  await expect(page.getByRole("button", { name: /^Filtrar/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Não lidas/ })).toBeVisible();

  // A linha continua carregando tudo o que a notificação tem: selo, tipo,
  // entidade com link, o diff e a hora.
  await expect(page.getByRole("button", { name: "Marcar como lida" }).first()).toBeVisible();
});

/**
 * O RECORTE DE NÃO LIDAS (D-290) — a candidata que D-269 registrou com número.
 *
 * **Este caso escreve**: marca UMA das duas notificações do seed como lida, e
 * essa escrita é o único jeito de provar que o filtro separa alguma coisa —
 * com as duas não lidas, "todas" e "não lidas" devolvem a mesma lista e o
 * teste não prova nada. **Sobra uma não lida de propósito** (lição de D-289):
 * a Home conta "Notificações não lidas" e ficaria sem o cartão se esta suíte
 * zerasse a caixa.
 */
test("/notificacoes: o recorte de não lidas separa o que foi lido", async ({ page }) => {
  await login(page, "/notificacoes");

  const painel = page.getByRole("region", { name: "Eventos recentes" });

  await expect(painel).toContainText("2 não lida(s)");

  // Uma é lida — e a pílula passa a dizer "Não lidas (1)", porque o rótulo
  // dela e a contagem do painel são o MESMO número.
  await page.getByRole("button", { name: "Marcar como lida" }).first().click();

  await expect(page.getByRole("link", { name: "Não lidas (1)" })).toBeVisible();

  await page.getByRole("link", { name: "Não lidas (1)" }).click();

  await expect(page).toHaveURL(/estado=nao-lidas/);

  /*
    UMA linha, e a janela conta o RECORTE: com o filtro ligado, dizer "de 2"
    seria descrever um conjunto que não está na tela.
  */
  await expect(page.locator("main li")).toHaveCount(1);
  // Sem ponto final: o painel corta o ponto da frase de `summarizePagedWindow`
  // para emendá-la com o resto do subtítulo.
  await expect(painel).toContainText("1 não lida");
  await expect(painel).not.toContainText("de 2");

  // E "Todas" traz as duas de volta.
  await page.getByRole("link", { name: "Todas" }).click();

  await expect(page).toHaveURL(/\/notificacoes$/);
  await expect(page.locator("main li")).toHaveCount(2);
});

/**
 * A página além do fim — e aqui ela é detectada por ARITMÉTICA, não pelo 416
 * de D-289. Medido: o `PGRST103` só aparece quando a consulta pede
 * `count: exact` junto do `.range()`; sem `count`, o mesmo pedido volta 200 com
 * zero linhas. Esta tela tira as contagens de consultas próprias (D-183), então
 * quem sabe que a página 2 não existe é o total, não o servidor.
 */
test("/notificacoes: página além do fim é página vazia, não falha de leitura", async ({ page }) => {
  await login(page, "/notificacoes?pagina=2");

  await expect(page.getByText(/Esta página não existe neste recorte/)).toBeVisible();
  await expect(page.getByText(/Não foi possível carregar/)).toHaveCount(0);

  await page.getByRole("link", { name: "Voltar à primeira página" }).click();

  await expect(page).toHaveURL(/\/notificacoes$/);
  await expect(page.locator("main li").first()).toBeVisible();
});
