import { describe, expect, it } from "vitest";

import { MAX_BYTES, tamanhoLegivel, triar } from "./triagem";

/**
 * A triagem de cortesia (D-375). Ela NÃO substitui a decisão da `api`, que olha
 * os bytes — o que estes casos protegem é que ela erre para o lado de deixar
 * passar, nunca para o lado de recusar um documento legítimo.
 */

const arquivo = (name: string, size = 1024, type = ""): { name: string; size: number; type: string } => ({
  name,
  size,
  type,
});

describe("formato", () => {
  it("reconhece XML e PDF pela extensão", () => {
    expect(triar(arquivo("NFE-4226.xml")).formato).toBe("XML");
    expect(triar(arquivo("Imprimir - UpSeller.pdf")).formato).toBe("PDF");
  });

  it("reconhece pelo tipo do navegador quando o nome não tem extensão", () => {
    expect(triar(arquivo("documento", 1024, "application/pdf")).formato).toBe("PDF");
    expect(triar(arquivo("documento", 1024, "text/xml")).formato).toBe("XML");
  });

  /**
   * Extensão maiúscula é o caso real de quem baixa do portal da SEFAZ.
   */
  it("extensão maiúscula é o mesmo formato", () => {
    expect(triar(arquivo("NOTA.XML")).formato).toBe("XML");
    expect(triar(arquivo("DANFE.PDF")).formato).toBe("PDF");
  });
});

describe("o que não sobe", () => {
  it("arquivo vazio é recusado aqui mesmo", () => {
    expect(triar(arquivo("nota.xml", 0)).recusa).toBe("arquivo vazio");
  });

  it("acima do teto é recusado antes de gastar o envio", () => {
    expect(triar(arquivo("danfe.pdf", MAX_BYTES + 1)).recusa).toContain("acima de");
  });

  it("planilha aponta para a tela certa em vez de só recusar", () => {
    expect(triar(arquivo("estoque.xlsx")).recusa).toBe("planilha vai em Importações, não aqui");
    expect(triar(arquivo("vendas.csv")).recusa).toContain("Importações");
  });

  it("imagem de tela não tem texto para ler", () => {
    expect(triar(arquivo("print.png")).recusa).toBe("não é XML nem PDF");
  });
});

/**
 * O caso que decide o desenho: extensão DESCONHECIDA sobe. A `api` é que sabe
 * ler os bytes, e um XML salvo como `.txt` continua sendo um XML — recusar aqui
 * seria uma recusa inventada pelo navegador.
 */
describe("na dúvida, sobe", () => {
  it("extensão desconhecida não é recusada, só fica sem formato", () => {
    const triado = triar(arquivo("nota-sem-extensao-conhecida.txt"));

    expect(triado.recusa).toBeNull();
    expect(triado.formato).toBeNull();
  });

  it("arquivo sem extensão nenhuma também sobe", () => {
    expect(triar(arquivo("documento")).recusa).toBeNull();
  });
});

describe("tamanho legível", () => {
  it("usa a unidade que a pessoa lê, com vírgula decimal", () => {
    expect(tamanhoLegivel(512)).toBe("512 B");
    expect(tamanhoLegivel(2048)).toBe("2,0 kB");
    expect(tamanhoLegivel(1024 * 1024 * 1.5)).toBe("1,5 MB");
    expect(tamanhoLegivel(MAX_BYTES)).toBe("20 MB");
  });
});
