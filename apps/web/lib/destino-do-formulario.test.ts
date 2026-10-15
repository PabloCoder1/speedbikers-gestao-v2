import { describe, expect, it } from "vitest";

import { destinoDoFormulario } from "./destino-do-formulario";

describe("destinoDoFormulario", () => {
  it("leva os campos na ordem do formulário, como o GET nativo", () => {
    expect(
      destinoDoFormulario("/estoque", [
        ["marca", "Shimano"],
        ["negativo", "1"],
        ["busca", "corrente"],
      ]),
    ).toBe("/estoque?marca=Shimano&negativo=1&busca=corrente");
  });

  /**
   * O GET nativo manda o campo vazio (`?busca=`). Tirá-lo mudaria a URL que as
   * telas já recebem — e os filtros salvos que guardaram essa forma.
   */
  it("mantém o campo vazio", () => {
    expect(destinoDoFormulario("/estoque", [["busca", ""]])).toBe("/estoque?busca=");
  });

  it("substitui a busca do action em vez de mesclar", () => {
    expect(destinoDoFormulario("/estoque?pagina=3&marca=X", [["busca", "a"]])).toBe("/estoque?busca=a");
  });

  it("sem campo nenhum, vai para o caminho limpo", () => {
    expect(destinoDoFormulario("/estoque?pagina=3", [])).toBe("/estoque");
  });

  it("codifica espaço e acento como o navegador", () => {
    expect(destinoDoFormulario("/estoque", [["busca", "pneu aro 29 câmara"]])).toBe(
      "/estoque?busca=pneu+aro+29+c%C3%A2mara",
    );
  });

  it("repete o nome quando o formulário repete o campo", () => {
    expect(
      destinoDoFormulario("/vendas", [
        ["conta", "a"],
        ["conta", "b"],
      ]),
    ).toBe("/vendas?conta=a&conta=b");
  });

  it("nunca leva arquivo num GET", () => {
    const arquivo = new File(["x"], "nota.xml");

    expect(
      destinoDoFormulario("/notas-fiscais", [
        ["busca", "123"],
        ["xml", arquivo],
      ]),
    ).toBe("/notas-fiscais?busca=123");
  });

  it("aceita o action absoluto que o navegador devolve em form.action", () => {
    expect(destinoDoFormulario("https://speedbikers.example/estoque?x=1", [["busca", "a"]])).toBe("/estoque?busca=a");
  });
});
