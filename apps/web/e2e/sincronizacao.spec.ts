import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * Sincronização (`/sincronizacao`) pelo frame `AdminScreen` na variação de
 * dados e processamentos (D33, D-273).
 *
 * A tela nunca teve spec — a quinta seguida — e nasceu com um defeito que
 * ninguém viu: `order_financials` tinha rótulo e cadência em mapas
 * DIFERENTES, e faltava nos dois. A tela imprimia a chave crua do banco no
 * lugar do nome e um travessão no lugar do veredito, justamente no recurso
 * com a pior taxa de falha do Dev (16 de 40 execuções em 7 dias).
 *
 * O seed cria uma execução de `order_financials` só para que isso volte a
 * ficar vermelho se alguém separar os dois mapas de novo.
 */

test("/sincronizacao: os oito recursos têm nome, e `order_financials` tem veredito", async ({ page }) => {
  await login(page, "/sincronizacao");

  await expect(page.getByRole("heading", { name: "Sincronização", level: 1 })).toBeVisible();

  const continua = page.getByRole("region", { name: "Sincronização contínua" });

  /*
    A REGRESSÃO. "Custos do pedido" é o rótulo; `order_financials` é a chave
    do banco, e ela não pode aparecer na tela para ninguém.
  */
  await expect(continua.getByRole("cell", { name: "Custos do pedido" })).toBeVisible();
  await expect(page.getByText("order_financials")).toHaveCount(0);

  // E a linha tem veredito, não travessão: a cadência diária existe.
  const linha = continua.getByRole("row", { name: /Custos do pedido/ });
  await expect(linha).toContainText("Em dia");
});

test("/sincronizacao: a faixa conta RECURSOS, e as partes fecham com o total", async ({ page }) => {
  await login(page, "/sincronizacao");

  const faixa = page.locator(".sb-kpi-strip");
  const valor = async (rotulo: string): Promise<number> =>
    Number(await faixa.locator(".sb-kpi", { hasText: rotulo }).locator(".sb-kpi-value").innerText());

  /*
    O frame conta CONTAS ("Atualizadas 3, Com Atenção 1"). Esta faixa conta
    recursos, porque conta não é unidade de frescor — a medição de D-143
    mostrou uma conta "atualizada" com visitas falhando 85% das vezes.

    O seed cria três linhas de reconciliação: pedidos e custos do pedido em
    dia, visitas atrasada.
  */
  const total = await valor("Recursos monitorados");
  const emDia = await valor("Em dia");
  const atrasando = await valor("Atrasando");
  const atrasada = await valor("Atrasada");
  const nunca = await valor("Nunca sincronizado");
  const semCadencia = await valor("Sem cadência");

  expect(emDia + atrasando + atrasada + nunca + semCadencia).toBe(total);
  expect(total).toBe(3);
  expect(emDia).toBe(2);
  expect(atrasada).toBe(1);

  /*
    "Sem cadência" em ZERO é o ponto da célula: ela é o detector de um recurso
    novo no banco sem entrada no mapa — o defeito desta fatia. Se subir de
    zero, alguém acrescentou recurso e esqueceu o nome e a cadência.
  */
  expect(semCadencia).toBe(0);
});

test("/sincronizacao: frescor e cobertura são coisas diferentes, e a tela mostra as duas", async ({ page }) => {
  await login(page, "/sincronizacao");

  const continua = page.getByRole("region", { name: "Sincronização contínua" });
  const visitas = continua.getByRole("row", { name: /Visitas/ });

  // Último sucesso de 5 dias atrás, contra cadência diária: atrasada.
  await expect(visitas).toContainText("Atrasada");

  /*
    E a falha de 2h atrás aparece SOMADA ao veredito, não no lugar dele. É a
    lição de D-143: um recurso pode ter sucesso recente e cobertura degradando
    — o alerta de falha não substitui o frescor.
  */
  await expect(visitas).toContainText("1 de 1 execuções falharam (100%)");
  await expect(visitas).toContainText("429 Too Many Requests");
});

test("/sincronizacao: o que o frame desenha e a tela recusa não aparece", async ({ page }) => {
  await login(page, "/sincronizacao");

  /*
    "Execuções Recentes": `job_runs` não é legível pela web (RLS ligada, zero
    policies, `authenticated` sem SELECT), a coluna "Conta" do frame não tem
    fonte, e 65% das execuções são de um job só — a lista mostraria 25
    webhooks e esconderia as linhas que o frame desenha (D-273).
  */
  await expect(page.getByText(/Execuções Recentes/i)).toHaveCount(0);

  // "Sincronizar agora" e "Filtrar": a tela não escreve e não filtra, e as
  // duas coisas são funcionalidade, não composição (D-264, D-269).
  await expect(page.getByRole("button", { name: /Sincronizar agora/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Filtrar/i })).toHaveCount(0);

  // O backfill não ganha selo de atraso: concluído há 10 dias é o normal.
  const bf = page.getByRole("region", { name: "Backfill" });
  await expect(bf.getByRole("row", { name: /Pedidos/ })).toBeVisible();
  await expect(bf.getByText("Atrasada")).toHaveCount(0);

  /*
    E o status do backfill é texto de interface, não código de banco: a coluna
    mostrava "done", minúsculo e em inglês — a mesma classe do recurso sem
    rótulo, achada na mesma captura (D-273).
  */
  await expect(bf.getByRole("cell", { name: "Concluída" })).toBeVisible();
  await expect(bf.getByText("done", { exact: true })).toHaveCount(0);
});

/**
 * A LISTA DE FALHAS (D-291) — o item que D-273 deixou aberto por escrito.
 *
 * Ela não lê `job_runs`: a tabela continua com RLS e zero policies. Quem lê é
 * `get_job_failures`, `security definer` com a autorização ADMIN refeita
 * dentro, devolvendo AGREGADO — nunca a linha de execução.
 *
 * **O caso central é o agrupamento**, e ele é a razão de a lista existir: no
 * Dev, 473 falhas de 7 dias carregam 170 motivos crus e viram 16 assinaturas,
 * porque o texto do erro traz o id da entidade. O seed reproduz isso em
 * miniatura: duas falhas que diferem só no MLB precisam virar UMA linha.
 */
test("/sincronizacao: as falhas vêm agrupadas por motivo, com o id fora da assinatura", async ({ page }) => {
  await login(page, "/sincronizacao");

  const painel = page.getByRole("region", { name: "Execuções que falharam" });

  await expect(painel).toBeVisible();

  // As duas falhas de `/items/MLB…` do seed: uma linha só, com o id virando #.
  const familia = painel.getByRole("row", { name: /GET \/items\/MLB#/ });

  await expect(familia).toHaveCount(1);
  await expect(familia).toContainText("2 motivos nesta família");

  // O código HTTP SOBREVIVE à assinatura — é ele que diz o que investigar, e
  // por isso a normalização só apaga corridas de 4+ dígitos.
  await expect(familia).toContainText("404");

  // E o exemplo cru devolve o id que a assinatura apagou.
  await expect(familia).toContainText("MLB440000000");

  // A falha 429 do seed é outra família, e traz o retryable do banco.
  await expect(painel.getByRole("row", { name: /429 Too Many Requests/ })).toHaveCount(1);
});

/**
 * A recusa de D-273 continua de pé, e é maior que a lista que entrou: o frame
 * desenha execuções INDIVIDUAIS, com uma coluna "Conta" que `job_runs` não
 * tem.
 */
test("/sincronizacao: a lista de falhas não virou o log cru que o frame desenha", async ({ page }) => {
  await login(page, "/sincronizacao");

  const painel = page.getByRole("region", { name: "Execuções que falharam" });

  // Sem colunas de execução individual: conta, duração e itens processados.
  await expect(painel.getByRole("columnheader", { name: "Conta" })).toHaveCount(0);
  await expect(painel.getByRole("columnheader", { name: /Dura/ })).toHaveCount(0);
  await expect(painel.getByRole("columnheader", { name: /Itens/ })).toHaveCount(0);

  // E as chaves internas do worker não vazam para a tela.
  await expect(painel.getByText(/dedupe/i)).toHaveCount(0);
  await expect(painel.getByText(/e2e:seed:/)).toHaveCount(0);
});
