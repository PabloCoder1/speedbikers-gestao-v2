import { expect, test } from "@playwright/test";

import { E2E_ACAO_RECLAMACAO } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/acoes` — a Central de Ações depois da migração para o frame
 * `IntelligenceScreen type="actions"` (D23, D-263): painel de filtros à
 * esquerda, fila em cartões à direita.
 *
 * **A migração consertou um defeito vivo, e é o que mais importa aqui.** A tela
 * lia `actions` sem `limit` contra o `max_rows = 1000` do PostgREST e imprimia
 * "N aberto(s)" com N = tamanho do que voltou. No Dev há 1.449 abertas: ela
 * mostrava 1.000, escondia 449 e chamava isso de total (D-131). Local não dá
 * para reproduzir o volume; o que este arquivo protege é a JANELA declarada
 * que substituiu a contagem crua.
 *
 * O que mais este arquivo protege:
 *
 *  1. **As três recusas ao frame.** Não há "Executar fila em lote" (as escritas
 *     são por ação, sobre objetos heterogêneos), não há prioridade "Crítica"
 *     (`severity` tem três valores) e a ordenação não é um menu (é única e
 *     canônica, ARCHITECTURE secao 16);
 *  2. **a linha-sentinela**, que é a razão de o painel sobreviver a um filtro
 *     sem resultado — o teste mais valioso do arquivo;
 *  3. **"Baixa 0"**, o zero MEDIDO do painel: chave ausente no mapa de facetas
 *     é valor sem linha, e esconder a linha é que seria a mentira (D-250);
 *  4. **nada de funcionalidade sumiu** na troca de tabela por cartão: as cinco
 *     escritas continuam ao alcance.
 */

test("/acoes: a fila em cartões, com a janela declarada e as recusas ao frame", async ({ page }) => {
  await login(page, "/acoes");

  await expect(page.getByRole("heading", { name: "Central de Ações", level: 1 })).toBeVisible();
  await expect(page.getByText("VISÃO GERAL / INBOX")).toBeVisible();

  /*
    A JANELA, no lugar da contagem crua. Três ações no seed, uma página — a
    frase diz o total, não o tamanho do que coube.
  */
  await expect(page.getByText("3 ações pendentes", { exact: false })).toBeVisible();

  // A ordem é declarada como FRASE, não oferecida como menu.
  await expect(page.getByText("Ordenado por impacto financeiro estimado")).toBeVisible();
  await expect(page.getByRole("button", { name: /Ordenar/ })).toHaveCount(0);

  /*
    AS DUAS RECUSAS QUE O FRAME DESENHA E O SISTEMA NÃO SUSTENTA.

    "Executar fila em lote" seria escrita em massa sobre objetos heterogêneos —
    "executar" significa coisa diferente para cada `kind`. E "Crítica" não é um
    valor de `severity`: o `check` da tabela conhece três, e nenhum é crítico.
  */
  await expect(page.getByRole("button", { name: /lote/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Crítica/i })).toHaveCount(0);

  // O cartão do fixture de reclamações, com a recomendação e a evidência.
  await expect(page.getByRole("heading", { name: "Reclamações recorrentes", level: 3 })).toBeVisible();
  await expect(page.getByText(E2E_ACAO_RECLAMACAO.recomendacao)).toBeVisible();
  await expect(page.getByText(E2E_ACAO_RECLAMACAO.evidencia)).toBeVisible();

  /*
    NADA DE FUNCIONALIDADE SAIU. O frame desenha dois botões e os esconde até o
    hover; aqui são cinco e ficam sempre visíveis — `opacity: 0` não tira do
    foco, e sem ponteiro não há hover.
  */
  for (const nome of ["Assumir", "Resolver", "Descartar", "Registrar decisão", "Explicar com IA"]) {
    await expect(page.getByRole("button", { name: nome }).first()).toBeVisible();
  }
});

test("/acoes: o painel conta o inbox INTEIRO e sobrevive a um recorte vazio", async ({ page }) => {
  await login(page, "/acoes");

  const painel = page.getByRole("navigation", { name: "Filtros da fila" });

  /*
    As contagens saem do inbox inteiro. "Baixa 0" é o zero MEDIDO — o mapa de
    facetas vem de `jsonb_object_agg` sobre todas as abertas, então chave
    ausente é valor sem linha, e mostrar a linha com 0 é mais honesto do que
    escondê-la (D-250).
  */
  await expect(painel.getByRole("link", { name: "Todas as ações 3" })).toBeVisible();
  await expect(painel.getByRole("link", { name: "Alta prioridade 1" })).toBeVisible();
  await expect(painel.getByRole("link", { name: "Média 2" })).toBeVisible();
  await expect(painel.getByRole("link", { name: "Baixa 0" })).toBeVisible();

  /*
    Os tipos vêm do DADO, não de uma lista fixa: `actions.kind` não tem `check`
    constraint, e um tipo novo gravado pelo detector precisa aparecer sozinho.
  */
  await expect(painel.getByRole("link", { name: "Venda anômala 2" })).toBeVisible();
  await expect(painel.getByRole("link", { name: "Reclamações recorrentes 1" })).toBeVisible();

  /*
    O TESTE MAIS VALIOSO DO ARQUIVO — a linha-sentinela.

    "Baixa" não tem nenhuma linha. Antes da sentinela, `facetas cross join base`
    devolvia ZERO linhas nesse caso e o painel inteiro sumia junto com elas:
    o operador ficava sem contagem e sem caminho de volta, exatamente quando
    mais precisa dos dois. Agora a fila esvazia e o painel continua de pé.
  */
  await painel.getByRole("link", { name: "Baixa 0" }).click();

  await expect(page).toHaveURL(/prioridade=baixa/);

  // A barra declara a janela vazia; o corpo diz para onde ir. As duas frases
  // eram a MESMA e este teste pegou, por ambiguidade — o defeito estava na
  // tela, não no seletor.
  await expect(page.getByText("Nenhuma ação neste recorte.", { exact: true })).toBeVisible();
  await expect(page.getByText("O painel à esquerda conta o que a fila tem fora deste recorte.")).toBeVisible();

  await expect(painel.getByRole("link", { name: "Todas as ações 3" })).toBeVisible();
  await expect(painel.getByRole("link", { name: "Venda anômala 2" })).toBeVisible();
});

test("/acoes: o filtro de tipo recorta a fila e mora na URL", async ({ page }) => {
  await login(page, "/acoes");

  const painel = page.getByRole("navigation", { name: "Filtros da fila" });

  await painel.getByRole("link", { name: "Reclamações recorrentes 1" }).click();

  // O filtro mora na URL — sem isso o link para o recorte não existiria e o
  // voltar do navegador não funcionaria.
  await expect(page).toHaveURL(/tipo=reclamacoes_recorrentes/);
  await expect(page.getByText("1 ação pendente", { exact: false })).toBeVisible();

  // A fila recortou; o painel continua contando o inbox inteiro.
  await expect(page.getByRole("heading", { name: "Reclamações recorrentes", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Venda anômala/, level: 3 })).toHaveCount(0);
  await expect(painel.getByRole("link", { name: "Todas as ações 3" })).toBeVisible();
});
