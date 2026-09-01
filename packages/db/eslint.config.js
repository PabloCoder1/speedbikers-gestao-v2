import { baseConfig } from "@sb/config/eslint";

export default [
  {
    // `src/types.ts` é GERADO por `pnpm --filter @sb/db gen:types`.
    //
    // Não lintar: corrigir o estilo dele com --fix seria desfeito na próxima
    // regeração, e o lint voltaria a quebrar. O formato é responsabilidade do
    // gerador da Supabase, não nossa.
    // `scripts/*.mjs` são ferramentas de linha de comando, fora do
    // `tsconfig` do pacote — o lint com informação de tipo não consegue
    // parseá-las ("was not found by the project service"). Incluí-las no
    // tsconfig arrastaria `node_modules` para dentro do build do pacote; é
    // mais barato não lintar um script que não é publicado.
    ignores: ["src/types.ts", "scripts/**"],
  },
  ...baseConfig,
];
