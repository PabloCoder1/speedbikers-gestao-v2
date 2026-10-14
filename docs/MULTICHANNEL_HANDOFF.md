# Handoff multicanal

> Estado corrente da frente multicanal (Mercado Livre + Shopee), dividida entre
> o **Agente 1** (integração, backend, dados) e o **Agente 2** (telas, filtros,
> dashboards). **Só o AGORA, sem diário** (como `docs/HANDOFF.md`): o porquê vira
> `D-xxx`; os contratos de dados detalhados estão em
> `docs/MULTICHANNEL_CONTRACTS.md` (Agente 1); a auditoria de telas e o modelo do
> filtro, em `docs/MULTICHANNEL_SCREENS.md` (Agente 2).
>
> **Regras:** cada agente edita só a própria seção; as seções comuns mudam por
> acordo, com mensagem ao outro antes. Quem chega à `main` depois faz rebase,
> fica com o arquivo da `main` e reaplica só a própria seção. Contratos: `C-01…`
> do Agente 2 (consumo), `C-50…` do Agente 1 (dados).

---

## Estado

| | |
|---|---|
| Atualizado em | 2026-10-14 |
| `origin/main` | `93304ac3` (#147, #148 e #150: D-432, D-433, D-435) |
| Branches abertas | A1: `feat/vendas-por-marketplace` (E4) · A2: `feat/multicanal-t1-seletor` (PR #149: T1), `feat/multicanal-t2-lojas-usuarios` (rascunho #153: T2) e `feat/multicanal-t3-saude-lojas` (rascunho #154: T3a) |
| Web em produção | `93304ac3` (merge na `main` publica) |
| Worker / api em produção | worker `worker-00045-c2f` e api `api-00028-qmw`, os dois em `93304ac3` (14/10, 100% do tráfego, `/health` da api ok); Shopee **sandbox** |
| Migrations em produção | até `20261014200000` (D-435, run `38585020320`, 14/10). Próxima: `20261014210000` (D-436) |
| Dev | todas as migrations da `main` (CI `38583103789` verde); serviços pausados (D-350) |
| Dado Shopee | 1 loja sandbox, 1 pedido, 1 item de catálogo; jobs horários sem falha em 7 dias. Nenhuma loja real |

---

## Agente 1 — backend/dados Shopee

**Concluído**
- Auditoria do estado real da Shopee e dos acoplamentos com o ML (14/10) — `docs/MULTICHANNEL_CONTRACTS.md` §1–§6.
- E0: D-430 em produção (migration e worker `562b1e60`, 14/10); o ciclo das 14:20 UTC terminou `done` com o worker novo.
- E1, E2 e E3 (D-432, D-433, D-435) **em produção** em 14/10: PRs #147/#148/#150 com CI verde (e2e inclusive), migrations pelo workflow com as duas aprovações do dono, worker e api em `93304ac3`. O vigia de D-418 foi agendado pelo dono (`vigiar-sincronizacao`, a cada 30 min) e agora cobre as lojas live.

**Em andamento**
- E4, vendas por marketplace e o consolidado (D-436): **em código e validada localmente** (integração com as 252 migrations do zero, equivalência com `get_sales_summary` e `get_shopee_sales_by_shop`, mutação do sandbox); PR #151 — falta CI, merge e a migration `20261014210000` (worker e api não mudam).
- E5, faturamento da Shopee (D-437): **em código e validada localmente** (integração com as 253 migrations do zero, equivalência do custo com `get_faturamento`, mutação do histórico de custo); falta PR, CI, merge e a migration `20261014220000`.

**Falta** (ordem proposta, `docs/MULTICHANNEL_CONTRACTS.md` §7)
- E6 grão de SKU, ranking, ABC → E7 fontes financeiras que faltam → E8 Go Live e estoque.

**Bloqueios**
- E4 e E5 em produção dependem do merge e da migration (dono). A exibição do resultado da E5 depende da decisão 1 abaixo (os três números já vêm prontos).

---

## Agente 2 — frontend multicanal

**Concluído**
- T0 — auditoria das telas e mapa de lacunas (14/10): `docs/MULTICHANNEL_SCREENS.md`.
- T1 — **PR #149** (D-431): seletor de marketplace no início da barra de `/vendas`, `/vendas/shopee`, `/anuncios` e `/anuncios/shopee` (só com os dois canais; leva o período ou a busca, nunca conta, loja, marca ou estado); período personalizado em `/vendas/shopee`; `/contas` e o menu como "Contas e lojas"; os quatro jobs `shopee.*` com cadência horária em `/saude` (C-09). Só web; não depende de migration.
- T2 — **rascunho #153** (D-434, consome o C-54): lojas Shopee por usuário em `/usuarios` — gaveta, coluna, histórico e convite que confere no banco o que concedeu. Pré-requisitos de banco e api conferidos em produção.
- T3a — **rascunho #154** (D-438, consome o C-52 e os avisos de D-435): o aviso do vigia com nome e destino em notificações, a seção "Lojas Shopee" em `/sincronizacao` com os limiares do vigia (3 h e 12 h) e a autorização perto de vencer, e a contagem do rodapé por `marketplace_accounts`.
- Validação de cada etapa: `check`, `build`, `docs:check`, unitários e a suíte e2e inteira num stack isolado com o banco recriado do zero (210/210 na T3a; os 3 de convite só com o servidor na porta 3000).

- T4 — `/vendas` com "Todos os marketplaces" e "Shopee" na mesma tela (D-440, consome o C-53): faixa consolidada com o período anterior, várias contas por clique, gráfico de faturamento, unidades e compras e a tabela por marketplace e conta; `/vendas/shopee` vira o detalhe de pedidos e lojas. **Em código e validada localmente** na branch `feat/multicanal-t4-vendas-todos` (sobre a T3a); publica depois das migrations `20261014210000`/`220000` em produção.

**Em andamento**
- Os PRs em cadeia: #149 → #153 → #154, e a T4 sobre eles. Cada um entra depois do anterior; os rascunhos viram prontos na vez deles.

**Falta** (`docs/MULTICHANNEL_SCREENS.md` §8)
- T3b — cartão da Shopee em `/integracoes`, contagem em `/configuracoes` e o seletor de marketplace lendo `marketplace_accounts`.
- T5 — `/faturamento` com a Shopee sobre o C-58 (`get_shopee_faturamento`, D-437, na `main`), **depois da decisão do dono** sobre qual resultado mostrar (definitivo, provisório ou os dois).
- T6 ranking, ABC, SKU e `/produtos` (E6, C-56) → T7 busca universal (C-57) → T8 central e meta (Go Live).
- Selo "Teste" no painel Shopee do SKU (C-06): a C-55 já está em produção — entra numa próxima fatia.
- T-R5: sobreposição de texto no cartão "Por loja" de `/vendas/shopee` no celular (preexistente, D-430).

**Bloqueios**
- T5 espera a decisão do dono sobre o resultado da Shopee. T6 espera os contratos da E6.

**Achados para o dono e o A1**
- O parâmetro `canal` já é o tipo de caso em `/atendimento`: o filtro novo usa `marketplace`.
- O filtro de conta tem cinco convenções na URL (`account`/`conta` por slug, `conta`/`escopo` por uuid, `loja`); os filtros salvos guardam esses valores, então o slug antigo continua aceito na leitura.
- Inferência a medir: a planilha do UpSeller desconta a venda Shopee do estoque, mas a reposição só conta a demanda do ML — cobertura alta demais para SKU que vende na Shopee (T-R3, R11 do A1).
- e2e: rodar a suíte duas vezes no mesmo banco quebra `atendimento` e `notificacoes` (o seed não desfaz caso assumido nem notificação lida) — `db reset` entre rodadas.

---

## Contratos combinados

| Id | O quê | Dono | Consumidor | Estado | Critério de aceite |
|---|---|---|---|---|---|
| C-01 | Seletor Marketplace/Conta em toda tela que filtra por conta; lojas em `/contas`, `/sincronizacao` e no shell | A2 | — | em parte: T3a no rascunho #154 (D-438); T3b a fazer | só lista o que a permissão deixa; slug antigo continua valendo |
| C-02 | `/vendas` e Home com "todos", "ml", "shopee" e várias contas | A2 | — | `/vendas` em código (T4, D-440); a Home ainda não | ML idêntico ao de hoje; a web não soma linha |
| C-03 | `/faturamento` com marketplace e a linha por loja | A2 | — | aguarda E5 (T5) | componente não comparável nunca somado |
| C-04 | Ranking, curva ABC e aba Vendas do SKU com marketplace | A2 | — | aguarda E6 (T6) | — |
| C-05 | Concessão de loja em `/usuarios` | A2 | — | rascunho #153 (T2, D-434) | usuário sem a loja não a vê em tela nenhuma |
| C-06 | Selo de loja de teste no painel Shopee do SKU | A2 | — | **pedido novo ao A1**: `get_sku_shopee_listings` devolver o ambiente | loja sandbox marcada "Teste" |
| C-07 | `/produtos` sem chamar de "sem anúncio/venda" o SKU que só a Shopee tem | A2 | — | **pedido novo ao A1**: `get_products_overview` com a Shopee (depois de E6) | — |
| C-08 | Busca universal achando loja, anúncio e pedido Shopee | A2 | — | **pedido novo ao A1**: `search_entities` com a Shopee | — |
| C-09 | `/saude` com veredito de atraso dos jobs `shopee.*` | A2 | — | em código (T1, D-431) | job horário atrasado aparece como atrasado |
| C-50 | Catálogo e vínculo Shopee: `get_shopee_listings`, `get_shopee_listings_summary`, `get_sku_shopee_listings`, `get_shopee_shop_catalog_counts`, `set_/remove_shopee_sku_link` | A1 | `/anuncios/shopee`, `/skus/[id]`, `/contas` | em produção | — (existente; §3.2) |
| C-51 | Vendas Shopee por loja: `get_shopee_sales_by_shop`, `get_shopee_orders` | A1 | `/vendas/shopee` | em produção (14/10) | migration em produção e a loja de teste na tela |
| C-52 | `marketplace_accounts`: a fonte única do seletor Marketplace/Conta, com `slug` do ML e `shop_id` da Shopee (colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.0); evento de loja `entity_type = 'shopee_shop'` com `shopee_shop_id` (rótulo e link na web: A2) | A1 | seletor do A2; notificações | em produção (D-435, 14/10) | uma linha por conta/loja visível ao usuário, respeitando a permissão por conta/loja |
| C-53 | `get_marketplace_sales_summary` (linhas TOTAL/MARKETPLACE/CONTA) + `get_marketplace_sales_daily` (`p_marketplaces text[]`, `p_account_ids uuid[]`); métricas `multicanal_*` (METRICS 5T) | A1 | `/vendas` (T4) | em código (D-436, migration `20261014210000`) | só ML = números de hoje; linha consolidada no SQL; NULO no que não soma; sandbox fora |
| C-54 | Permissão por loja Shopee: `user_shopee_shop_permissions` (insert/delete direto sob RLS, só ADMIN, só para membro; como `user_account_permissions`), eventos `SHOPEE_SHOP_ACCESS_GRANTED`/`_REVOKED` (coluna `shopee_shop_id`), convite `POST /v1/organization/invites` com `shopeeShopIds` | A1 | tela de Usuários (A2, T2) | em produção (D-433, 14/10; api do convite em `api-00028-qmw`) | usuário sem a loja não lê nada dela, por tabela e por RPC — provado na integração |
| C-55 | `get_sku_shopee_listings` devolve `environment` da loja (atende C-06) | A1 | painel Shopee do SKU | em produção (D-432, 14/10); coluna `environment` no fim | loja sandbox identificável na resposta |
| C-56 | `get_products_overview` conta anúncio e venda Shopee (atende C-07) | A1 | `/produtos` | aceito; depende da E6 (grão de SKU Shopee) | SKU só da Shopee deixa de aparecer como "sem anúncio/sem venda"; contagens do ML iguais |
| C-58 | `get_shopee_faturamento`: TOTAL e por loja, resultado = recebido − custo, definitivo e provisório separados, imposto do dia (colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.5); NÃO soma com o resultado do ML | A1 | `/faturamento` (T5, atende C-03) | em código (D-437, migration `20261014220000`) | os três resultados prontos; nada somado com o ML |
| C-57 | `search_entities` acha loja, anúncio e pedido Shopee (atende C-08) | A1 | busca universal | aceito; depois da E2 (a busca não pode furar a permissão por loja) | resultado Shopee só para quem alcança a loja |

---

## Arquivos que exigem coordenação

| Arquivo | Regra |
|---|---|
| `supabase/migrations/**`, `packages/db/src/types.ts` | só A1; carimbo conferido na pasta principal antes de criar (memória de sessões paralelas) |
| `apps/web/**` (telas e `apps/web/lib`) | só A2 |
| `docs/METRICS.md` | A1 escreve a definição; A2 avisa se a tela precisar de uma métrica que não está lá |
| `docs/HANDOFF.md` | os dois, só a linha da própria frente, perto do limite de 25 KB do `docs:check` |
| `docs/MULTICHANNEL_HANDOFF.md` | este arquivo — cada um na sua seção |
| `AGENTS.md` | uma linha só no roteador ("Shopee, multicanal"), com os três documentos multicanais; quem mudar edita a mesma linha |
| `apps/web/lib/sync-health.ts` (`JOB_CADENCE_MIN`) | A2; falta a cadência dos jobs `shopee.*` (horários) para `/saude` dar veredito — o A1 informa a cadência |

---

## Decisões pendentes do dono

1. **E5 (exibição):** mostrar o resultado de todos os cobertos, só o definitivo (COMPLETED) ou os dois? A RPC já devolve os três; a escolha é da tela.
2. **E4 e E5:** depois dos merges (#151 e o da E5), `migrations-producao.yml` para `20261014210000` e `20261014220000` — esperar a CI da `main` terminar (a trava recusa antes) e fazer as duas aprovações.
