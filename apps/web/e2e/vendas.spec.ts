import { expect, test } from "@playwright/test";

import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./constants.js";

/**
 * `/vendas` — a migração da composição para o Figma (D6).
 *
 * **O que este teste protege não é a aparência, é o que a aparência quase
 * levou junto.** Os filtros de conta, marca e período eram três linhas de
 * pílulas e viraram três menus `<details>` na barra do cabeçalho. Toda a
 * lógica de URL continua a mesma — `buildHref` não mudou —, mas a forma de
 * chegar até ela mudou inteira, e um `href` montado sem um dos parâmetros
 * silenciosamente descarta um recorte: a tela continua respondendo, com o
 * recorte errado.
 *
 * Por isso a asserção é de COMPOSIÇÃO de filtros: aplicar conta, depois marca,
 * depois período, depois métrica, e exigir que os quatro sobrevivam juntos na
 * URL. É o caso que o formulário de período personalizado já tinha errado uma
 * vez (o `metric` se perdia, e o gráfico voltava para faturamento sozinho) —
 * e agora o `marca`/`semMarca` entrou na mesma conta.
 */
test("/vendas: conta, marca, período e métrica compõem sem se descartar", async ({ page }) => {
  await page.goto("/login?next=%2Fvendas");
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/vendas$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  const menus = page.locator("details.sb-menu");

  // Conta.
  await menus.nth(0).locator("summary").click();
  await menus.nth(0).getByRole("link", { name: "Loja E2E" }).click();
  await expect(page).toHaveURL(/account=e2e-loja/);

  // Marca — "Sem marca" NÃO é ausência de filtro (D-237): é a venda que
  // nenhuma marca alcança.
  await menus.nth(1).locator("summary").click();
  await menus.nth(1).getByRole("link", { name: "Sem marca" }).click();
  await expect(page).toHaveURL(/semMarca=1/);
  await expect(page).toHaveURL(/account=e2e-loja/);

  // Período.
  await menus.nth(2).locator("summary").click();
  await menus.nth(2).getByRole("link", { name: "Últimos 7 dias" }).click();
  await expect(page).toHaveURL(/days=7/);

  // Métrica, pelo controle segmentado que substituiu as pílulas do gráfico.
  await page.locator(".sb-segmented").getByRole("link", { name: "Unidades" }).click();

  // Os quatro, juntos. É esta linha que pega o recorte descartado em silêncio.
  await expect(page).toHaveURL(/account=e2e-loja/);
  await expect(page).toHaveURL(/semMarca=1/);
  await expect(page).toHaveURL(/days=7/);
  await expect(page).toHaveURL(/metric=unidades/);

  // E o rótulo de cada menu diz o estado — sem isso o filtro fica aplicado e
  // invisível, que é pior do que não ter filtro.
  await expect(menus.nth(0).locator("summary")).toContainText("Loja E2E");
  await expect(menus.nth(1).locator("summary")).toContainText("Sem marca");
  await expect(menus.nth(2).locator("summary")).toContainText("Últimos 7 dias");
});


/**
 * O SELO DE FRESCOR (D-304) — o defeito que o usuário trouxe com uma captura:
 * "Cálculo desatualizado · até 10/09/2026, 01:02" às duas da tarde, com o
 * recálculo rodando de hora em hora o tempo todo.
 *
 * A causa era o selo medir a coisa errada. `computed_at` é o carimbo de quando
 * a LINHA NASCEU — desde D-199 uma linha só é reescrita quando algum número
 * dela muda, e o carimbo não acompanhava a reescrita. O selo passou a ler
 * `last_refreshed_at`, que anda a cada PASSADA do recálculo, tenha ela escrito
 * ou não.
 *
 * Este caso guarda a diferença: com o estado de recálculo fresco (o seed o
 * carimba em agora), a tela precisa dizer que está em dia — mesmo que a última
 * MUDANÇA de número seja de dias atrás, que é o caso do fixture.
 */
test("/vendas: o selo mede a CONFERÊNCIA do cálculo, não a última mudança", async ({ page }) => {
  await page.goto("/login?next=%2Fvendas");
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  /*
    As vendas do fixture são de 1 e 3 dias atrás (`E2E_SKU_SALES`), então a
    última MUDANÇA é velha. Se o selo ainda medisse `computed_at`, ele diria
    "Cálculo desatualizado" aqui — que é exatamente o defeito.
  */
  await expect(page.getByText(/Cálculo em dia · conferido/)).toBeVisible();
  await expect(page.getByText("Cálculo desatualizado")).toHaveCount(0);
});

/**
 * A ALTURA DO FRAME, E O TEXTO QUE NÃO ENCOLHE (A14, D-322).
 *
 * O gráfico tinha `viewBox` 900×260 com `height: auto`, e tudo dentro dele
 * escalava com a largura — medido antes da fatia: **70px de altura e eixo em
 * 2,4px** numa tela de 375px, e eixo em 7px na Home a 1440px. Nenhum caso olhava
 * para isso, e por isso durou.
 *
 * O caso afirma as duas metades em duas larguras bem diferentes: a área de
 * plotagem tem a altura FIXA do frame (224px aqui, 165px na Home), e o rótulo
 * do eixo tem 9px nas duas. Se alguém devolver `height: auto`, ou mover o texto
 * de volta para dentro do SVG, uma das larguras reprova.
 */
test("/vendas e Home: o gráfico tem a altura do frame e o eixo legível em qualquer largura", async ({ page }) => {
  await page.goto("/login?next=%2Fvendas");
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  const casos = [
    { rota: "/vendas", altura: 224 },
    { rota: "/", altura: 165 },
  ];

  for (const largura of [1440, 375]) {
    await page.setViewportSize({ width: largura, height: 900 });

    for (const caso of casos) {
      await page.goto(caso.rota);

      const plotagem = page.locator(".sb-chart-plot").first();

      await expect(plotagem).toBeVisible();
      await expect(page.getByRole("img", { name: /no período selecionado/ }).first()).toBeVisible();

      const alturaMedida = await plotagem.evaluate((elemento) => elemento.getBoundingClientRect().height);
      const fonteDoEixo = await page
        .locator(".sb-chart-y span")
        .first()
        .evaluate((elemento) => getComputedStyle(elemento).fontSize);

      expect(alturaMedida, `${caso.rota} a ${String(largura)}px`).toBe(caso.altura);
      expect(fonteDoEixo, `${caso.rota} a ${String(largura)}px`).toBe("9px");

      /*
        OS DOIS ACHADOS DA CAPTURA. Com texto de tamanho fixo, dois defeitos que
        a escala escondia apareceram: o rótulo do TOPO do eixo Y saía cortado
        pela borda da figura, e a 375px as seis datas do eixo X se encostavam.
        Nenhum dos dois aparece em `innerText` — por isso a medida é de caixa.
      */
      const geometria = await page
        .locator("figure.sb-chart")
        .first()
        .evaluate((figura) => {
          const caixa = figura.getBoundingClientRect();
          const topo = figura.querySelector(".sb-chart-y span")?.getBoundingClientRect();
          const rotulos = Array.from(figura.querySelectorAll(".sb-chart-x span"))
            .filter((span) => getComputedStyle(span).display !== "none")
            .map((span) => span.getBoundingClientRect());
          const encostados = rotulos.some((atual, indice) => {
            const anterior = rotulos[indice - 1];

            return anterior !== undefined && atual.left < anterior.right + 4;
          });

          return {
            topoDentro: topo !== undefined && topo.top >= caixa.top,
            encostados,
            visiveis: rotulos.length,
          };
        });

      expect(geometria.topoDentro, `${caso.rota} a ${String(largura)}px: rótulo do topo dentro da figura`).toBe(true);
      expect(geometria.encostados, `${caso.rota} a ${String(largura)}px: datas do eixo X sem se encostar`).toBe(false);
      expect(geometria.visiveis, `${caso.rota} a ${String(largura)}px: o eixo X ainda tem datas`).toBeGreaterThan(1);
    }
  }
});
