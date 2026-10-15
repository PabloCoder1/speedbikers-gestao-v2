import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * GUARDA DE TELA ESTREITA E DE ACESSIBILIDADE BÁSICA (D-510).
 *
 * As duas auditorias do Agente 3 viraram regra: a de acessibilidade (D-508) e a
 * de tela estreita (D-510), que achou três telas rolando para o lado no celular
 * — a Home (106 px), `/central/metas` e `/faturamento` (8 px cada). Nenhuma
 * nova pode voltar a rolar, perder o h1, deixar um controle sem nome ou tirar o
 * "Pular para o conteúdo" do primeiro Tab.
 *
 * **A rolagem se mede no `.sb-content`, nunca no `<html>`.** O shell tem
 * `overflow: hidden` e `100dvh`; quem rola é o `<main>`. Medir o documento dá
 * sempre "não rola" — o erro da varredura de D-383 (ver
 * `e2e/configuracoes.spec.ts`) e, de novo, das fotos das D-504 a D-509.
 *
 * As rotas cobrem as formas compartilhadas (faixa, `sb-pair-grid`, grade de
 * cartões, tabela, cabeçalho de entidade) e os escopos multicanal. Tela nova
 * com forma nova entra aqui.
 */
const ROTAS = [
  "/",
  "/acoes",
  "/anuncios",
  "/atendimento",
  "/central",
  "/central/metas",
  "/compras",
  "/configuracoes",
  "/curva-abc",
  "/estoque",
  "/faturamento",
  "/faturamento?marketplace=todos",
  "/full",
  "/integracoes",
  "/notificacoes",
  "/precos",
  "/produtos",
  "/reposicao",
  "/sincronizacao",
  "/vendas",
  "/vendas?marketplace=todos",
  "/vinculacoes",
];

async function entrar(page: Page): Promise<void> {
  await login(page, "/estoque");
  // `/login?next=%2Festoque` também casa com /estoque/: espera o CAMINHO.
  await page.waitForURL((url) => url.pathname === "/estoque");
}

test.describe("tela estreita (390 px, celular)", () => {
  // Celular de verdade: a barra de rolagem é sobreposta e não come largura.
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("o conteúdo não rola para o lado em nenhuma tela da lista", async ({ page }) => {
    test.setTimeout(180_000);
    await entrar(page);

    const transbordos: string[] = [];

    for (const rota of ROTAS) {
      await page.goto(rota, { waitUntil: "networkidle" });

      const { rolagem, visivel } = await page.locator(".sb-content").evaluate((conteudo) => ({
        rolagem: conteudo.scrollWidth,
        visivel: conteudo.clientWidth,
      }));

      if (rolagem > visivel) transbordos.push(`${rota}: ${String(rolagem - visivel)} px para o lado`);
    }

    expect(transbordos).toEqual([]);
  });
});

test("acessibilidade básica: um h1, títulos sem pulo, nada sem nome, imagem com alt, id único e o primeiro Tab pula para o conteúdo", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await entrar(page);

  const problemas: string[] = [];

  for (const rota of ROTAS) {
    await page.goto(rota, { waitUntil: "networkidle" });

    const achados = await page.evaluate(() => {
      const saida: string[] = [];
      const visivel = (el: Element): boolean => {
        const caixa = el.getBoundingClientRect();
        const estilo = getComputedStyle(el);

        return caixa.width > 0 && caixa.height > 0 && estilo.visibility !== "hidden" && estilo.display !== "none";
      };
      const oculto = (el: Element): boolean => el.closest("[aria-hidden='true'],[hidden],[inert]") !== null;
      const descrever = (el: Element): string => el.outerHTML.slice(0, 80);

      const titulos = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((h) => visivel(h) && !oculto(h));
      const h1 = titulos.filter((h) => h.tagName === "H1").length;
      if (h1 !== 1) saida.push(`${String(h1)} h1 visíveis`);
      let anterior = 0;
      for (const titulo of titulos) {
        const nivel = Number(titulo.tagName[1]);
        if (anterior > 0 && nivel > anterior + 1) saida.push(`título pula de h${String(anterior)} para h${String(nivel)}: ${descrever(titulo)}`);
        anterior = nivel;
      }

      const texto = (id: string): string => (document.getElementById(id)?.textContent ?? "").trim();
      const nome = (el: Element): string => {
        const rotulo = el.getAttribute("aria-label");
        if (rotulo !== null && rotulo.trim() !== "") return rotulo;
        const rotuladoPor = el.getAttribute("aria-labelledby");
        if (rotuladoPor !== null) return rotuladoPor.split(/\s+/).map(texto).join(" ").trim();
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
          if (el.id !== "") {
            const associado = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (associado !== null && associado.textContent.trim() !== "") return "rótulo";
          }
          if ((el.closest("label")?.textContent ?? "").trim() !== "") return "rótulo";
          if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) return el.value;

          return (el.getAttribute("title") ?? "").trim();
        }

        return (
          el.textContent.trim() ||
          (el.querySelector("img[alt]")?.getAttribute("alt") ?? "").trim() ||
          (el.querySelector("svg title")?.textContent ?? "").trim() ||
          (el.getAttribute("title") ?? "").trim()
        );
      };
      const controles = document.querySelectorAll(
        "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch]",
      );
      for (const controle of controles) {
        if (visivel(controle) && !oculto(controle) && nome(controle) === "") saida.push(`controle sem nome: ${descrever(controle)}`);
      }

      for (const imagem of document.querySelectorAll("img")) {
        if (!imagem.hasAttribute("alt") && !oculto(imagem)) saida.push(`imagem sem alt: ${descrever(imagem)}`);
      }

      const ids = new Map<string, number>();
      for (const el of document.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
      for (const [id, vezes] of ids) if (vezes > 1) saida.push(`id repetido: #${id} (${String(vezes)}x)`);

      return saida;
    });

    await page.keyboard.press("Tab");
    const primeiroFoco = await page.evaluate(() => (document.activeElement?.textContent ?? "").trim());
    if (primeiroFoco !== "Pular para o conteúdo") achados.push(`o primeiro Tab foi para "${primeiroFoco.slice(0, 40)}"`);

    problemas.push(...achados.map((achado) => `${rota}: ${achado}`));
  }

  expect(problemas).toEqual([]);
});
