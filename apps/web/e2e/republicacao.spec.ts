import { expect, test } from "@playwright/test";

import { E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD, E2E_LISTINGS, E2E_LISTING_RELIST } from "./constants.js";
import { login, loginAs } from "./helpers.js";

/**
 * A SUPERFÍCIE DE CONFIRMAÇÃO HUMANA DA REPUBLICAÇÃO (D-295) — o item que
 * D-164 deixou declarado quando a Fase 9 fechou no backend: *"o que NÃO
 * existe: UI"*.
 *
 * **A API não sobe na suíte de e2e**, então nada aqui republica de verdade —
 * e isso é adequado ao caso: a primeira republicação real contra o Mercado
 * Livre é ensaio humano deliberado, com anúncio sacrificável (D-162). O que
 * esta suíte guarda é a parte que a web possui, e que é justamente onde o
 * dano mora: **quem vê o botão, o que a confirmação diz, e o que ela exige
 * antes de deixar apertar.**
 */

const REPROVADA = E2E_LISTINGS[0].itemId;
const AGUARDANDO = E2E_LISTINGS[1].itemId;

test("o pedido explica que NADA é fechado neste ato", async ({ page }) => {
  await login(page, `/anuncios/${REPROVADA}?aba=historico`);

  await page.getByRole("button", { name: "Pedir republicação" }).click();

  const caixa = page.getByRole("dialog", { name: `Pedir republicação de ${REPROVADA}` });

  /*
    A confirmação do ato INOFENSIVO diz que ele é inofensivo. Não é detalhe de
    redação: se o pedido assustar como a execução, a pessoa hesita no lugar
    errado — e relaxa no lugar certo.
  */
  await expect(caixa).toContainText("não fecha nada");
  await expect(caixa).toContainText("aguardando execução");

  // Cancelar não deixa rastro nem dispara nada.
  await caixa.getByRole("button", { name: "Cancelar" }).click();
  await expect(caixa).toHaveCount(0);
});

test("a execução nomeia o irreversível e exige a ciência antes de destravar", async ({ page }) => {
  await login(page, `/anuncios/${AGUARDANDO}?aba=historico`);

  // Âncora positiva: a operação existe e está no estado que oferece o ato.
  await expect(page.getByText("Aguardando execução").first()).toBeVisible();

  await page.getByRole("button", { name: "Executar republicação" }).click();

  const caixa = page.getByRole("dialog", { name: `Fechar ${AGUARDANDO} e republicar` });

  await expect(caixa).toContainText("fechado no Mercado Livre");
  await expect(caixa).toContainText("irreversível");
  // A promessa que o PRD proíbe: exposição recuperada. A caixa diz o contrário.
  await expect(caixa).toContainText("não herda visitas nem vendas");
  // E que a conferência roda DE NOVO na hora (D-162) — o estado muda entre os atos.
  await expect(caixa).toContainText("de novo agora");

  /*
    O GESTO A MAIS. Fechar um anúncio é irreversível, e um clique errado não
    pode bastar: o botão nasce travado e só a ciência marcada o destrava.
  */
  const confirmar = caixa.getByRole("button", { name: "Fechar e republicar" });

  await expect(confirmar).toBeDisabled();

  await caixa.getByRole("checkbox").check();

  await expect(confirmar).toBeEnabled();

  await caixa.getByRole("button", { name: "Cancelar" }).click();
  await expect(caixa).toHaveCount(0);
});

test("com operação viva, a tela mostra o estado em vez de oferecer outro pedido", async ({ page }) => {
  await login(page, `/anuncios/${AGUARDANDO}?aba=historico`);

  await expect(page.getByText("Aguardando execução").first()).toBeVisible();

  /*
    `listing_relists_one_live_per_parent` admite UMA operação viva por pai:
    oferecer "Pedir republicação" aqui prometeria um 409. A tela mostra a
    operação e o caminho que ela permite.
  */
  await expect(page.getByRole("button", { name: "Pedir republicação" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Executar republicação" })).toBeVisible();
});

test("a operação REPROVADA não oferece execução — e o pedido volta a ser possível", async ({ page }) => {
  await login(page, `/anuncios/${REPROVADA}?aba=historico`);

  // O motivo da reprovação continua escrito, com o rótulo em português.
  await expect(page.getByText("Reprovada na conferência").first()).toBeVisible();
  await expect(page.getByText(E2E_LISTING_RELIST.failureReason)).toBeVisible();

  /*
    PREFLIGHT_FAILED é terminal e fica FORA do índice de operação viva: pedir
    de novo é legítimo (o anúncio pode ter mudado), executar não é.
  */
  await expect(page.getByRole("button", { name: "Executar republicação" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pedir republicação" })).toBeVisible();
});

/**
 * O QUE ESTE CASO ME ENSINOU, e por isso ele existe assim.
 *
 * Escrevi-o esperando "GESTOR também vê o botão" e ele reprovou: o GESTOR do
 * seed **não enxerga o anúncio nenhum**. Não é defeito — é D-117 funcionando:
 * `has_account_access` dá acesso a ADMIN por organização e a todo o resto
 * SÓ por `user_account_permissions`, e o seed não concede nenhuma.
 *
 * O que sobra é uma afirmação mais forte do que a que eu queria: a superfície
 * do ato irreversível não aparece nem por engano para quem o servidor
 * recusaria — a página inteira some antes disso. A recusa por PAPEL (OPERADOR
 * não republica) vive na rota e tem teste em `apps/api`.
 */
test("quem não alcança a conta não vê nem a tela — a superfície some antes do botão", async ({ page }) => {
  await loginAs(page, E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD, `/anuncios/${REPROVADA}?aba=historico`);

  await expect(page.getByRole("heading", { name: "Republicações" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pedir republicação" })).toHaveCount(0);

  // Âncora positiva: a sessão do GESTOR está viva e a aplicação respondeu — o
  // que sumiu foi o anúncio, não o login (a lição de D-276 §5).
  await expect(page.getByText(/não encontrad|404/i).first()).toBeVisible();
});
