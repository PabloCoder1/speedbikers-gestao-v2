import type { ParsedNfe } from "../nfe/parse.js";

import { lerDanfe } from "./danfe.js";
import { lerEnvioFullMl } from "./envio-full-ml.js";
import { lerSaidaUpseller } from "./saida-upseller.js";
import type { DocumentoLido, LeituraDocumento, LinhaPdf, PedacoPdf } from "./tipos.js";

/**
 * Qual leitor atende este PDF (D-375).
 *
 * **O tipo sai do CONTEÚDO, não do nome do arquivo.** "Imprimir - UpSeller.pdf"
 * e "Inbound-77036991-preparation-instructions.pdf" são nomes que o usuário
 * pode renomear no caminho; o que não muda é o título impresso na primeira
 * página. Cada leitor abre dizendo se reconhece o layout, e a recusa carrega o
 * motivo de cada um — é o que a tela mostra quando nenhum reconhece.
 *
 * A ordem é do mais específico para o mais genérico: o pedido de saída e o
 * envio ao Full têm marcas próprias; o DANFE é o layout regulado.
 */
export function lerDocumentoPdf(
  linhas: readonly LinhaPdf[],
  pedacos: readonly PedacoPdf[],
  cnpjProprio: string,
): LeituraDocumento {
  if (linhas.length === 0) {
    return {
      ok: false,
      motivo:
        "não foi possível ler texto neste PDF — se ele é uma imagem digitalizada, envie o XML da nota ou o PDF original",
    };
  }

  const tentativas = [
    lerSaidaUpseller(linhas),
    lerEnvioFullMl(linhas, pedacos),
    lerDanfe(linhas, cnpjProprio),
  ] as const;

  for (const tentativa of tentativas) {
    if (tentativa.ok) return tentativa;
  }

  /*
    Nenhum leitor reconheceu. A mensagem junta os motivos porque eles são
    diferentes entre si — "não parece um DANFE" e "não achei a tabela de itens"
    levam a ações diferentes de quem enviou.
  */
  const motivos = tentativas
    .map((t) => (t.ok ? null : t.motivo))
    .filter((motivo): motivo is string => motivo !== null && !/não parece/i.test(motivo));

  if (motivos.length > 0) {
    return { ok: false, motivo: motivos[0] ?? "não foi possível ler este PDF" };
  }

  return {
    ok: false,
    motivo:
      "este PDF não é um DANFE, um Pedido de Saída do UpSeller nem as instruções de envio ao Full — envie um desses, ou o XML da nota",
  };
}

/**
 * A NF-e do XML na mesma forma dos PDFs.
 *
 * O XML já tinha o seu parser (`parseNfeXmlObject`, D-053) e ele continua sendo
 * o dono da leitura; esta função só traduz o resultado para a forma única, para
 * que o worker grave os quatro tipos pelo mesmo caminho.
 */
export function documentoDaNfe(nfe: ParsedNfe): DocumentoLido {
  return {
    tipo: "NFE_XML",
    direcao: nfe.operationType,
    numero: nfe.documentNumber,
    serie: nfe.series,
    chave: nfe.accessKey,
    emitidoEm: nfe.issueDate.toISOString(),
    emitenteCnpj: nfe.issuerCnpj,
    emitenteNome: nfe.issuerName,
    referencia: null,
    itens: nfe.items.map((item) => ({
      posicao: item.position,
      codigo: item.supplierCode,
      descricao: item.description,
      quantidade: item.quantity,
      unidade: item.unit,
      ean: item.ean,
      ncm: item.ncm,
      cfop: item.cfop,
      valorUnitario: item.unitValue,
      valorTotal: item.totalValue,
    })),
  };
}
