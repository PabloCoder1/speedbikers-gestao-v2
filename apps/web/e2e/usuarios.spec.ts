import { expect, test } from "@playwright/test";

import { E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD } from "./constants.js";
import { login, loginAs } from "./helpers.js";

/**
 * Administração de Usuários (`/usuarios`) pelo frame `AdminScreen` na variação
 * de acessos (D31, D-271).
 *
 * **Este spec nasce de um defeito VIVO que ele existe para não deixar voltar.**
 *
 * A tela lia `organization_members` com `.maybeSingle()` **sem filtrar por
 * usuário**. Sob RLS aquela leitura devolve TODOS os membros da organização;
 * com dois, o PostgREST responde `PGRST116`, `data` vira nulo, e a tela dizia
 * *"Sua conta não está associada a nenhuma organização"* — para o próprio
 * ADMIN.
 *
 * É a classe que D-234 corrigiu em ~25 telas e que passou por esta. E a ironia
 * explica por que ninguém viu: `/usuarios` é justamente onde se cadastra o
 * segundo usuário, ou seja, **a tela que o ato quebra é a tela que o ato usa**.
 *
 * O seed tem DOIS membros exatamente para que este arquivo fique vermelho se
 * alguém reintroduzir a leitura sem filtro.
 */

test("/usuarios: com DOIS membros a tela abre — a regressão de D-234", async ({ page }) => {
  await login(page, "/usuarios");

  await expect(page.getByRole("heading", { name: "Usuários", level: 1 })).toBeVisible();

  /*
    A FRASE QUE NÃO PODE VOLTAR. Ela é correta para quem realmente não tem
    organização; era o sintoma do defeito para quem tem.
  */
  await expect(page.getByText(/não está associada a nenhuma organização/)).toHaveCount(0);

  /*
    Os DOIS membros do seed aparecem. O escopo é o painel de gerenciamento
    porque o histórico embaixo também nomeia as duas pessoas — "E2E" solto
    casaria nas duas tabelas.
  */
  const gerenciar = page.getByRole("region", { name: "Gerenciar acessos" });

  /*
    O NOME DA CÉLULA MUDOU EM D-296, e continua EXATO de propósito: o e-mail
    passou a viver embaixo do nome, como o frame desenha ("Usuário / E-mail"),
    então o nome acessível da célula é o par. Afrouxar para `contains` seria
    perder a guarda — ela existe para provar que a linha do membro CERTO
    renderiza, e não uma linha qualquer.
  */
  await expect(gerenciar.getByRole("cell", { name: "E2E e2e@speedbikers.test", exact: true })).toBeVisible();
  await expect(
    gerenciar.getByRole("cell", { name: "E2E Gestor gestor@speedbikers.test", exact: true }),
  ).toBeVisible();
});

test("/usuarios: o histórico de acesso mostra as duas entradas que o banco gravou", async ({ page }) => {
  await login(page, "/usuarios");

  /*
    O histórico não é escrito pela tela: `organization_access_events` é
    append-only e preenchido por trigger. Ou seja, o seed cria os dois membros
    e o BANCO registra as duas entradas — se elas não estiverem aqui, o
    registro de auditoria parou de funcionar, e isso é silencioso.
  */
  const historico = page.getByRole("region", { name: "Histórico de acesso" });

  await expect(historico.getByRole("cell", { name: "entrou como ADMIN" })).toBeVisible();
  await expect(historico.getByRole("cell", { name: "entrou como GESTOR" })).toBeVisible();

  // A janela é declarada, não implícita — a leitura tem `limit(50)` (D-131).
  await expect(historico.getByText(/50 mudanças mais recentes/)).toBeVisible();
});

test("/usuarios: a faixa tem os CINCO papéis do check, não os três do frame", async ({ page }) => {
  await login(page, "/usuarios");

  const faixa = page.locator(".sb-kpi-strip");

  /*
    O frame dá cartão a Administradores, Gestores e Operadores. O `check` de
    `organization_members` conhece CINCO: ADMIN, GESTOR, ANALISTA, OPERADOR e
    VISUALIZADOR. Com três, os cartões deixariam de fechar com o total no dia
    em que alguém for cadastrado como analista — a mesma aritmética que
    denunciou o frame da Central Full (D-265).
  */
  await expect(faixa.locator(".sb-kpi", { hasText: "Membros" }).locator(".sb-kpi-value")).toHaveText("2");
  await expect(faixa.locator(".sb-kpi", { hasText: "Administrador" }).locator(".sb-kpi-value")).toHaveText("1");
  await expect(faixa.locator(".sb-kpi", { hasText: "Gestor" }).locator(".sb-kpi-value")).toHaveText("1");

  // Os três papéis sem ninguém aparecem em ZERO — esconder linha vazia é que
  // faria os cartões mentirem sobre o que existe (D-250).
  for (const papel of ["Analista", "Operador", "Visualizador"]) {
    await expect(faixa.locator(".sb-kpi", { hasText: papel }).locator(".sb-kpi-value")).toHaveText("0");
  }
});

test("/usuarios: as três colunas que D-271 recusou ENTRARAM, pela janela de D-296", async ({ page }) => {
  await login(page, "/usuarios");

  /*
    D-271 recusou "Status", "Último acesso" e o e-mail por FALTA DE FONTE — e a
    falta não era do esquema, era da JANELA: `auth.users` não é alcançável pela
    Data API, de propósito. `get_organization_members` é a janela, `security
    definer` com autorização ADMIN daquela organização refeita dentro.

    E "Convites pendentes" deixou de ser cartão sempre em zero: com o convite
    de D-296, ele conta gente de verdade — quem tem vínculo e nunca entrou.
  */
  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Último acesso/i })).toBeVisible();
  await expect(page.getByText(/Convites pendentes/i)).toBeVisible();

  /*
    "Desde" SAIU DA TABELA em D-297 e virou "Membro desde" na gaveta. Ele entrou
    em D-271 como substituto de "Último acesso", que não tinha fonte; com a
    fonte aberta, dois carimbos lado a lado eram uma coluna a mais que o frame
    não tem para responder o que a gaveta já responde.
  */
  await expect(page.getByRole("columnheader", { name: "Desde" })).toHaveCount(0);

  // O e-mail sob o nome, como o frame desenha.
  await expect(page.getByText("e2e@speedbikers.test").first()).toBeVisible();
});

/**
 * A COMPOSIÇÃO DO FRAME (D-297) — a fatia que o usuário pediu ao comparar as
 * duas telas: "o seu está muito inferior, acompanhe 100% o design figma".
 *
 * O que ele viu tem nome: cada linha carregava um `<select>` de papel e uma
 * caixa por conta, e uma tabela com cinco controles por pessoa se lê como
 * formulário empilhado. O frame põe SELO em Papel, TEXTO em contas, e abre a
 * pessoa numa gaveta.
 *
 * Este caso guarda as duas metades juntas — a tabela sem controle E o controle
 * vivo na gaveta —, porque separá-las deixaria passar a "correção" que some com
 * a edição em vez de mudá-la de lugar.
 */
test("/usuarios: a tabela não tem controle, e a edição mora na gaveta (D-297)", async ({ page }) => {
  await login(page, "/usuarios");

  const gerenciar = page.getByRole("region", { name: "Gerenciar acessos" });

  await expect(gerenciar.getByRole("combobox")).toHaveCount(0);
  await expect(gerenciar.getByRole("checkbox")).toHaveCount(0);

  // Papel e Status como selo, com o texto do frame.
  await expect(gerenciar.getByRole("cell", { name: "Administrador", exact: true })).toBeVisible();
  await expect(gerenciar.getByRole("cell", { name: "Ativo", exact: true }).first()).toBeVisible();

  // O NOME é o gatilho, como a linha clicável do frame.
  await gerenciar.getByRole("button", { name: "E2E", exact: true }).click();

  const gaveta = page.getByRole("dialog", { name: /Detalhe do usuário/ });

  await expect(gaveta).toBeVisible();

  // O menu de papel que saiu da tabela está aqui — a edição mudou de lugar,
  // não desapareceu.
  await expect(gaveta.getByLabel("Papel do membro")).toBeVisible();
  await expect(gaveta.getByText("Membro desde")).toBeVisible();

  /*
    A SAÍDA DE D-303, para quem tem vínculo e não consegue entrar. Ela pede
    confirmação antes de gerar porque o link vale como senha da conta — um
    clique sem aviso seria fácil demais para o que ele faz.
  */
  await gaveta.getByRole("button", { name: "Gerar novo link de acesso" }).click();
  await expect(gaveta.getByText("O link vale como senha")).toBeVisible();
  await expect(gaveta.getByRole("button", { name: "Gerar link" })).toBeVisible();

  /*
    "Proteção Ativa" do frame: o seed tem UM ADMIN, e quem recusa rebaixá-lo é
    o trigger `guard_last_admin`, não esta tela.
  */
  await expect(gaveta.getByText("Proteção ativa")).toBeVisible();
});

/**
 * A busca e o menu "Status ⌄" que o frame desenha no cabeçalho do painel
 * (D-297). Os dois vivem na URL, não em estado React — o recorte é
 * compartilhável e o "voltar" do navegador funciona.
 */
test("/usuarios: a busca recorta a tabela e a tela DIZ o recorte", async ({ page }) => {
  await login(page, "/usuarios");

  await page.getByLabel("Buscar por nome ou e-mail").fill("gestor");
  await page.getByLabel("Buscar por nome ou e-mail").press("Enter");

  const gerenciar = page.getByRole("region", { name: "Gerenciar acessos" });

  await expect(
    gerenciar.getByRole("cell", { name: "E2E Gestor gestor@speedbikers.test", exact: true }),
  ).toBeVisible();

  await expect(gerenciar.getByRole("cell", { name: "E2E e2e@speedbikers.test", exact: true })).toHaveCount(0);

  /*
    A FRASE É A GUARDA: sem ela a tela mostraria uma linha sem dizer que a
    outra foi escondida — o mesmo defeito que `summarizePagedWindow` existe
    para impedir na paginação (D-131).
  */
  await expect(page.getByText(/1 de 2 pessoas, por busca/)).toBeVisible();
});

/**
 * O CONVITE (D-296) — o botão que o usuário pediu e que D-271 recusou por ser
 * feature.
 *
 * **A `api` não sobe na suíte de e2e**, então nada aqui cria usuário de
 * verdade: a criação exige service role e tem teste próprio em
 * `apps/api/src/invites.test.ts`, fronteira de organização incluída. O que
 * este arquivo guarda é o que a web possui — quem vê o botão, o que o
 * formulário pede e o que ele recusa antes de chamar.
 */
test("/usuarios: o convite pede e-mail, papel e alcance — e o alcance some para ADMIN", async ({ page }) => {
  await login(page, "/usuarios");

  await page.getByRole("button", { name: "Convidar usuário" }).click();

  const caixa = page.getByRole("dialog", { name: "Convidar usuário" });

  await expect(caixa).toBeVisible();

  // Sem e-mail válido não há chamada: a recusa acontece antes de gastar a ida.
  const convidar = caixa.getByRole("button", { name: "Convidar", exact: true });

  await expect(convidar).toBeDisabled();

  await caixa.getByLabel("E-mail").fill("nova.pessoa@empresa.com");
  await expect(convidar).toBeEnabled();

  /*
    O ALCANCE É O QUE O PAPEL NÃO DECIDE (D-117): papel diz o que a pessoa pode
    fazer; conta diz sobre o que ela faz. ADMIN alcança todas por PAPEL, então
    a lista de contas some para ele em vez de ficar ali sem efeito.
  */
  await expect(caixa.getByText("Contas que essa pessoa vai alcançar")).toBeVisible();

  await caixa.getByLabel("Papel").selectOption("ADMIN");

  await expect(caixa.getByText("Contas que essa pessoa vai alcançar")).toHaveCount(0);
});

test("/usuarios: o GESTOR não vê o botão de convidar", async ({ page }) => {
  await loginAs(page, E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD, "/usuarios");

  // Âncora positiva: a tela é a certa e abriu para ele (a lição de D-276 §5).
  await expect(page.getByRole("heading", { name: "Usuários", level: 1 })).toBeVisible();

  /*
    Esconder é CORTESIA: a rota exige ADMIN e a RPC devolve zero linhas para
    quem não é. Oferecer o que o servidor vai negar é pior que não oferecer.
  */
  await expect(page.getByRole("button", { name: "Convidar usuário" })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Status" })).toHaveCount(0);

  /*
    E nem o link de acesso (D-303): emitir credencial de outra pessoa é poder de
    ADMIN, e a rota exige ADMIN. Esconder aqui é cortesia; quem recusa é o
    servidor.
  */
  await page.getByRole("button", { name: "E2E Gestor", exact: true }).click();

  await expect(page.getByRole("dialog", { name: /Detalhe do usuário/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gerar novo link de acesso" })).toHaveCount(0);
});

test("/usuarios: o GESTOR vê a tela em leitura, e o papel lido é o DELE", async ({ page }) => {
  await loginAs(page, E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD, "/usuarios");

  /*
    Este é o caso que prova que a correção lê o membro CERTO, e não um membro
    qualquer. `currentMembership` filtra por `auth.uid()`; a leitura antiga
    devolvia a lista inteira e não sabia dizer de quem era o papel.

    Para o GESTOR a tela é somente leitura, e o texto abaixo do título é a
    forma visível disso.
  */
  await expect(page.getByText(/somente leitura para você/)).toBeVisible();

  // Sem seletor de papel: os controles de escrita só aparecem para ADMIN.
  await expect(page.getByRole("combobox")).toHaveCount(0);

  /*
    E o histórico some — não por a tela escondê-lo, mas porque a policy de
    `organization_access_events` só devolve linhas para ADMIN. Esconder é
    conveniência; quem recusa é o banco (D-175).
  */
  await expect(page.getByRole("region", { name: "Histórico de acesso" })).toHaveCount(0);
});
