import { expect, test } from "@playwright/test";

import {
  E2E_DECISION_TEXT,
  E2E_LISTINGS,
  E2E_LISTING_DECISION_TEXT,
  E2E_LISTING_FULL,
  E2E_LISTING_PRICE_EVENT,
  E2E_LISTING_RELIST,
  E2E_LISTING_TRAFFIC,
} from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/anuncios/[itemId]` — o Dashboard do Anúncio depois da migração para as oito
 * abas (D13).
 *
 * **Esta rota existe desde D-168 e nunca teve e2e.** Ela era uma página de
 * seções verticais; agora tem `ObjectHeader` + `Visão geral | Vendas | Tráfego |
 * Preço | Full | Histórico | Diagnóstico | Decisões`, e cada aba dispara só as
 * suas consultas.
 *
 * O que este teste protege, em ordem de gravidade:
 *
 *  1. **A aba Diagnóstico RECUSA.** Não existe baseline por anúncio, e a
 *     tentação de rodar a fórmula do SKU sobre o recálculo por anúncio produz
 *     um número com a mesma cara e outra definição (D-023). Se um dia a aba
 *     passar a estampar número, este teste fica vermelho.
 *  2. **O cabeçalho LEVA à republicação, e não republica.** Este item dizia "a
 *     tela não republica" e ficou falso em D-295, que trouxe os dois atos para
 *     a aba Histórico. Desde D-310 o cabeçalho aponta para lá — e o que se
 *     guarda agora é a separação: caminho no cabeçalho, ato no painel, um
 *     lugar só de escrita.
 *  3. **Full é o mesmo número da lista.** O anúncio tem grão próprio de Full
 *     (D-243); mostrar aqui o total do SKU na conta seria dois números sob o
 *     mesmo rótulo.
 *  4. **Ausência não é zero** nas abas sem dado.
 */

const COM_DADO = E2E_LISTING_TRAFFIC.itemId;
const SEM_DADO = E2E_LISTINGS.find((a) => a.itemId !== COM_DADO && a.vinculo === "nenhum")?.itemId ?? "";

test("Dashboard do Anúncio: cabeçalho, oito abas e a Visão geral com número real", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}`);

  await expect(page.getByRole("heading", { level: 1, name: "Detalhe do anúncio" })).toBeVisible();

  // O identificador é o MLB, em mono acima do título — o cabeçalho de entidade.
  await expect(page.getByText(COM_DADO, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: E2E_LISTINGS.find((a) => a.itemId === COM_DADO)?.title ?? "" }),
  ).toBeVisible();

  // As oito abas do dono, nesta ordem.
  const abas = page.getByRole("navigation", { name: "Abas do anúncio" });

  for (const rotulo of ["Visão geral", "Vendas", "Tráfego", "Preço", "Full", "Histórico", "Diagnóstico", "Decisões"]) {
    await expect(abas.getByRole("link", { name: rotulo, exact: true })).toBeVisible();
  }

  // Visão geral: os quatro indicadores do frame, com os números do seed.
  // O rótulo é casado EXATO: a nota do cartão de Conversão contém a palavra
  // "visitas", e um `hasText` solto pegaria os dois cartões.
  const cartao = (rotulo: string) =>
    page.locator(".sb-stat", { has: page.getByText(rotulo, { exact: true }) }).locator(".sb-stat-value");

  await expect(cartao("Visitas (30d)")).toHaveText(String(E2E_LISTING_TRAFFIC.visits));
  await expect(cartao("Vendas (30d)")).toHaveText(String(E2E_LISTING_TRAFFIC.units));

  // A ação DESTE anúncio (mlb_id) aparece; a do SKU, não.
  await expect(page.getByText("Conferir se o anúncio perdeu exposição antes de mexer no preço.")).toBeVisible();
});

/**
 * A FILEIRA DE FATOS DO CABEÇALHO (D-310).
 *
 * O frame põe "Preço · Tipo · Catálogo" abaixo do título do objeto. Tipo e
 * Catálogo não existem em `listings`; preço e `available_quantity` existem, são
 * NOT NULL e já vinham no `select` — e `available_quantity` não era impresso em
 * NENHUMA das oito abas. Este caso guarda os dois números no lugar onde o
 * cabeçalho os promete: visível em qualquer aba, e não dentro da nota de um
 * cartão que só existe quando a RPC de resumo devolve linha.
 */
test("Dashboard do Anúncio: o cabeçalho diz preço e disponível, e o preço tem UM dono", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}`);

  const fato = (rotulo: string) =>
    page.locator(".sb-object-metric", { has: page.getByText(rotulo, { exact: true }) });

  const seed = E2E_LISTINGS.find((a) => a.itemId === COM_DADO);

  /*
    `toContainText` com o número, e NÃO a string "R$ 189,90": o `Intl` pt-BR
    separa símbolo e valor com espaço NÃO SEPARÁVEL (U+00A0), e a igualdade
    com espaço comum reprova sem que nada esteja errado.
  */
  await expect(fato("Preço atual")).toContainText(String(seed?.price ?? "").replace(".", ","));
  await expect(fato("Disponível (este anúncio)").locator(".sb-object-metric-value")).toHaveText(
    String(seed?.available ?? ""),
  );

  /*
    UM DONO POR DADO, na mesma afirmação. O preço morava também na nota do
    cartão de Faturamento; deixar os dois seria a tela dizendo o mesmo número
    em dois lugares, e separar este caso em dois deixaria passar tanto a
    "correção" que devolve o rabisco quanto a que apaga a nota sem pôr a faixa.
  */
  await expect(page.locator(".sb-stat-note", { hasText: "preço atual" })).toHaveCount(0);
});

test("Dashboard do Anúncio: zero disponível é zero MEDIDO, e aparece", async ({ page }) => {
  const semEstoque = E2E_LISTINGS.find((a) => a.available === 0);

  await login(page, `/anuncios/${semEstoque?.itemId ?? ""}`);

  /*
    `available_quantity` é NOT NULL: zero aqui é fato, não ausência. O caso
    fica vermelho se alguém "melhorar" a célula com guarda falsy
    (`available_quantity || "—"`), que trocaria um fato medido por um traço de
    não-medido — a classe de mentira de D-067.
  */
  await expect(
    page
      .locator(".sb-object-metric", { has: page.getByText("Disponível (este anúncio)", { exact: true }) })
      .locator(".sb-object-metric-value"),
  ).toHaveText("0");
});

/**
 * CAMINHO NO CABEÇALHO, ATO NO PAINEL (D-310).
 *
 * As duas metades no MESMO caso de propósito: a falha perigosa é alguém mover
 * o gatilho de escrita para o cabeçalho, e dois casos separados continuariam
 * verdes um de cada vez.
 */
test("Dashboard do Anúncio: o cabeçalho leva à republicação — e não republica", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}`);

  const caminho = page.getByRole("link", { name: /Republicações/ });

  await expect(caminho).toBeVisible();

  // Nenhum dos dois atos de D-295 encosta no cabeçalho.
  await expect(page.getByRole("button", { name: "Pedir republicação" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Executar republicação" })).toHaveCount(0);

  await caminho.click();

  await expect(page).toHaveURL(/\?aba=historico$/);
  await expect(page.getByRole("heading", { name: "Republicações" })).toBeVisible();

  // E lá dentro, sim: o ato existe, para quem tem papel.
  await expect(page.getByRole("button", { name: "Pedir republicação" })).toBeVisible();

  // Chegando, o caminho some — link para a aba aberta não leva a lugar nenhum.
  await expect(page.getByRole("link", { name: /Republicações/ })).toHaveCount(0);
});

test("Dashboard do Anúncio: Preço e Full mostram o que foi observado, com o mesmo grão da lista", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}?aba=preco`);

  // A mudança de preço observada vem do evento de domínio, formatada como diff.
  await expect(page.getByRole("heading", { name: "Mudanças de preço observadas" })).toBeVisible();

  // Escopado à TABELA: o preço atual vive no CABEÇALHO desde D-310 (saiu do
  // subtítulo deste painel), e o que se afirma aqui é o diff observado
  // (de → para), não o preço de hoje.
  const linhaDoDiff = page.locator("tbody tr").first();

  await expect(linhaDoDiff).toContainText(String(E2E_LISTING_PRICE_EVENT.de).replace(".", ","));
  await expect(linhaDoDiff).toContainText(String(E2E_LISTING_PRICE_EVENT.para).replace(".", ","));

  // Full: o número do ANÚNCIO, o mesmo que a lista mostra (D-243) — não o
  // total do SKU na conta.
  await page.goto(`/anuncios/${COM_DADO}?aba=full`);
  await expect(page.locator(".sb-stat", { hasText: "No Full (este anúncio)" }).locator(".sb-stat-value")).toHaveText(
    String(E2E_LISTING_FULL),
  );
});

test("Dashboard do Anúncio: Histórico mostra a republicação em PORTUGUÊS", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}?aba=historico`);

  await expect(page.getByRole("heading", { name: "Republicações" })).toBeVisible();

  /*
    O ESTADO É RÓTULO, NÃO CÓDIGO (D-295). Esta tabela imprimia
    `PREFLIGHT_FAILED` na frente de quem opera — a mesma classe que D-273 achou
    em Sincronização ("done", minúsculo, numa coluna chamada Status). Aqui pesa
    mais: é por este texto que alguém decide se aperta o botão irreversível.
  */
  await expect(page.getByText("Reprovada na conferência").first()).toBeVisible();
  await expect(page.getByText(E2E_LISTING_RELIST.status, { exact: true })).toHaveCount(0);
  await expect(page.getByText(E2E_LISTING_RELIST.failureReason)).toBeVisible();
});

test("Dashboard do Anúncio: Diagnóstico recusa por anúncio, e as abas sem dado dizem ausência", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}?aba=diagnostico`);

  // Recusa explícita: não há baseline por anúncio, e a aba manda para o SKU.
  await expect(page.getByText(/baseline do SKU/)).toBeVisible();
  await expect(page.getByRole("link", { name: /abrir o diagnóstico/i })).toBeVisible();
  // E não estampa nenhum número de diagnóstico.
  await expect(page.locator(".sb-stat-value")).toHaveCount(0);

  // O anúncio SEM tráfego: ausência de coleta é dita, não vira zero (D-123).
  await page.goto(`/anuncios/${SEM_DADO}?aba=trafego`);
  await expect(page.getByText(/Nenhum dia com coleta de visitas/)).toBeVisible();

  // E sem vínculo de SKU, o Full não é rastreável — a tela diz isso.
  await page.goto(`/anuncios/${SEM_DADO}?aba=full`);
  await expect(page.getByText(/Sem vínculo de SKU/).first()).toBeVisible();
});

/**
 * Decisões do ANÚNCIO — o embed filtra por `actions.mlb_id`, não por SKU. A
 * decisão do SKU (que o seed também cria) não pode vazar para cá: são duas
 * memórias distintas sobre entidades distintas.
 */
test("Dashboard do Anúncio: Decisões mostra a decisão DESTE anúncio, e só ela", async ({ page }) => {
  await login(page, `/anuncios/${COM_DADO}?aba=decisoes`);

  await expect(page.getByRole("heading", { name: "Decisões registradas" })).toBeVisible();
  await expect(page.getByText(E2E_LISTING_DECISION_TEXT)).toBeVisible();
  await expect(page.getByText(E2E_DECISION_TEXT)).toHaveCount(0);

  // O retrato do momento vem bruto, sem porcentagem de resultado (D-228).
  await expect(page.getByText(/No momento da decisão/)).toBeVisible();

  // O anúncio sem ação não inventa decisão.
  await page.goto(`/anuncios/${SEM_DADO}?aba=decisoes`);
  await expect(page.getByText(/Nenhuma decisão registrada para este anúncio/)).toBeVisible();
});
