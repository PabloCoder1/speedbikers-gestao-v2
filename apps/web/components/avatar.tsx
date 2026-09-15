import type { ReactNode } from "react";

import { urlDoAvatar } from "../lib/avatar";
import { iniciais } from "../lib/initials";

/**
 * O avatar de uma pessoa — foto quando há, iniciais quando não (D-354).
 *
 * Um componente só para o topo, a tabela de `/usuarios`, a gaveta e o "Meu
 * perfil". Antes eram três `<span className="sb-avatar">` com as iniciais
 * escritas à mão, e a foto teria que ser lembrada em três lugares.
 *
 * `aria-hidden` sempre: o nome da pessoa está escrito ao lado em todo lugar em
 * que o avatar aparece, e o leitor de tela ouviria "JM João Martins". É também
 * o que mantém o nome acessível das células de `usuarios.spec.ts` intacto.
 */
export function Avatar({
  nome,
  fotoPath,
  tamanho = "md",
  previewUrl,
}: {
  /** De onde saem as iniciais quando não há foto. */
  nome: string;
  fotoPath?: string | null;
  tamanho?: "sm" | "md" | "lg" | "xl";
  /** Foto escolhida e ainda não enviada (`URL.createObjectURL`). Vence o caminho salvo. */
  previewUrl?: string | null;
}): ReactNode {
  const url = previewUrl ?? urlDoAvatar(fotoPath);

  return (
    <span aria-hidden="true" className={`sb-avatar sb-avatar-${tamanho}`}>
      {url === null ? iniciais(nome) : <img src={url} alt="" loading="lazy" decoding="async" />}
    </span>
  );
}
