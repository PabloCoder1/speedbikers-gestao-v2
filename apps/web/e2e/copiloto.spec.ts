import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * Copiloto (`/copiloto`) — D36, D-276.
 *
 * **O frame não tem esta tela.** O Copiloto do Figma é uma gaveta de 420px à
 * direita, aberta de qualquer página; o grupo de Administração do desenho
 * termina em Configurações. A gaveta ficou fora porque o que ela promete —
 * "o Copiloto lerá os dados desta tela" — não existe: `/v1/copilot/chat`
 * recebe UMA mensagem, sem parâmetro de tela.
 *
 * A API não sobe na suíte de e2e, então o que se prova aqui é o que a web
 * possui: as sugestões, o envio e o estado vazio. A conversa em si tem teste
 * próprio em `apps/api`.
 *
 * ⚠️ **A GAVETA ENTROU EM D-294**, depois que D-293 pagou a pré-condição
 * (contexto na API e ferramentas além de venda). Ela tem suíte própria em
 * `copiloto-gaveta.spec.ts`; o que este arquivo guarda é a TELA CHEIA, que
 * continua sendo a conversa longa e continua sem contexto — porque não está
 * em cima de entidade nenhuma.
 */

test("/copiloto: as sugestões são as três ferramentas que existem, em português", async ({ page }) => {
  await login(page, "/copiloto");

  await expect(page.getByRole("heading", { name: "Copiloto", level: 1 })).toBeVisible();

  const conversa = page.getByRole("region", { name: "Conversa" });

  // Uma por ferramenta: resumo, comparação de período, comparação de conta.
  await expect(conversa.getByRole("button", { name: "Como foram as vendas nos últimos 7 dias?" })).toBeVisible();
  await expect(
    conversa.getByRole("button", { name: "Comparado com o período anterior, vendi mais ou menos?" }),
  ).toBeVisible();
  await expect(conversa.getByRole("button", { name: "Qual conta vendeu mais neste mês?" })).toBeVisible();
});

test("/copiloto: as onze perguntas que o frame sugere e o sistema não responde não aparecem", async ({ page }) => {
  await login(page, "/copiloto");

  /*
    ÂNCORA POSITIVA ANTES DAS AUSÊNCIAS, e ela não é formalidade: este caso
    passou verde uma vez rodando contra a TELA DE LOGIN, porque o banco estava
    sem seed e o login falhou. Teste que só afirma ausência passa em qualquer
    página — inclusive na errada.
  */
  await expect(page.getByRole("heading", { name: "Copiloto", level: 1 })).toBeVisible();

  /*
    O drawer do Figma oferece doze perguntas prontas e o Copiloto tem TRÊS
    ferramentas, todas de venda. Uma delas pede "histórico de exposição", que é
    justamente o dado de tráfego que D-266 mediu como inexistente no esquema —
    o desenho é coerente consigo mesmo e incoerente com o sistema duas vezes.

    Sugestão que o sistema não responde é pior que campo vazio: o campo não
    promete nada, e a sugestão promete e falha depois de gastar uma chamada
    paga.
  */
  for (const promessa of [
    /risco de ruptura/i,
    /anúncio com problema/i,
    /analisar conversão/i,
    /sugerir novo preço/i,
    /histórico de exposição/i,
    /risco de mediação/i,
    /rastreio detalhado/i,
    /por que a cobertura caiu/i,
    /quanto enviar ao full/i,
    /últimas movimentações/i,
  ]) {
    await expect(page.getByRole("button", { name: promessa })).toHaveCount(0);
  }
});

test("/copiloto: clicar numa sugestão pergunta, e as sugestões saem de cena", async ({ page }) => {
  await login(page, "/copiloto");

  const conversa = page.getByRole("region", { name: "Conversa" });
  const sugestao = conversa.getByRole("button", { name: "Qual conta vendeu mais neste mês?" });

  await sugestao.click();

  /*
    A pergunta vai por PARÂMETRO, não pelo estado do campo: `setDraft` é
    assíncrono, e ler o campo logo depois de escrevê-lo mandaria a pergunta
    anterior — ou vazia, na primeira vez. O balão prova que foi a certa.
  */
  await expect(conversa.getByText("Qual conta vendeu mais neste mês?")).toBeVisible();

  // Depois da primeira pergunta as sugestões viram ruído e somem.
  await expect(sugestao).toHaveCount(0);

  /*
    A API não sobe nesta suíte, então a resposta é uma falha declarada — e é
    isso que importa aqui: a tela diz que não conseguiu, em vez de ficar
    girando ou fingir que respondeu.
  */
  await expect(conversa.getByText(/Não foi possível consultar o Copiloto|Falha de conexão/)).toBeVisible();
});

test("/copiloto: a TELA não finge ser a gaveta, e diz que não guarda histórico", async ({ page }) => {
  await login(page, "/copiloto");

  /*
    A gaveta EXISTE desde D-294 — e ela mora na barra de topo, aberta por cima
    da tela em que você está (`copiloto-gaveta.spec.ts`). Esta tela continua
    sendo a conversa longa, e por isso continua sem selo de contexto: ela não
    está em cima de SKU nenhum, e afirmar contexto aqui seria a promessa vazia
    que D-276 recusou.
  */
  await expect(page.getByText(/Contexto atual/i)).toHaveCount(0);
  await expect(page.getByText(/Análise Pronta/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Gerar ação/i })).toHaveCount(0);

  /*
    E a ausência de histórico é DITA, não deixada para o usuário descobrir: a
    conversa não continua entre perguntas, e nenhuma tabela guarda o que foi
    perguntado.
  */
  await expect(page.getByText(/não há histórico entre uma e outra/)).toBeVisible();
});
