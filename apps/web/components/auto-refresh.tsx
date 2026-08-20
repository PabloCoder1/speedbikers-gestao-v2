"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

/**
 * Recarrega a página enquanto o lote ainda está sendo lido.
 *
 * O parse roda no worker, de forma assíncrona: quem acabou de enviar cai numa
 * tela "Lendo o arquivo" que, sem isto, nunca mudaria sozinha. Um F5 manual
 * resolveria — e é exatamente o tipo de coisa que faz alguém achar que o
 * sistema travou.
 *
 * Para quando o lote chega a um estado final. Uma tela aberta e esquecida não
 * pode ficar batendo no servidor a noite inteira.
 */
export function AutoRefresh({ intervalMs = 3000 }: { intervalMs?: number }): ReactNode {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      router.refresh();
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [router, intervalMs]);

  return null;
}
