# Arquivado em 2026-09-17 — P0 da trilha 8B e a varredura das 22 RPCs

Saiu do `docs/HANDOFF.md` porque é história fechada: o P0 inteiro está resolvido e a lição das RPCs vive em `docs/PERFORMANCE.md` e nas decisões D-305 a D-307.

## P0 ativos (trilha 8B)

Medidos contra o Dev em 2026-09-01, não herdados de documentação.

**Todo o P0 da trilha 8B fechou** — A a H, cada um com a sua decisão: contexto
dos agentes (D-177), writes sem verificação (D-178), webhooks sem consumidor
(D-179), `has_role` sem organização (D-180), `SECURITY DEFINER` (D-182, sem
vulnerabilidade), e as três de desempenho (D-181, D-183). A frente passa para o
P1.

✅ **O bloco P0 está completo — os nomeados E os três sem letra.** Ficam
listados porque "P0 fechado, A a H" já foi o recorte só dos que tinham letra, e
isso tornava os outros três invisíveis:

| item | estado |
|---|---|
| ~~`get_system_health` com escopo de plataforma~~ | ✅ **fechado em D-209** |
| ~~`ml_accounts` com UPDATE/DELETE para `authenticated`~~ | ✅ **fechado em D-210** |
| ~~`pg_default_acl` de funções~~ | ✅ **fechado em D-211** |

Números completos e método: `docs/PERFORMANCE.md`.

---


## Varredura das 22 RPCs (risco ativo até 2026-09-17)

- **As 22 RPCs foram varridas; sobra vigilância, não suspeita (D-305→D-307).**
  **Duas** tinham a doença do plano genérico
  (`get_listings_dashboard`, `get_stock_coverage`), uma tinha desperdício
  (`get_sales_expanded_summary`, `orders` lido duas vezes) e **16 estão
  saudáveis** — de 1 ms a 1,2 s de estado estável, nenhuma perto do teto de
  8 s. **A lição que fica é sobre a FONTE:** `get_stock_coverage` aparecia
  com 89 ms de média no `pg_stat_statements` e custava **27 s** na forma que
  a tela inicial usa — a estatística mede o que foi chamado, não o que pode
  ser. Toda RPC nova, ou toda mudança de volume, pede o ensaio deliberado:
  6 a 8 execuções como `authenticated`, **cada forma de chamada**, e comparar
  com o mesmo corpo em literais. Corpo rápido + função lenta = é o plano.

