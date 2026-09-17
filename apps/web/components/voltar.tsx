import Link from "next/link";
import type { ReactNode } from "react";

import { Icone } from "./icons";

/**
 * O "voltar" como botão da casa no canto do cabeçalho, com seta (D-367).
 * Era um link sublinhado no subtítulo, que o dono achou solto ("o botão de
 * voltar não achei legal"). Nasceu em /fornecedores e subiu para cá quando
 * /compras/novo virou o segundo consumidor (D-371).
 */
export function Voltar({ href, rotulo }: { href: string; rotulo: string }): ReactNode {
  return (
    <Link className="sb-button sb-voltar" href={href}>
      <span className="sb-voltar-seta" aria-hidden="true">
        <Icone nome="avancar" tamanho={14} />
      </span>
      {rotulo}
    </Link>
  );
}
