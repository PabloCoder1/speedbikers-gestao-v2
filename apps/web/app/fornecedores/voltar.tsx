import Link from "next/link";
import type { ReactNode } from "react";

import { Icone } from "../../components/icons";

/**
 * O "voltar" do cadastro e da edição de fornecedor (D-367): botão da casa no
 * canto do cabeçalho, com seta. Era um link sublinhado no subtítulo, que o
 * dono achou solto ("o botão de voltar não achei legal").
 */
export function Voltar({ href, rotulo }: { href: string; rotulo: string }): ReactNode {
  return (
    <Link className="sb-button sb-fnv-voltar" href={href}>
      <span className="sb-fnv-voltar-seta" aria-hidden="true">
        <Icone nome="avancar" tamanho={14} />
      </span>
      {rotulo}
    </Link>
  );
}
