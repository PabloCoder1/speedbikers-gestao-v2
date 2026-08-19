import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Preset base de lint do monorepo.
 *
 * Usa checagem com informação de tipos: é ela que pega os erros que importam
 * num projeto com regras de negócio puras em `@sb/domain` — promise não
 * aguardada, comparação impossível, acesso a valor possivelmente nulo.
 *
 * O TypeScript está fixado na 6.0.3 por restrição de peer do
 * `typescript-eslint`. Ver D-035 em docs/DECISIONS.md antes de atualizar.
 */
export const baseConfig = tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.config.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // Erro engolido em worker é job que falha em silêncio. Ver a auditoria
      // da V2: checkpoints falhavam sem tratamento e o worker reportava
      // sucesso sem persistir estado.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // A V2 terminou com zero `any` em todo o src/. Manter a régua.
      "@typescript-eslint/no-explicit-any": "error",

      // Import de tipo explícito, exigido por `verbatimModuleSyntax`.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],

      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },
);

export default baseConfig;
