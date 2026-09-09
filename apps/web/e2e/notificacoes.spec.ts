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
    E o "Filtrar" do cabeçalho da lista: a tela não tem filtro nenhum hoje, e
    acrescentá-los é funcionalidade, não composição — mesma linha que recusou a
    exportação de /precos (D-264). Fica registrado como candidata: com 8.350
    não lidas, um recorte "só não lidas" seria útil.
  */
  await expect(page.getByRole("button", { name: /^Filtrar/ })).toHaveCount(0);

  // A linha continua carregando tudo o que a notificação tem: selo, tipo,
  // entidade com link, o diff e a hora.
  await expect(page.getByRole("button", { name: "Marcar como lida" }).first()).toBeVisible();
});
