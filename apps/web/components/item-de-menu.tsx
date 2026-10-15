"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { CarregandoSeODemorar } from "./carregando-link";

/**
 * Uma opção de menu de filtro (`FilterMenu`, `SavedFilters`) — LINK de
 * navegação suave, não `<a>` (D-500).
 *
 * Era `<a href>`: cada escolha de marca, conta, status ou período recarregava o
 * DOCUMENTO inteiro — HTML, JavaScript, hidratação, a assinatura de Realtime das
 * notificações e as sete leituras do `Shell` —, com a tela em branco no meio.
 * Medido em `/estoque` com 600 ms de latência: 1.544 ms por recarga contra
 * ~900 ms de uma navegação suave para a mesma URL.
 *
 * Duas coisas que o `<a>` dava de graça e o `<Link>` não:
 *
 * - **o menu fechar.** A recarga desmontava o `<details>`; na navegação suave
 *   ele continua montado e aberto. O clique fecha o menu antes de navegar.
 * - **nada a pré-buscar.** Um menu de 30 marcas aberto dispararia 30
 *   pré-buscas de uma página que nunca usa `loading.tsx` (só a `?busca` muda):
 *   `prefetch={false}`.
 */
export function ItemDeMenu({
  href,
  ativo = false,
  children,
}: {
  href: string;
  ativo?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <Link
      className="sb-menu-item"
      aria-current={ativo ? "true" : undefined}
      href={href}
      prefetch={false}
      onClick={(evento) => {
        evento.currentTarget.closest("details")?.removeAttribute("open");
      }}
    >
      {children}
      <CarregandoSeODemorar />
    </Link>
  );
}
