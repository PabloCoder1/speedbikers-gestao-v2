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
| `get_stock_balances` | 50 linhas, sem filtro | **9.104 ms** | 751.576 | 🔴 P0-F — resolvido em D-181 |
| `get_listings_dashboard` | 30 dias, 50 linhas | **timeout > 60 s** | — | 🔴 P0-G — resolvido em D-181 |
| `get_fulfillment_overview` | 30 dias, 50 linhas | 97 ms | ~30 k | ✅ dentro do budget (D-173) |
| `get_listings_dashboard` (antes de D-170) | 30 dias, 50 linhas | 578 ms | 30.354 | referência histórica |

### Depois de D-181 — mesma medição, mesmo usuário

| RPC | Tempo | Buffers | Linhas |
|---|---|---|---|
| `get_stock_balances` | **681 ms** (3.138 ms a frio) | 22.516 | 50 |
| `get_listings_dashboard` | **271 ms** (536 ms a frio) | 21.739 (na passada a frio) | 50 |
| `get_sales_expanded_summary` | 700 ms | — | 1 |
| `get_sku_abc_curve` | 417 ms | — | 200 |
| `get_unlinked_listings` | 460 ms | — | 100 |
| `get_stock_coverage` | 314 ms | — | 3.251 |
| `get_sku_timeline` | 57 ms (3.308 ms na 1ª passada, cache frio) | 38.316 | 50 |
| `get_sku_sales_baseline` (depois de D-183) | 49 ms | — | 440 |

As quatro últimas eram o P0-H. **Não tenho o "antes" delas medido**, então
não reivindico ganho — o que está registrado é que hoje estão dentro do
budget, e que nenhuma linha de código de RPC foi tocada para isso.

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

**Confirmado em D-181.** A prova isolada, antes de mexer em qualquer policy:

| `select count(*) from listings` (5.085 linhas visíveis) | Tempo | Buffers |
|---|---|---|
| `using (private.has_account_access(ml_account_id))` | 186,8 ms | 15.802 |
| `using (ml_account_id in (select private.accessible_accounts()))` | **4,8 ms** | **462** |

O plano antigo mostra `Filter: private.has_account_access(ml_account_id)`;
o novo, `hashed SubPlan` com `rows=4 loops=1` — quatro contas no sistema,
uma resposta em vez de 5.085.

### Volume que não é problema (ainda)

`orders` e `order_items` com ~337 k linhas cada são normais para PostgreSQL.
**Não particionar** por causa desses números. E, ao contrário da V2, o TOAST
de `orders` é irrelevante aqui: a V3 já nasceu normalizada, então nenhuma
"solução para `raw_payload` gigante" da V2 se aplica.

---

## Workers — o que `job_runs` já sabia

Até 2026-09-01 este documento só media RPC. Mas o worker tem telemetria
própria desde sempre (`job_runs.duration_ms` e `processed`), e ninguém tinha
olhado. Medido no Dev, todas as execuções registradas:

| Job | Execuções | Médio | p95 |
|---|---|---|---|
| `sync.fulfillment.snapshot` | 175 | **292,9 s** | 397,9 s |
| `sync.listing-visits.snapshot` | 212 | **88,0 s** | 268,5 s |
| `sync.orders.window` | 989 | **65,1 s** | 140,4 s |
| `sync.support.messages.reconcile` | 3.004 | 6,8 s | 20,5 s |
| `sync.support.claims.reconcile` | 568 | 5,2 s | 12,0 s |
| `sync.support.questions.reconcile` | 3.571 | 1,8 s | 6,9 s |
| `sync.support.messages` | 598 | 0,9 s | 1,3 s |
| `sync.support.questions` | 826 | 0,6 s | 0,9 s |
| `analytics.recompute` | 10.972 | 182 ms | 354 ms |
| `sync.webhook.received` | 252.967 | 96 ms | 622 ms |
| `system.ping` | 291 | 0,5 ms | 1 ms |

`backfill.orders` (415 execuções, 17 min de média) fica de fora da leitura:
é carga histórica, roda uma vez por conta e não voltou desde 25/08.

### O que o `sync.webhook.received` esconde na média

Os 96 ms médios são enganosos — a maioria das execuções não faz trabalho
nenhum (é o achado de D-179). Separando:

| | Execuções | Médio | Mediana | p95 |
|---|---|---|---|---|
| com trabalho (1 pedido) | 21.997 | **723,5 ms** | 588 ms | 1.234 ms |
| no-op | 230.993 | 35,8 ms | **0 ms** | 1 ms |

### Como conferir o efeito de D-184 depois do deploy

D-184 tirou uma espera serial de cada pedido, mas o worker **não está no ar** —
o número real só existe depois do deploy. A consulta que responde, comparando
antes e depois pela data do deploy:

```sql
select date_trunc('day', started_at) as dia,
       count(*) as execucoes,
       sum(processed) as pedidos,
       round(avg(duration_ms::numeric / nullif(processed, 0)), 1) as ms_por_pedido
from public.job_runs
where job_type = 'sync.orders.window' and duration_ms is not null and processed > 0
group by 1 order by 1 desc limit 14;
```

Baseline a bater: **660,7 ms por pedido** na janela, **588 ms** de mediana no
webhook com trabalho.

### Persistir UM pedido custa ~600–700 ms, pelos dois caminhos

O número aparece duas vezes, por caminhos independentes, e eles concordam:

- `sync.webhook.received` com trabalho: **723,5 ms** para um pedido
  (inclui um `GET /orders/{id}` no Mercado Livre).
- `sync.orders.window`: **660,7 ms por pedido** (980 execuções, 104.288
  pedidos, **106,4 pedidos por execução**, máximo 1.148).

O laço da janela é estritamente serial — `for await (page) { for (raw of
page) { await persistOrder(...) } }` — e cada pedido custa ~7 idas ao banco.
106 pedidos × 7 = ~742 idas em série por execução, o que explica os 65 s.

⚠️ **Cuidado ao ler esse "por item".** O ROADMAP registrava "buscar vínculos,
`kind` de SKU e componentes de KIT **em lote, em vez de por item**". Medido:
**todo pedido tem exatamente 1 item** — 337.581 pedidos, `position` máximo
`0`, p99 de 1 item. Não é defeito de persistência: no Mercado Livre uma
compra de vários produtos vira um **pack** de vários pedidos de um item cada,
e há 1.794 packs com mais de um pedido (até 6). O laço por item tem
cardinalidade 1; o multiplicador real é o número de **pedidos** na janela.

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
| 2026-09-01 | `listings` (policy pura) | 186,8 ms / 15.802 | **4,8 ms / 462** | RLS como conjunto: `coluna in (select private.accessible_accounts())` no lugar da função escalar por linha | D-181 |
| 2026-09-01 | `get_stock_balances` | 9.104 ms / 751.576 | **681 ms / 22.516** | idem — nenhuma linha da RPC mudou | D-181 |
| 2026-09-01 | `get_listings_dashboard` | timeout > 60 s | **271 ms / 21.739** | idem — nenhuma linha da RPC mudou | D-181 |
| 2026-09-01 | `get_sku_sales_baseline` | 1.334 ms / 4.136 | **49 ms** | `current_day as materialized` (o CTE inlineado virava o lado interno de um nested loop, 440 loops × 31 mil linhas) + filtro de dia da semana empurrado para o agregado | D-183 |

**Lição que se repete:** o mesmo desenho pode ser certo num tamanho e errado
em outro. D-167 reprovou `count(*) over ()` sobre 225 mil linhas; D-173
reprovou o substituto sobre 1.872. Medir, não copiar o padrão anterior.

**Lição de D-181:** antes de reescrever a consulta, verifique quantas vezes o
Postgres avalia a *autorização*. Uma função barata chamada 5.085 vezes custa
mais que uma consulta cara. E o sintoma aponta para o lugar errado: parecia
agregação, era policy.

**Lição de D-183 — duas.** A primeira: **um CTE lido uma vez só é INLINE** no
PostgreSQL 12+, e o inline pode ser catastrófico quando ele cai no lado
interno de um nested loop. `current_day` tinha 175 linhas e era recalculado
uma vez por SKU do resultado. `as materialized` é a correção, e por isso a
migration tem guarda de catálogo: uma reescrita futura que remova a palavra
devolve o segundo perdido.

A segunda: **a primeira medição pode ser cache frio, e enganar nos dois
sentidos**. `get_sku_timeline` mediu 3.308 ms na primeira passada (4.977
blocos lidos do disco) e **57 ms** depois — não era problema nenhum, e quase
virou uma otimização inútil. Meça sempre duas vezes seguidas; se os números
divergirem muito, o primeiro era I/O frio.

⚠️ **A armadilha do baseline** apareceu de novo aqui, ao contrário: a
primeira comparação de visibilidade rodou `set local role authenticated`
**fora de uma transação**, o Postgres descartou em silêncio, e a contagem
saiu como superusuário — com a RLS desligada. Deu 17/6/14 contra os 15/5/13
reais e simulou uma regressão que não existia. Se uma medição de RLS mudar
de forma inexplicável, confira primeiro se o papel realmente trocou.

---

## Índices — critério

Não adicionar índice por advisor, nem remover por `idx_scan = 0`.

Para **criar**, registre: query, `EXPLAIN` antes, índice, `EXPLAIN` depois,
impacto na escrita.

Para **remover**, registre: `idx_scan`, quando as estatísticas foram
resetadas, qual query deveria usá-lo, se é UNIQUE/FK, tamanho e risco.
UNIQUE e constraint **nunca** saem por estatística de uso.
