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

/**
 * D-612: O MOTIVO DA RECUSA EM CÓDIGO (`documents.last_error_code`, D-497 b).
 *
 * A venda do Mercado Livre e a da Shopee já mexem no estoque pelo pedido; a nota
 * da MESMA venda, importada aqui, mexeria de novo. O worker a recusa na leitura
 * e grava o código, e a tela diz o que ele significa — a nota de venda do
 * marketplace não é falha: está certa, só não deve baixar. Código que a tela
 * não conhece é `null`, e quem chama cai no `erroLegivel` do texto (D-476:
 * nunca o código cru).
 */
export type TomDaRecusa = "info" | "atencao" | "perigo";

/** O que a pessoa faz depois: nada, enviar o XML, ou enviar o arquivo de novo. */
export type AcaoDaRecusa = "nenhuma" | "enviar-xml" | "enviar-de-novo";

export interface RecusaLegivel {
  /** O estado curto da tabela ("Não aplicada", "Pede o XML", "Falhou"). */
  readonly estado: string;
  readonly titulo: string;
  readonly resumo: string;
  readonly tom: TomDaRecusa;
  readonly acao: AcaoDaRecusa;
  /** O próximo passo da fila, curto. */
  readonly proximoPasso: string;
  /** A etapa que toma o lugar da conferência e da baixa; só na recusa por regra. */
  readonly etapaFinal: string | null;
}

/** O nome do marketplace pelo intermediador lido do XML; sem ele, "do marketplace". */
function doCanal(marketplace: "ML" | "SHOPEE" | null): string {
  return marketplace === "ML" ? "do Mercado Livre" : marketplace === "SHOPEE" ? "da Shopee" : "do marketplace";
}

export function recusaLegivel(codigo: string | null, marketplace: "ML" | "SHOPEE" | null): RecusaLegivel | null {
  const canal = doCanal(marketplace);

  switch (codigo) {
    case "SAIDA_VENDA_MARKETPLACE":
      return {
        estado: "Não aplicada",
        titulo: `Nota de venda ${canal}: não baixa o estoque`,
        // Genérico de propósito: no ML a baixa vem do pedido lido; na Shopee, da
        // planilha do UpSeller até a D-495 baixar pelo pedido.
        resumo:
          "O estoque desta venda já é baixado sem a nota — pelo pedido do marketplace ou pela planilha do UpSeller. Aplicar a nota baixaria as mesmas unidades de novo, por isso ela fica registrada aqui e não é aplicada.",
        tom: "info",
        acao: "nenhuma",
        proximoPasso: "Venda do marketplace · sem baixa",
        etapaFinal: "Sem baixa: venda do marketplace",
      };
    case "DEVOLUCAO_VENDA_MARKETPLACE":
      return {
        estado: "Não aplicada",
        titulo: `Nota de devolução de uma venda ${canal}: não repõe o estoque`,
        resumo:
          "A devolução desta venda já volta ao estoque sem a nota — pela devolução do pedido ou pela planilha do UpSeller. Aplicar a nota reporia as mesmas unidades de novo, por isso ela fica registrada aqui e não é aplicada.",
        tom: "info",
        acao: "nenhuma",
        proximoPasso: "Devolução do marketplace · sem reposição",
        etapaFinal: "Sem reposição: devolução do marketplace",
      };
    case "VENDA_PEDE_XML":
      return {
        estado: "Pede o XML",
        titulo: "Nota de venda em PDF: envie o XML",
        resumo:
          "O DANFE não diz se a venda foi pelo Mercado Livre ou pela Shopee, que já baixam o estoque pelo pedido. Envie o XML desta nota: com ele, a leitura sabe se a venda baixa o estoque (venda direta) ou não (venda do marketplace).",
        tom: "atencao",
        acao: "enviar-xml",
        proximoPasso: "Enviar o XML",
        etapaFinal: null,
      };
    case "LEITURA_NAO_GRAVADA":
      return {
        estado: "Falhou",
        titulo: "A leitura não pôde ser gravada",
        resumo: "O arquivo foi lido, mas o resultado não pôde ser gravado. Envie de novo; se repetir, o detalhe técnico diz o motivo.",
        tom: "perigo",
        acao: "enviar-de-novo",
        proximoPasso: "Ver o que falhou",
        etapaFinal: null,
      };
    default:
      return null;
  }
}
