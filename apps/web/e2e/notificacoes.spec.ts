import { expect, test } from "@playwright/test";

import { E2E_ML_ACCOUNT, E2E_USER_EMAIL } from "./constants.js";
import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";

/**
 * Central de Notificações (`/notificacoes`) pelo frame `CentralScreen` na
 * variação de alertas (D29, D-269), com o recorte de D-290 e a triagem de
 * D-393.
 *
 * O que este arquivo protege:
 *
 *  1. **a contagem que D-183 corrigiu** — `unreadCount` já foi
 *     `rows.filter(...).length`, contando as não lidas ENTRE AS 100
 *     CARREGADAS. Com 54.306 notificações e 13.398 não lidas no Dev, o botão
 *     "Marcar todas como lidas" SUMIA depois de ler as 100 mais recentes,
 *     deixando milhares sem forma de limpar. A contagem vem de `count: exact`,
 *     e este teste existe para que ela não volte a sair da lista;
 *  2. **o painel de detalhe do frame NÃO entrou** — ele repete os campos da
 *     linha e acrescenta um "Impacto estimado R$ 8.400" que não tem fonte:
 *     `notifications` tem QUATRO colunas e zero de impacto (D-023);
 *  3. **cada dimensão de recorte separa de verdade**, incluindo as que D-393
 *     acrescentou — severidade, família de evento e conta. Um filtro que não
 *     filtra é pior do que filtro nenhum: ele promete;
 *  4. **a escrita em lote não é uma surpresa** — o lote pergunta antes, diz
 *     quantas e, com recorte ligado, diz que o resto continua por ler.
 */

/** O seed cria DUAS notificações, as duas `listing.price.changed` informativas. */
const ESPERADAS = 2;

test("/notificacoes: a janela e as não lidas vêm de contagem própria, não da lista", async ({ page }) => {
  await login(page, "/notificacoes");

  await expect(page.getByRole("heading", { name: "Central de Notificações", level: 1 })).toBeVisible();
  await expect(page.getByText("CENTRAL / ALERTAS")).toBeVisible();

  /*
    O subtítulo do painel carrega os DOIS fatos: a janela declarada e as não
    lidas. O seed tem duas notificações, ambas não lidas.
  */
  const painel = page.getByRole("region", { name: "Eventos recentes" });

  await expect(painel).toContainText(`${String(ESPERADAS)} não lida(s)`);

  /*
    O BOTÃO QUE SUMIA. Ele só aparece com não lidas no recorte, e enquanto a
    contagem saía da página carregada bastava ler as 100 mais recentes para
    ele desaparecer com milhares ainda por ler (D-183).
  */
  await expect(page.getByRole("button", { name: "Marcar todas como lidas" })).toBeVisible();

  // A ação em lote pede confirmação e informa o alcance antes de escrever.
  await page.getByRole("button", { name: "Marcar todas como lidas" }).click();

  const confirmacao = page.getByRole("group", { name: "Confirmar leitura de todas as notificações" });

  await expect(confirmacao).toContainText(`Marcar ${String(ESPERADAS)} notificações como lidas?`);
  await confirmacao.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("button", { name: "Marcar todas como lidas" })).toBeVisible();
});

/**
 * A FAIXA DE TRIAGEM (D-393) — três células, e cada uma é um LINK.
 *
 * D-269 registrou que o frame não dá resumo a esta variação, e continua
 * verdade: o que entrou não é resumo, é navegação. Sem ela, as críticas não
 * lidas ficam invisíveis atrás de 544 páginas — foi o que a medição mostrou.
 * Por isso o caso afirma o DESTINO de cada célula, não só o número.
 */
test("/notificacoes: a faixa conta a Central inteira e cada célula leva ao recorte que a contou", async ({ page }) => {
  await login(page, "/notificacoes");

  await expect(page.getByText("em toda a Central, não no recorte")).toBeVisible();

  const criticas = page.locator('a.sb-kpi-link[href="/notificacoes?estado=nao-lidas&severidade=critico"]');

  await expect(criticas).toBeVisible();

  await criticas.click();
  await expect(page).toHaveURL(/severidade=critico/);

  // O seed não tem nenhuma crítica: o vazio explica o recorte e oferece a saída.
  await expect(page.getByText("Nenhuma notificação neste recorte.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Limpar filtros/ })).toBeVisible();

  await page.getByRole("link", { name: /Limpar filtros/ }).click();
  await expect(page).toHaveURL(/\/notificacoes$/);
  await expect(page.locator("main li")).toHaveCount(ESPERADAS);
});

/**
 * AS TRÊS DIMENSÕES NOVAS, cada uma com um caso que PASSA e um que NÃO passa.
 *
 * Um filtro só está provado quando se vê o conjunto encolher: com todas as
 * linhas do seed sendo `listing.price.changed` informativas da mesma conta, o
 * lado que prova é o negativo — "Estoque" e "Crítico" têm de devolver vazio.
 */
test("/notificacoes: severidade, tipo e conta recortam — e o recorte aparece no painel", async ({ page }) => {
  await login(page, "/notificacoes?severidade=informativo");

  await expect(page.locator("main li")).toHaveCount(ESPERADAS);
  await expect(page.getByRole("region", { name: "Eventos recentes" })).toContainText("recorte: informativo");

  await page.goto("/notificacoes?tipo=stock");
  await expect(page.getByText("Nenhuma notificação neste recorte.")).toBeVisible();

  await page.goto("/notificacoes?tipo=listing");
  await expect(page.locator("main li")).toHaveCount(ESPERADAS);

  /*
    A CONTA vem do menu, porque o id é um UUID do banco — escrevê-lo no teste
    seria fixar um valor que o seed gera. O menu é um `<details>` nativo: o
    resumo abre, e cada opção é um link de verdade (o recorte mora na URL,
    compartilhável e com voltar do navegador).
  */
  const menuConta = page.locator("details.sb-menu", { hasText: "Conta" }).first();

  await menuConta.locator("summary").click();
  await menuConta.getByRole("link", { name: E2E_ML_ACCOUNT.label, exact: true }).click();

  await expect(page).toHaveURL(/conta=/);
  await expect(page.locator("main li")).toHaveCount(ESPERADAS);

  // Recorte que não existe na URL cai em "todas" — a URL é entrada de
  // terceiro, e `?severidade=xpto` não pode virar um filtro vazio para sempre.
  await page.goto("/notificacoes?severidade=xpto&tipo=nada");
  await expect(page.locator("main li")).toHaveCount(ESPERADAS);
  await expect(page.getByRole("link", { name: /Limpar/ })).toHaveCount(0);
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
    O "Filtrar" do cabeçalho do frame foi entregue em D-393 — e como TRÊS
    menus nomeados, não como um botão genérico. Cada um tinha um número por
    trás antes de existir (13.810 críticas; 60,4% num tipo só; quatro contas
    que particionam), que é justamente o que D-269 exigia para deixá-los
    entrar.
  */
  await expect(page.getByRole("button", { name: /^Filtrar$/ })).toHaveCount(0);
  await expect(page.locator("details.sb-menu", { hasText: "Severidade" })).toBeVisible();
  await expect(page.locator("details.sb-menu", { hasText: "Tipo" })).toBeVisible();
  await expect(page.locator("details.sb-menu", { hasText: "Conta" })).toBeVisible();

  // A linha continua carregando tudo o que a notificação tem: selo, tipo,
  // entidade com link, o diff e a hora.
  await expect(page.getByRole("button", { name: /^Marcar como lida:/ }).first()).toBeVisible();
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

  await expect(painel).toContainText(`${String(ESPERADAS)} não lida(s)`);

  // Uma é lida — e a pílula passa a dizer "Não lidas (1)", porque o rótulo
  // dela e a contagem do painel são o MESMO número.
  await page.getByRole("button", { name: /^Marcar como lida:/ }).first().click();

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

  // E a linha lida mostra o selo de estado, que é o que distingue as duas
  // sem depender da cor de fundo.
  await page.getByRole("link", { name: "Todas" }).click();

  await expect(page).toHaveURL(/\/notificacoes$/);
  await expect(page.locator("main li")).toHaveCount(ESPERADAS);
  await expect(page.locator("li[data-state='read']")).toHaveCount(1);
});

/**
 * A ESCRITA EM LOTE NOMEIA O RECORTE (D-393).
 *
 * Com um recorte ligado, "marcar todas" deixa de querer dizer uma coisa só:
 * quem está olhando os 32.783 avisos de quantidade disponível quer limpar
 * AQUELES e continuar com as críticas por ler. O botão troca de nome, a
 * confirmação diz em que recorte vai escrever, e um rodapé lembra que o resto
 * da Central continua por ler.
 *
 * **Este caso não escreve**: ele confirma o CONTRATO da tela e cancela. O
 * comportamento da escrita em si foi medido no banco (a função devolveu 10
 * críticas, 660 de anúncio e 102 de resto, em transação revertida) — repetir
 * isso aqui zeraria a caixa que os outros casos e a Home contam.
 */
test("/notificacoes: com recorte ligado, o lote diz QUAL recorte vai marcar", async ({ page }) => {
  await login(page, "/notificacoes?tipo=listing");

  const botao = page.getByRole("button", { name: "Marcar este recorte como lido" });
  const naoLidas = page.locator("main li[data-state='unread']");

  await expect(botao).toBeVisible();

  /*
    A contagem de partida NÃO é uma constante: a suíte roda em série e o caso
    do recorte de não lidas, acima, deixa uma delas lida de propósito. Afirmar
    "2" aqui amarraria este caso à ORDEM dos outros, que é a armadilha de
    D-288 — "o estado que este teste afirma é do seed, ou algum spec anterior
    já escreveu por cima dele?". O que este caso prova é que CANCELAR não
    escreve, e para isso basta o antes e o depois serem iguais.
  */
  const antes = await naoLidas.count();

  await botao.click();

  const confirmacao = page.getByRole("group", { name: "Confirmar leitura de todas as notificações" });

  await expect(confirmacao).toContainText("em anúncio?");
  await expect(confirmacao).toContainText("O resto da Central continua por ler.");

  await confirmacao.getByRole("button", { name: "Cancelar" }).click();

  // Nada foi escrito: a mesma quantidade continua por ler.
  await expect(botao).toBeVisible();
  await expect(naoLidas).toHaveCount(antes);
});

/**
 * O AGRUPAMENTO POR DIA, e o dia é o da CHEGADA (D-393).
 *
 * O seed é o caso limite de propósito: os dois eventos ACONTECERAM há um e
 * dois dias, e as notificações CHEGARAM agora (o fan-out roda no `insert`).
 * Se o cabeçalho agrupasse pelo `occurred_at` do evento, ele diria "Ontem" e
 * "Anteontem" numa lista ordenada pela chegada — e voltaria no tempo no meio
 * da página. Medido no Dev: 541 das 54.306 têm fato e chegada em dias civis
 * diferentes, com atraso máximo de 32 dias.
 */
test("/notificacoes: o cabeçalho de dia agrupa pela CHEGADA, e a linha mostra o fato", async ({ page }) => {
  await login(page, "/notificacoes");

  const grupo = page.getByRole("region", { name: "Hoje" });

  await expect(grupo).toBeVisible();
  await expect(grupo).toContainText(`${String(ESPERADAS)} eventos`);
  await expect(grupo.locator("li")).toHaveCount(ESPERADAS);

  // As duas linhas do seed são do MESMO dia de chegada: um grupo só.
  await expect(page.locator("main section.sb-notification-dia")).toHaveCount(1);
});

/**
 * A página além do fim — e aqui ela é detectada por ARITMÉTICA, não pelo 416
 * de D-289. Medido: o `PGRST103` só aparece quando a consulta pede
 * `count: exact` junto do `.range()`; sem `count`, o mesmo pedido volta 200 com
 * zero linhas — conferido de novo em D-393 contra o PostgREST local, com a
 * raiz nova da consulta. Esta tela tira as contagens de consultas próprias
 * (D-183), então quem sabe que a página 2 não existe é o total, não o servidor.
 */
test("/notificacoes: página além do fim é página vazia, não falha de leitura", async ({ page }) => {
  await login(page, "/notificacoes?pagina=2");

  await expect(page.getByText(/Esta página não existe neste recorte/)).toBeVisible();
  await expect(page.getByText(/Não foi possível carregar/)).toHaveCount(0);

  await page.getByRole("link", { name: "Voltar à primeira página" }).click();

  await expect(page).toHaveURL(/\/notificacoes$/);
  await expect(page.locator("main li").first()).toBeVisible();
});

/**
 * A LEITURA QUE PERDE A CONEXÃO (D-754). O POST derrubado deixava o botão em
 * "Marcando…", desabilitado e sem aviso. Os dois casos guardam o `read_at` de
 * cada notificação do usuário e devolvem no fim: a suíte conta as não lidas.
 */
async function leiturasDoUsuario() {
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(supabase.hostname)) throw new Error("Este teste exige Supabase local.");

  const db = clienteDeServico();
  const usuarios = await db.auth.admin.listUsers();

  if (usuarios.error !== null) throw new Error(usuarios.error.message);

  const usuario = usuarios.data.users.find((u) => u.email === E2E_USER_EMAIL);

  if (usuario === undefined) throw new Error("Usuário do seed não encontrado.");

  const leituras = await db.from("notification_recipients").select("notification_id, read_at").eq("user_id", usuario.id);

  if (leituras.error !== null) throw new Error(leituras.error.message);

  return {
    db,
    userId: usuario.id,
    antes: leituras.data,
    async atuais() {
      const agora = await db.from("notification_recipients").select("notification_id, read_at").eq("user_id", usuario.id);

      if (agora.error !== null) throw new Error(agora.error.message);

      return agora.data;
    },
    async restaurar() {
      for (const leitura of leituras.data) {
        const volta = await db
          .from("notification_recipients")
          .update({ read_at: leitura.read_at })
          .eq("user_id", usuario.id)
          .eq("notification_id", leitura.notification_id);

        expect.soft(volta.error).toBeNull();
      }
    },
  };
}

test("/notificacoes: falha de conexão ao marcar como lida libera o botão e permite nova tentativa", async ({ page }) => {
  const leituras = await leiturasDoUsuario();

  try {
    await leituras.db.from("notification_recipients").update({ read_at: null }).eq("user_id", leituras.userId);
    await login(page, "/notificacoes");

    const linha = page.locator("main li[data-state='unread']").first();
    const marcar = linha.getByRole("button", { name: /^Marcar como lida:/ });
    const caiu = await derrubarPrimeiraAcao(page);

    await marcar.click();
    await expect(linha.getByRole("alert")).toContainText("Não foi possível confirmar a leitura");
    await expect(marcar).toBeEnabled();
    expect(caiu()).toBe(true);
    expect((await leituras.atuais()).every((leitura) => leitura.read_at === null)).toBe(true);

    await marcar.click();
    await expect(page.locator("main li[data-state='read']")).toHaveCount(1);
    expect((await leituras.atuais()).filter((leitura) => leitura.read_at !== null)).toHaveLength(1);
  } finally {
    await leituras.restaurar();
  }
});

test("/notificacoes: falha de conexão ao marcar todas libera a confirmação sem escrever", async ({ page }) => {
  const leituras = await leiturasDoUsuario();

  try {
    await leituras.db.from("notification_recipients").update({ read_at: null }).eq("user_id", leituras.userId);
    await login(page, "/notificacoes");
    await page.getByRole("button", { name: "Marcar todas como lidas" }).click();

    const confirmacao = page.getByRole("group", { name: "Confirmar leitura de todas as notificações" });
    const confirmar = confirmacao.getByRole("button", { name: "Confirmar", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);

    await confirmar.click();
    await expect(confirmacao.getByRole("alert")).toContainText("Não foi possível confirmar a leitura");
    await expect(confirmar).toBeEnabled();
    await expect(confirmacao.getByRole("button", { name: "Cancelar", exact: true })).toBeEnabled();
    expect(caiu()).toBe(true);
    expect((await leituras.atuais()).every((leitura) => leitura.read_at === null)).toBe(true);

    // A nova tentativa zeraria a caixa que os outros casos contam: o caso cancela.
    await confirmacao.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Marcar todas como lidas" })).toBeVisible();
  } finally {
    await leituras.restaurar();
  }
});

test("/notificacoes: destinatário removido por outra sessão informa recusa sem marcar como lida", async ({ page }) => {
  const leituras = await leiturasDoUsuario();

  if (leituras.antes.length === 0) throw new Error("Nenhuma notificação no seed.");

  try {
    await leituras.db.from("notification_recipients").update({ read_at: null }).eq("user_id", leituras.userId);
    await login(page, "/notificacoes");

    const primeiraLinha = page.locator("main li[data-state='unread']").first();
    const botao = primeiraLinha.getByRole("button", { name: /^Marcar como lida:/ });

    await expect(botao).toBeVisible();

    const removidas = await leituras.db.from("notification_recipients").delete().eq("user_id", leituras.userId);

    expect(removidas.error).toBeNull();

    const resposta = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.request().headers()["next-action"] !== undefined,
    );

    await botao.click();
    expect((await resposta).status()).toBe(200);

    await expect(primeiraLinha.getByRole("alert")).toContainText("Atualize a página para conferir");
    await expect(primeiraLinha).toHaveAttribute("data-state", "unread");
    await expect(botao).toBeEnabled();
  } finally {
    const reinserida = await leituras.db.from("notification_recipients").upsert(
      leituras.antes.map((l) => ({
        notification_id: l.notification_id,
        user_id: leituras.userId,
        read_at: l.read_at,
      })),
      { onConflict: "notification_id,user_id" },
    );

    expect.soft(reinserida.error).toBeNull();
  }
});
