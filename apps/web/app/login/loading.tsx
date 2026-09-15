import type { ReactNode } from "react";

/**
 * O login fica FORA da moldura, e o `app/loading.tsx` a desenha.
 *
 * `/login` é dinâmica desde D-331, então ela também passa pelo fallback da
 * raiz — e quem abre a porta de entrada veria, por um instante, uma sidebar de
 * um sistema em que ainda não entrou. Este arquivo corta a herança: a tela é
 * leve, e o vazio é o mesmo que já existia antes.
 */
export default function Loading(): ReactNode {
  return null;
}
