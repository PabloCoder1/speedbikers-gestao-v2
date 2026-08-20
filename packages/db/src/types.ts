/**
 * Tipos do schema do banco.
 *
 * ESTE ARQUIVO É GERADO. Não editar à mão.
 *
 * Regeração:
 *   pnpm exec supabase gen types typescript --local > packages/db/src/types.ts
 *
 * Enquanto não houver tabela, o tipo é um placeholder vazio e válido. A
 * primeira migration substitui este conteúdo pelo schema real.
 *
 * Escrever tipo de tabela à mão é como as duas verdades divergem: o banco muda,
 * o tipo não, e o TypeScript passa a mentir com confiança.
 */

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
