import { expect, test } from "@playwright/test";

import { E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD } from "./constants.js";
import { login, loginAs } from "./helpers.js";

/**
 * Saúde do Sistema (`/saude`) pelo frame `AdminScreen` na variação de
 * confiabilidade (D34, D-274).
 *
 * A sexta tela seguida sem spec. O que ela responde é a pergunta que esta
 * própria trilha precisou fazer várias vezes sem ter onde olhar: **o código
 * que está rodando é o código que eu acho que está rodando?**
 *
 * O frame põe "99,97% de uptime em 30 dias" no lugar dessa resposta. São ZERO
 * tabelas de incidente, uptime, disponibilidade ou SLA no esquema inteiro, e
 * os casos abaixo existem para que esse número não volte por engano.
 */

test("/saude: a âncora responde 'código no ar', e o uptime do frame não existe", async ({ page }) => {
  await login(page, "/saude");

  await expect(page.getByRole("heading", { name: "Saúde do Sistema", level: 1 })).toBeVisible();

  const faixa = page.locator(".sb-kpi-strip").first();
  const ancora = faixa.locator(".sb-kpi").first();

  /*
    Localmente não há VERCEL_GIT_COMMIT_SHA nem API respondendo, e o veredito
    honesto é UNKNOWN — com o motivo ao lado. **UNKNOWN nunca é lido como
    "tudo certo"**: é a tela dizendo que não conseguiu medir.
  */
  await expect(ancora).toContainText("Código no ar");
  await expect(ancora).toContainText("UNKNOWN");

  // Nenhum número de disponibilidade: não há fonte para ele.
  await expect(page.getByText(/uptime/i)).toHaveCount(0);
  await expect(page.getByText(/99,9/)).toHaveCount(0);
  await expect(page.getByText(/SLA/)).toHaveCount(0);

  // "Ver incidentes" tem a mesma resposta: zero tabelas de incidente.
  await expect(page.getByRole("button", { name: /incidentes/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /incidentes/i })).toHaveCount(0);
});

test("/saude: os quatro vereditos de job aparecem, e as partes fecham com o total", async ({ page }) => {
  await login(page, "/saude");

  const painel = page.getByRole("region", { name: "Jobs agendados" });
  const faixa = painel.locator(".sb-kpi-strip");
  const valor = async (rotulo: string): Promise<number> =>
    Number(await faixa.locator(".sb-kpi", { hasText: rotulo }).locator(".sb-kpi-value").innerText());

  const total = await valor("Jobs observados");
  const emDia = await valor("Em dia");
  const atrasando = await valor("Atrasando");
  const parados = await valor("Parados");
  const nunca = await valor("Nunca rodaram");
  const semCadencia = await valor("Sem cadência");

  expect(emDia + atrasando + parados + nunca + semCadencia).toBe(total);

  /*
    O seed cria quatro tipos. Eram um por veredito ate D-304, quando
    `analytics.recompute` ganhou cadencia (o piso `v3-refresh-sales-metrics`) e
    passou de "sem cadencia" para "em dia" — ele roda ha 5 minutos no fixture.
    "Sem cadencia" deixou de ter exemplo aqui, e isso e o certo: quem sobrou
    sem cadencia sao os raros por natureza, que o seed nao cria.
  */
  expect(total).toBe(4);
  expect(emDia).toBe(3);
  expect(parados).toBe(1);
  expect(semCadencia).toBe(0);
});

test("/saude: o job horário mudo há 13h é 'Parado' — o cenário de D-217", async ({ page }) => {
  await login(page, "/saude");

  const painel = page.getByRole("region", { name: "Jobs agendados" });
  const orders = painel.getByRole("row", { name: /sync\.orders\.window/ });

  /*
    A versão anterior desta tela usava um limiar único de 26h para todo job.
    `sync.orders.window` é HORÁRIO: 13h de silêncio é catástrofe para ele e
    folgado sob 26h — e a tela não disse nada por meio dia. O veredito é
    contra a cadência de cada um (D-219).
  */
  await expect(orders).toContainText("Parado");

  /*
    O RECÁLCULO DE MÉTRICAS MUDOU DE LADO EM D-304, e este caso mudou com ele.

    Ele era o exemplo do job sem cadência: movido por chave suja, nenhuma
    venda na hora significava nenhum recálculo, e carimbar atraso ali seria
    gritar sobre o comportamento certo. Agora existe o piso
    `v3-refresh-sales-metrics` (de hora em hora, tenha havido venda ou não): a
    cadência é fixa, o silêncio virou defeito, e defeito merece veredito.

    Sem cadência continuam os raros por natureza — backfill, importação sob
    demanda. O webhook nunca foi exemplo disso: D-232 mediu um limiar de
    silêncio para ele.
  */
  const recompute = painel.getByRole("row", { name: /analytics\.recompute/ });

  // O seed o faz rodar há 5 minutos, contra uma cadência de 60.
  await expect(recompute).toContainText("Em dia");
});

test("/saude: o estado da execução é texto, não código de banco", async ({ page }) => {
  await login(page, "/saude");

  const painel = page.getByRole("region", { name: "Jobs agendados" });

  /*
    A coluna mostrava "done", em inglês e minúsculo — a mesma classe do rótulo
    que faltava na tela vizinha (D-273). O mapa passou a ser um só, porque
    `job_runs.status` e `sync_runs.status` falam o mesmo vocabulário.
  */
  await expect(painel.getByRole("cell", { name: "Concluída" }).first()).toBeVisible();
  await expect(painel.getByText("done", { exact: true })).toHaveCount(0);

  // A falha aparece com nome e é contada: frescor e sucesso são diferentes.
  const listings = painel.getByRole("row", { name: /sync\.listings\.snapshot/ });

  await expect(listings).toContainText("Falhou");
  await expect(listings).toContainText("Em dia");
});

test("/saude: quem não é ADMIN vê a recusa, e a recusa vem da RPC", async ({ page }) => {
  await loginAs(page, E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD, "/saude");

  /*
    `get_system_health` refaz a autorização DENTRO da função e devolve zero
    linhas para quem não é ADMIN. A tela traduz zero linhas em "restrita a
    ADMIN" — e é importante que a recusa seja essa, e não uma tabela vazia
    que pareceria "nenhum job rodou".
  */
  await expect(page.getByText("Esta tela é restrita a ADMIN.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Jobs agendados" })).toHaveCount(0);
});
