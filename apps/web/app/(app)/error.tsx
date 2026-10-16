"use client";

/**
 * O erro de uma tela do grupo `(app)` aparece DENTRO da moldura (D-512): o
 * `error.tsx` de um segmento envolve as páginas abaixo dele, mas não o layout
 * do próprio segmento — então a sidebar e a barra superior ficam, e quem caiu
 * num erro continua podendo navegar. O componente é o mesmo da raiz, que segue
 * cobrindo as rotas fora do grupo.
 */
export { default } from "../error";
