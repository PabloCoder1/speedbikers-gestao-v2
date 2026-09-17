import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { Voltar } from "../../../components/voltar";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Enviar documento — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Enviar documento — a tela complementar de `/notas-fiscais` (D-375).
 *
 * Era "Upload XML", de um arquivo só. Passou a receber os quatro layouts, em
 * XML e em PDF, e vários de uma vez — quem confere recebe o lote do dia, não um
 * documento por vez.
 *
 * **Os quatro cartões abaixo não são decoração: são a diferença entre um envio
 * que funciona e um arquivo recusado.** A leitura reconhece o documento pelo
 * CONTEÚDO, e dizer de antemão o que ela sabe ler evita a recusa em silêncio.
 */

const FORMATOS = [
  {
    titulo: "NF-e (XML)",
    etiqueta: "Entrada ou saída",
    texto:
      "O caminho preferido: é o único conferido pela SEFAZ, e traz chave, CFOP e valores. Entrada ou saída sai do CNPJ da Speed Bikers no documento.",
  },
  {
    titulo: "DANFE (PDF)",
    etiqueta: "Entrada ou saída",
    texto:
      "O papel da mesma nota, para quando só ele chega. A leitura extrai a tabela de produtos; se o PDF for uma imagem digitalizada, envie o XML.",
  },
  {
    titulo: "Pedido de Saída (UpSeller)",
    etiqueta: "Saída",
    texto:
      "O impresso que a operação já usa para separar mercadoria. Traz SKU e quantidade — não traz valor, e a conferência não inventa nenhum.",
  },
  {
    titulo: "Envio ao Full (Mercado Livre)",
    etiqueta: "Sem baixa por ora",
    texto:
      "As instruções de preparação. O documento é lido e conferido, mas a baixa não acontece: envio ao Full é transferência, não saída — ela espera o desenho do Full (D-352).",
  },
] as const;

export default function NovoDocumentoPage(): ReactNode {
  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Enviar documento"
        subtitle="XML da NF-e ou PDF do documento. A leitura é automática; o estoque só muda depois da sua conferência."
        aside={<Voltar href="/notas-fiscais" rotulo="Notas e Documentos" />}
        compacto
      />

      <Panel title="O que esta tela lê" subtitle="O tipo é reconhecido pelo conteúdo do arquivo, não pelo nome dele.">
        <ul className="sb-nf-formatos">
          {FORMATOS.map((formato) => (
            <li key={formato.titulo} className="sb-nf-formato">
              <small>{formato.etiqueta}</small>
              <b>{formato.titulo}</b>
              <span>{formato.texto}</span>
            </li>
          ))}
        </ul>

        <UploadForm />
      </Panel>
    </Shell>
  );
}
