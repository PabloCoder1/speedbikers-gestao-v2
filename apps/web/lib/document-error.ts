/**
 * O `documents.last_error` como a pessoa consegue ler.
 *
 * O worker grava a mensagem do leitor como veio. Quase sempre é uma frase
 * nossa ("itens sem código", "PDF sem texto"), mas quando o leitor de XML
 * recebe um arquivo que não é XML ele devolve o contexto CRU do ponto em que
 * parou — e no primeiro DANFE de produção (18/09/2026) isso eram bytes
 * binários do PDF na tela, uma parede de "�".
 *
 * Duas saídas: o `resumo`, que diz o que aconteceu em português, e o
 * `detalhe`, a mensagem técnica LIMPA (sem caractere de controle, cortada),
 * que fica recolhida para quem for investigar. Nenhuma das duas inventa
 * causa: o resumo só troca a frase quando reconhece a assinatura do erro.
 */

const MAX_DETALHE = 280;

export interface ErroLegivel {
  readonly resumo: string;
  readonly detalhe: string | null;
}

/** Tira o que não é texto: controle, U+FFFD (o "�" do byte que não é UTF-8) e espaço repetido. */
export function limparTexto(bruto: string): string {
  let limpo = "";

  for (const caractere of bruto) {
    const codigo = caractere.codePointAt(0) ?? 0;
    const controle = codigo < 0x20 || (codigo >= 0x7f && codigo < 0xa0);

    limpo += controle || codigo === 0xfffd ? " " : caractere;
  }

  return limpo.replace(/\s+/g, " ").trim();
}

export function erroLegivel(bruto: string, input: { leu: boolean }): ErroLegivel {
  const limpo = limparTexto(bruto);
  const detalhe = limpo === "" ? null : limpo.length > MAX_DETALHE ? `${limpo.slice(0, MAX_DETALHE)}…` : limpo;

  // A assinatura do leitor de XML abrindo algo que não é XML: o parser
  // (`fast-xml-parser`) para numa posição e cita o contexto binário.
  const naoEraXml = /readTagExp|Invalid (?:XML|tag)|Unexpected end|position \d+/i.test(bruto);
  // Metade ou mais dos caracteres eram lixo binário.
  const binario = bruto.length > 0 && (bruto.match(/\uFFFD/g)?.length ?? 0) * 4 > bruto.length;

  if (!input.leu && (naoEraXml || binario)) {
    return {
      resumo:
        "O arquivo não pôde ser lido como XML. Se ele é um PDF (DANFE, Pedido de Saída ou envio ao Full), envie de novo: a leitura recomeça no formato certo.",
      detalhe,
    };
  }

  // Frase curta e sem ruído já é o resumo; não há o que recolher.
  if (detalhe !== null && limpo.length <= 160) {
    return { resumo: limpo, detalhe: null };
  }

  return {
    resumo: input.leu
      ? "A aplicação no estoque falhou. Os vínculos continuam salvos."
      : "A leitura do arquivo falhou.",
    detalhe,
  };
}
