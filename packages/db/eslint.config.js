import { baseConfig } from "@sb/config/eslint";

export default [
  {
    // `src/types.ts` é GERADO por `pnpm --filter @sb/db gen:types`.
    //
    // Não lintar: corrigir o estilo dele com --fix seria desfeito na próxima
    // regeração, e o lint voltaria a quebrar. O formato é responsabilidade do
    // gerador da Supabase, não nossa.
    ignores: ["src/types.ts"],
  },
  ...baseConfig,
];
