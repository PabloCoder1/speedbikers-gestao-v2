import Link from "next/link";
import type { ReactNode } from "react";

import { Icone } from "../components/icons";
import { PageTitle } from "../components/page-title";
import { Shell } from "../components/shell";

export const metadata = { title: "Página não encontrada — Speed Bikers Gestão" };

/**
 * 404 da aplicação inteira: URL que não existe E todo `notFound()` das telas de
 * detalhe (SKU, anúncio, pedido, caso, importação...).
 *
 * Até o lote 1 do pente fino (18/09) não havia este arquivo, e o Next mostrava
 * a página crua dele — sem o menu e sem caminho de volta. Aqui fica dentro do
 * `Shell`: quem caiu num link velho continua no sistema.
 *
 * O texto não afirma "não existe": nas telas de detalhe o `null` pode ser
 * "não existe" ou "a policy escondeu" (mesmo raciocínio de /compras/[id]).
 */
export default function NotFound(): ReactNode {
  return (
    <Shell>
      <PageTitle eyebrow="ERRO 404" title="Página não encontrada" compacto />

      <section className="sb-panel sb-system-state">
        <span className="sb-system-state-icon" aria-hidden="true">
          <Icone nome="lupa" tamanho={20} />
        </span>
        <h2>Não encontramos o que você procurava</h2>
        <p>
          O endereço pode estar errado, o registro pode ter sido removido ou você pode não ter acesso a ele. Use a
          busca no topo (Ctrl K) ou volte para uma tela conhecida.
        </p>
        <div className="sb-system-state-actions">
          <Link className="sb-button sb-button-primary" href="/">
            Ir para o início
          </Link>
          <Link className="sb-button" href="/acoes">
            Central de Ações
          </Link>
        </div>
      </section>
    </Shell>
  );
}
