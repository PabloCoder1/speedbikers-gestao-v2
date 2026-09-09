import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * Central de Integrações (D-231, refeita em D-232). O que só se prova RODANDO
 * (D-188) é a fiação — as leituras sob RLS, a página inteira quando fontes
 * estão vazias — e as duas regras do item na tela servida:
 *
 *  - "ok exige atividade observada": conexão só fica verde com sincronização
 *    recente de verdade, nunca pela flag `CONNECTED` gravada no OAuth.
 *  - "nunca verde não verificável": nenhuma linha de Configuração, em nenhuma
 *    das seis regiões, pode dizer OK.
 *
 * **A premissa deste arquivo mudou em D-273.** Antes o seed não tinha nenhuma
 * execução, e o teste provava só o lado negativo da primeira regra (conta
 * conectada e sem atividade NÃO é verde). O seed da tela de Sincronização
 * passou a criar execuções reais, então agora os DOIS lados são exercíveis: o
 * Mercado Livre tem sucesso recente e fica verde; o webhook não tem nenhum e
 * continua sem atividade.
 */
test("ADMIN: verde exige atividade observada — nos dois sentidos; nenhuma configuração é OK; zero botões", async ({
  page,
}) => {
  await login(page, "/integracoes");

  await expect(page).toHaveURL(/\/integracoes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Integrações" })).toBeVisible();

  // `exact` NAO e enfeite: `getByRole` casa nome por SUBSTRING, e existe um
  // segundo card chamado "Webhook do Mercado Livre" — sem isso o locator pega
  // as duas regioes e o modo estrito recusa com dois resultados.
  const mercadoLivre = page.getByRole("region", { name: "Mercado Livre", exact: true });
  const conexao = mercadoLivre.getByRole("row", { name: /Conexão/ });

  /*
    O LADO POSITIVO: o seed tem reconciliação bem-sucedida há 20 minutos, e a
    conexão fica verde POR ISSO — não pela flag `CONNECTED`, que já estava lá
    antes de existir qualquer execução.

    `toContainText` na LINHA, não `getByText`: a pílula e a célula que a contém
    têm o mesmo texto, e o modo estrito recusa dois elementos.
  */
  await expect(conexao).toContainText("OK");
  await expect(conexao).toContainText("todas com sincronização recente");

  /*
    O LADO NEGATIVO, na mesma página: o webhook não tem nenhuma execução
    registrada, e a mesma régua o deixa em "Sem atividade". Duas integrações,
    a mesma regra, dois resultados — é isso que prova que a régua é a
    atividade e não a configuração.
  */
  const webhook = page.getByRole("region", { name: "Webhook do Mercado Livre" });
  const conexaoWebhook = webhook.getByRole("row", { name: /Conexão/ });

  await expect(conexaoWebhook).toContainText("Sem atividade");
  await expect(conexaoWebhook).toContainText("nenhum webhook processado registrado");
  await expect(conexaoWebhook).not.toContainText("OK");

  // Em NENHUMA das seis regiões a linha de Configuração pode ser OK.
  for (const regiao of await page.getByRole("region").all()) {
    const configuracao = regiao.getByRole("row", { name: /Configuração/ });

    await expect(configuracao).toBeVisible();
    await expect(configuracao).not.toContainText("OK");
  }

  // O seed passou a ter um lote do UpSeller (D-278), e o caso ficou MAIS forte
  // por isso: antes ele exercitava o caminho vazio, que os unitários de
  // `lib/integrations.ts` já cobrem; agora exercita o caminho COM dado, que é
  // onde a regra "fonte sob demanda nunca vira verde" pode ser violada. Lote
  // aplicado é **Observado**, com a data — nunca OK.
  const upseller = page.getByRole("region", { name: "UpSeller (planilha)" });

  await expect(upseller).toContainText("Observado");
  await expect(upseller).toContainText("último lote: Aplicado");
  await expect(upseller.getByRole("row", { name: /Sincronização/ })).not.toContainText("OK");

  // Um dado, um dono: cada card aponta para a tela dona; nada aqui é ação.
  await expect(mercadoLivre.getByRole("link", { name: "Contas ML" })).toBeVisible();
  await expect(page.getByRole("region").getByRole("button")).toHaveCount(0);
});

/**
 * O que D32 decidiu contra o frame `AdminScreen` na variação de canais
 * (D-272). Três dos elementos que ele desenha não têm fonte, e este caso
 * existe para que voltarem seja vermelho, não uma revisão de olho.
 */
test("/integracoes: o frame desenha três integrações, e duas delas não existem", async ({ page }) => {
  await login(page, "/integracoes");

  /*
    Bling (ERP) e Google Sheets: ZERO ocorrências no repositório inteiro
    (código, SQL e documentação). Desenhar um cartão para elas seria afirmar
    que a operação tem um canal que ela não tem.
  */
  await expect(page.getByText(/Bling/i)).toHaveCount(0);
  await expect(page.getByText(/Google Sheets/i)).toHaveCount(0);

  // A que existe, existe: e o frame acertou até o número de contas do Dev.
  await expect(page.getByRole("region", { name: "Mercado Livre", exact: true })).toBeVisible();

  /*
    "Nova integração" é a ação do cabeçalho do frame. Não há fluxo de
    provisionamento de conector, e criá-lo seria feature, não composição — a
    mesma linha de D-264 e D-269.
  */
  await expect(page.getByRole("button", { name: /Nova integração/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Nova integração/i })).toHaveCount(0);
});

test("/integracoes: cada cartão diz o que a integração COBRE, e isso não é estado", async ({ page }) => {
  await login(page, "/integracoes");

  /*
    A linha de escopo é a descrição do cartão do frame. Ela é autoral e
    descreve a superfície que o código tem — por isso o teste fixa o texto de
    duas delas: se alguém mudar o que a integração faz e esquecer a frase, a
    tela passa a descrever um sistema que não existe mais.
  */
  const ml = page.getByRole("region", { name: "Mercado Livre", exact: true });
  await expect(ml.getByText("Pedidos, anúncios, perguntas e Full, por conta conectada.")).toBeVisible();

  const upseller = page.getByRole("region", { name: "UpSeller (planilha)" });
  await expect(
    upseller.getByText("Lotes de planilha com custos e produtos, conferidos por uma pessoa antes de aplicar."),
  ).toBeVisible();

  // E o vocabulário das pílulas continua declarado — sem ele, "Observado" e
  // "Sem atividade" parecem sinônimos.
  await expect(page.getByText("COMO LER OS ESTADOS")).toBeVisible();
});
