# Validação

> Database Sentinel, 17/11/2026. O que precisa passar antes de declarar
> aprovada qualquer mudança deste diretório. A coluna "Estado" diz o que já
> rodou.

## 1. Integridade (migração para o Neon, ou restore)

| Verificação | Como | Estado |
|---|---|---|
| Linhas por tabela, origem × destino | `count(*)` em todas as tabelas de `public` e `private`, nunca `n_live_tup` (D-182) | Não aplicável ainda |
| Checksum por tabela | `md5(string_agg(t::text, '' order by pk))` por faixa de PK nas tabelas grandes | Não aplicável |
| FKs e constraints válidas | `select conname from pg_constraint where not convalidated` vazio | Não aplicável |
| Sequências | `max(id)` < `last_value` em todas as `identity` | Não aplicável |
| Valores monetários | soma por mês de cada coluna de valor de `orders`, `order_items`, `order_financials` e `shopee_orders`, origem = destino | Não aplicável |
| Sem duplicação | as uniques do destino existem e o *restore* não as desligou | Não aplicável |
| Restore de ensaio do backup | feito em 17/11: `public` íntegro, `auth` falhou (esperado: imagem crua) | **Feito** |

## 2. Segurança

- RLS positivo e negativo: `packages/db/src/rls.integration.test.ts` e a
  suíte de integração inteira, com `supabase db reset` antes (HANDOFF).
- Isolamento por organização: as duas organizações do seed do e2e.
- Gatilhos append-only de pé depois de qualquer retenção (`job_runs_no_delete`,
  `stock_movements`, `domain_events`): o teste da D-221.
- Medir RPC como `authenticated`, nunca como `postgres` (memória do projeto:
  o MCP ignora a RLS).

## 3. Operação

`pnpm --filter web run e2e:seed` e o Playwright completo (projetos `chromium` e
`loja-live`) com o banco recém-semeado. Fixtures das lojas: nenhuma chamada
real a ML, Shopee ou TikTok. Cobertura: login, produtos, estoque, vendas,
faturamento, pedidos de compra, integrações (fixtures), webhooks (rota da
api com payload gravado), SAC, jobs, Realtime (toast), Storage (avatar).

## 4. Performance

- As nove RPCs do Full atual (D-465) e `get_sku_dashboard`/`get_stock_balances`,
  antes e depois de R1/R5: `explain (analyze, buffers)` como `authenticated`,
  mediana de 5, páginas lidas (`docs/PERFORMANCE.md`).
- Duração do job de retenção sob carga (lock curto, lotes de 5 mil).

## 5. Checagens do repositório

`pnpm run check && pnpm run build && pnpm docs:check`, mais as 7 guardas
`check:*` da web (só a CI as roda; ver `docs/TESTING.md`).
