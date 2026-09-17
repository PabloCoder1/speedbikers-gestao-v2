import type { ReactNode } from "react";

import { urlDaLogo } from "../../lib/logo-fornecedor-url";
import { iniciais } from "../../lib/suppliers-overview";

/**
 * A logo do fornecedor, ou as iniciais quando não há (D-370).
 *
 * Um componente só para a lista, o painel, o formulário e a ficha do pedido de
 * compra — a mesma lição do `Avatar` de pessoa (D-354): logo lembrada em quatro
 * lugares à mão é logo esquecida em um deles.
 *
 * `aria-hidden`: o nome está escrito ao lado em todo lugar em que ela aparece.
 * A imagem é ajustada (`contain`), nunca recortada, sobre fundo claro — logo
 * transparente sobre o lilás das iniciais sumiria.
 */
export function LogoFornecedor({
  nome,
  logoPath,
  previewUrl,
  className,
}: {
  nome: string;
  logoPath?: string | null;
  /** Logo escolhida e ainda não enviada (`URL.createObjectURL`). Vence o caminho salvo. */
  previewUrl?: string | null;
  /** O tamanho vem da classe de cada lugar (`sb-forn-avatar`, `sb-fnv-avatar`…). */
  className: string;
}): ReactNode {
  const url = previewUrl ?? urlDaLogo(logoPath);

  return (
    <span aria-hidden="true" className={`sb-avatar ${className}${url === null ? "" : " sb-forn-logo"}`}>
      {url === null ? iniciais(nome) : <img src={url} alt="" loading="lazy" decoding="async" />}
    </span>
  );
}
