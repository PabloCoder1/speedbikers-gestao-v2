import type { ReactNode } from "react";

import { CarregandoTela } from "../components/carregando";

/**
 * Fallback de Suspense do App Router para TODAS as telas autenticadas.
 *
 * O `Shell` mora dentro de cada página, não num layout — então este fallback
 * substitui a tela inteira, sidebar incluída. Por isso ele redesenha a moldura
 * em vez de mostrar um texto solto no branco. O porquê do atraso e do custo
 * zero está em `components/carregando.tsx`.
 */
export default function Loading(): ReactNode {
  return <CarregandoTela />;
}
