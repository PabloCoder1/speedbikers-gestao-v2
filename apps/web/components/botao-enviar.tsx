"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * O botão de envio de um formulário com AÇÃO DE SERVIDOR (`<form
 * action={salvar}>`) — desabilita e diz o que está fazendo enquanto a ação
 * corre (D-502).
 *
 * Um `<button type="submit">` comum num formulário de ação continua clicável
 * durante a ida ao servidor: dois cliques, duas gravações — e nada na tela diz
 * que o primeiro pegou. A auditoria de 14/10 achou isso em `/central/metas`
 * ("remover") e `/central/limites` ("voltar aos padrões"), onde a ação é
 * destrutiva (`docs/UX_SYSTEM.md` §2, item 11).
 *
 * O pendente é o do próprio formulário (`useFormStatus`), com início e fim na
 * ação real. Por isso este botão só funciona DENTRO do `<form>` — e só para
 * ação de servidor ou de cliente: o GET de busca tem o `FormularioFiltro`.
 *
 * `pendente` é o rótulo enquanto corre ("Removendo…"). Sem ele, o rótulo não
 * muda e só o `disabled` e o `aria-busy` avisam.
 */
export function BotaoEnviar({
  children,
  pendente,
  disabled,
  className,
  ...resto
}: {
  children: ReactNode;
  pendente?: ReactNode;
} & Omit<ComponentProps<"button">, "type" | "children">): ReactNode {
  const { pending } = useFormStatus();

  return (
    <button
      {...resto}
      // A forma do design system por padrão; `sb-text-button` para a ação em texto.
      className={className ?? "sb-button"}
      type="submit"
      disabled={pending || disabled === true}
      aria-busy={pending ? "true" : undefined}
    >
      {pending && pendente !== undefined ? pendente : children}
    </button>
  );
}
