"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";

/**
 * Falha inesperada em qualquer tela (lote 1 do pente fino, 18/09). Antes não
 * havia fronteira de erro, e uma exceção mostrava a página crua do Next.
 *
 * Componente de CLIENTE por exigência do Next, e por isso sem o `Shell` — ele
 * lê a sessão no servidor. O que sobra é o essencial: dizer que falhou, tentar
 * de novo (`retry` refaz a leitura do segmento; nesta versão do Next é `retry`,
 * não `reset`) e um caminho para o início. O `digest` é o que liga o relato de
 * quem viu a tela ao log do servidor, sem expor a mensagem interna.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}): ReactNode {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="sb-system-error-page">
      <section className="sb-panel sb-system-state" role="alert">
        <span className="sb-system-state-icon sb-system-state-icon-danger" aria-hidden="true">
          !
        </span>
        <h1>Algo deu errado nesta tela</h1>
        <p>
          A página não conseguiu carregar. Tente de novo; se continuar, avise quem cuida do sistema e informe o código
          abaixo.
        </p>
        {error.digest !== undefined && <code className="sb-system-state-code">código {error.digest}</code>}
        <div className="sb-system-state-actions">
          <button
            className="sb-button sb-button-primary"
            type="button"
            onClick={() => {
              retry();
            }}
          >
            Tentar de novo
          </button>
          <Link className="sb-button" href="/">
            Ir para o início
          </Link>
        </div>
      </section>
    </main>
  );
}
