# Performance — baseline e histórico de otimização

> Dono documental de: medições de performance, antes/depois, planos e
> decisões de índice. O `HANDOFF` só aponta para cá — números não moram lá
> (D-177).

## Como medir (e por que do jeito difícil)

**Meça como usuário autenticado real.** A RLS faz parte do custo que a
interface paga, e medir como `postgres`/`service_role` esconde justamente o
nó mais caro. No Dev, dentro de uma transação revertida:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','<user_id de um ADMIN>')::text, true);
explain (analyze, buffers, format text)
select * from public.<rpc>(...);
rollback;
```

⚠️ **Armadilha medida em 2026-09-01:** se o `set_config` não for aplicado, a
RLS nega tudo e a RPC responde em dezenas de milissegundos com **zero
linhas** — que parece um resultado excelente. `get_stock_balances` "mediu"
41 ms assim, contra **9.104 ms** reais. Sempre confira a contagem de linhas
antes de acreditar no tempo.

Uma função SQL aparece como `Function Scan` e esconde o plano interno. Para
ver o nó dominante, rode o corpo da função como consulta solta, com os mesmos
parâmetros.

## Budget de arquitetura

Não são testes de CI (seriam instáveis). São o alvo para benchmark
controlado:

| Superfície | Alvo (p95) |
|---|---|
| Home, Vendas, Estoque | < 1,5 s |
| Anúncios, SKU (por aba) | < 1,5–2 s |
| Busca universal | percepção instantânea |
| Webhook (ACK) | imediato, sem I/O externo |

---

## Baseline — 2026-09-01

Ambiente: Supabase Dev `nmgccyqquwxecqffsidr`. Dados: 337.303 `orders`,
337.301 `order_items`, 226.511 `stock_movements`, 265.276 `job_runs`,
63.249 `domain_events`. Papel: `authenticated`, ADMIN da única organização.

| RPC | Parâmetros | Tempo | Buffers | Situação |
|---|---|---|---|---|
| `get_stock_balances` | 50 linhas, sem filtro | **9.104 ms** | 751.576 | 🔴 P0-F |
| `get_listings_dashboard` | 30 dias, 50 linhas | **timeout > 60 s** | — | 🔴 P0-G |
| `get_fulfillment_overview` | 30 dias, 50 linhas | 97 ms | ~30 k | ✅ dentro do budget (D-173) |
| `get_listings_dashboard` (antes de D-170) | 30 dias, 50 linhas | 578 ms | 30.354 | referência histórica |

### O achado que muda a ordem de ataque

O timeout de `get_listings_dashboard` **não** falhou num nó de agregação. O
`CONTEXT` do erro do Postgres aponta para dentro da função de RLS:

```
CONTEXT:  SQL function "has_account_access" statement 1
          SQL function "get_listings_dashboard" statement 1
```

Ou seja: o custo dominante é a **policy sendo avaliada por linha**, não a
consulta em si. As policies quentes hoje:

| Tabela | Policy de SELECT |
|---|---|
| `listings` | `private.has_account_access(ml_account_id)` |
| `daily_listing_metrics` | `private.has_account_access(ml_account_id)` |
| `inventory_balances` | `private.is_member_of(organization_id)` |
| `stock_movements` | `private.is_member_of(organization_id)` |

Consequência prática: **atacar a RLS antes de reescrever as RPCs**. Uma
policy set-based (conjunto de contas/organizações resolvido uma vez, com a
policy virando teste de pertencimento) tende a beneficiar todas as telas de
uma vez, enquanto reescrever cada RPC resolve uma tela por vez. A segurança
não pode ser afrouxada para isso — o alvo é o mesmo predicado avaliado menos
vezes.

### Volume que não é problema (ainda)

`orders` e `order_items` com ~337 k linhas cada são normais para PostgreSQL.
**Não particionar** por causa desses números. E, ao contrário da V2, o TOAST
de `orders` é irrelevante aqui: a V3 já nasceu normalizada, então nenhuma
"solução para `raw_payload` gigante" da V2 se aplica.

---

## Trabalho desnecessário medido

| O quê | Medição | Item |
|---|---|---|
| Webhooks sem consumidor viravam Cloud Task | `sync.webhook.received` = **243.944** de 265.276 linhas de `job_runs` (92%) | ✅ P0-C, D-179 |

Cada uma dessas linhas custou: notificação → API → Cloud Task → dispatch →
Cloud Run → router → gravação em `job_runs` → retorno. Para nada.

### Por tópico, antes da correção (2026-09-01)

| Tópico | Execuções | Com trabalho | Consumidor |
|---|---|---|---|
| `shipments` | 54.727 | 0 | não |
| `user-products` | 46.597 | 0 | não |
| `collections` | 33.893 | 0 | não |
| `seller-promotions` | 25.850 | 0 | não |
| `items` | 21.742 | 0 | não |
| `items` (price) | 16.398 | 0 | não |
| `users` | 9.952 | 0 | não |
| `stock-location` | 7.835 | 0 | não |
| `suggestions` + `sites` + `flex` + `catalog_suggestions` | 1.756 | 0 | não |
| **`orders_v2`** | 20.799 | 20.376 | **sim** |
| **`post_purchase`** | 5.520 | 669 | **sim** |

**218.750 execuções — 89,7% do caminho genérico e 82,5% de todo o
`job_runs` — existiram para não fazer nada.**

A correção (D-179) é uma allowlist na borda, em `@sb/contracts` para a `api`
e o `worker` lerem a mesma lista: sem consumidor, ACK + log estruturado,
**sem Cloud Task**.

⚠️ **A redução ainda não aconteceu em produção.** O código no ar é anterior
a esta mudança e continua enfileirando tudo. Para comprovar depois do
deploy:

```sql
-- Antes: sync.webhook.received domina o dia e quase tudo tem processed = 0.
-- Alvo:  só orders_v2/post_purchase criam job; o resto some da tabela.
select date_trunc('day', started_at) as dia,
       count(*) filter (where job_type = 'sync.webhook.received') as genericos,
       count(*) filter (where job_type = 'sync.webhook.received'
                          and status = 'done' and processed = 0) as noop,
       count(*) as total_jobs
from job_runs
where started_at >= now() - interval '7 days'
group by 1 order by 1 desc;
```

`post_purchase` continua tendo no-op legítimo (3.797 de 5.520): o tópico TEM
consumidor, e é o handler que decide que aquela notificação específica não
gera trabalho. Isso não é desperdício de fila — é filtro de domínio, e fica.

---

## Histórico de otimizações medidas

Cada linha tem o antes/depois real, não estimativa.

| Data | Alvo | Antes | Depois | Como | Decisão |
|---|---|---|---|---|---|
| 2026-08-31 | `get_stock_movements` | 685 ms | **64 ms** | página e contagem como subconsultas independentes + índice `stock_movements_org_timeline_idx` | D-167 |
| 2026-08-31 | `get_listings_dashboard` | 578 ms | 59,8 ms (inline) | agregar métricas por dia antes do join, em vez de nested loop com memoize (50.949 → 4.149 buffers) | D-170 |
| 2026-08-31 | `get_fulfillment_overview` | 899 ms | **53 ms** | `as materialized` na CTE do espelho + `count(*) over ()` | D-173 |
| 2026-08-31 | Espelho do Full (leitura) | 110 ms / 85.805 buffers | 24 ms / 27.270 | janela de frescor de 3 dias no `distinct on` | D-173 |

**Lição que se repete:** o mesmo desenho pode ser certo num tamanho e errado
em outro. D-167 reprovou `count(*) over ()` sobre 225 mil linhas; D-173
reprovou o substituto sobre 1.872. Medir, não copiar o padrão anterior.

---

## Índices — critério

Não adicionar índice por advisor, nem remover por `idx_scan = 0`.

Para **criar**, registre: query, `EXPLAIN` antes, índice, `EXPLAIN` depois,
impacto na escrita.

Para **remover**, registre: `idx_scan`, quando as estatísticas foram
resetadas, qual query deveria usá-lo, se é UNIQUE/FK, tamanho e risco.
UNIQUE e constraint **nunca** saem por estatística de uso.
