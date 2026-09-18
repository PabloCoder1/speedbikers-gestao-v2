import type { ReactNode } from "react";

import { Icone, type NomeDoIcone } from "../../../components/icons";
import { PageTitle } from "../../../components/page-title";
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
 * **Os quatro formatos ao lado não são decoração: são a diferença entre um
 * envio que funciona e um arquivo recusado.** A leitura reconhece o documento
 * pelo CONTEÚDO, e dizer de antemão o que ela sabe ler evita a recusa em
 * silêncio. Ficam na coluna lateral, e não acima da área de envio: quem já
 * conhece a tela vai direto ao que faz, e quem não conhece acha a explicação
 * ao lado do gesto.
 */

const FORMATOS: readonly {
  titulo: string;
  etiqueta: string;
  tom: "entrada" | "saida" | "neutro";
  icone: NomeDoIcone;
  texto: string;
}[] = [
  {
    titulo: "NF-e (XML)",
    etiqueta: "Entrada ou saída",
    tom: "entrada",
    icone: "recibo",
    texto: "O caminho preferido: conferido pela SEFAZ, traz chave, CFOP e valores.",
  },
  {
    titulo: "DANFE (PDF)",
    etiqueta: "Entrada ou saída",
    tom: "entrada",
    icone: "prancheta",
    texto: "O papel da mesma nota. Se o PDF for uma imagem digitalizada, envie o XML.",
  },
  {
    titulo: "Pedido de Saída (UpSeller)",
    etiqueta: "Saída",
    tom: "saida",
    icone: "caixa",
    texto: "Traz SKU e quantidade. Não traz valor, e a conferência não inventa nenhum.",
  },
  {
    titulo: "Envio ao Full (Mercado Livre)",
    etiqueta: "Sem baixa por ora",
    tom: "neutro",
    icone: "caminhao",
    texto: "Lido e conferido, sem baixa: envio ao Full é transferência, não saída (D-352).",
  },
];

const PASSOS = [
  { titulo: "Enviar", texto: "O arquivo sobe e a leitura começa sozinha." },
  { titulo: "Conferir", texto: "Cada item lido é vinculado a um SKU." },
  { titulo: "Confirmar", texto: "Só então o estoque muda — e de uma vez." },
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

      <div className="sb-nf-envio">
        <section className="sb-panel sb-nf-envio-principal" aria-label="Enviar arquivos">
          <UploadForm />
        </section>

        <aside className="sb-nf-envio-lateral">
          <section className="sb-panel sb-nf-guia" aria-labelledby="nf-formatos">
            <header className="sb-nf-guia-cabeca">
              <span className="sb-eyebrow">O QUE A LEITURA RECONHECE</span>
              <h2 id="nf-formatos">Quatro formatos, pelo conteúdo</h2>
              <p>O tipo sai de dentro do arquivo, não do nome dele.</p>
            </header>

            <ul className="sb-nf-formatos">
              {FORMATOS.map((formato) => (
                <li key={formato.titulo} className={`sb-nf-formato sb-nf-formato-${formato.tom}`}>
                  <span className="sb-nf-formato-icone" aria-hidden="true">
                    <Icone nome={formato.icone} tamanho={16} />
                  </span>
                  <div>
                    <div className="sb-nf-formato-topo">
                      <b>{formato.titulo}</b>
                      <small>{formato.etiqueta}</small>
                    </div>
                    <span>{formato.texto}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="sb-panel sb-nf-guia" aria-labelledby="nf-passos">
            <header className="sb-nf-guia-cabeca">
              <span className="sb-eyebrow">DEPOIS DO ENVIO</span>
              <h2 id="nf-passos">Nada muda no estoque sem você</h2>
            </header>

            <ol className="sb-nf-passos">
              {PASSOS.map((passo, indice) => (
                <li key={passo.titulo}>
                  <span className="sb-nf-passo-numero" aria-hidden="true">
                    {indice + 1}
                  </span>
                  <div>
                    <b>{passo.titulo}</b>
                    <span>{passo.texto}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </Shell>
  );
}
