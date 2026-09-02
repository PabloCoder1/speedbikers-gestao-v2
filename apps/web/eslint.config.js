import { baseConfig } from "@sb/config/eslint";

export default [
  {
    // `scripts/*.mjs` são ferramentas de linha de comando, fora do `tsconfig`
    // do app — o lint com informação de tipo não consegue parseá-las ("was not
    // found by the project service"). Mesma decisão já tomada em
    // `packages/db/eslint.config.js`, e pelo mesmo motivo: incluí-las no
    // tsconfig arrastaria coisa que não é do build do Next para dentro dele.
    ignores: ["scripts/**"],
  },
  ...baseConfig,
];
