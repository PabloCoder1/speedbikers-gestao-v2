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
| `origin/main` | `562b1e60` (D-430) |
| Branches abertas | A1: `feat/shopee-ingestao-robusta` (PR #147: E1 + estes documentos) e `feat/shopee-permissao-por-loja` (E2, sobre a #147) e `feat/marketplace-accounts-e-vigia` (E3, sobre a E2) · A2: `feat/multicanal-t1-seletor` (PR #149: T1) |
| Web em produção | `562b1e60`, conferido na Vercel |
| Worker / api em produção | worker `worker-00044-p8d` em `562b1e60` (D-430); api `api-00027-p7c` em `e037573f`; Shopee **sandbox** |
| Migrations em produção | até `20261014150000` (D-430, 14/10). Próximas: `20261014180000` (D-432), `20261014190000` (D-433) e `20261014200000` (D-435), antes do worker e da api |
| Dev | todas as migrations da `main` (CI `38571140787` verde); serviços pausados (D-350) |
| Dado Shopee | 1 loja sandbox, 1 pedido, 1 item de catálogo; jobs horários sem falha em 7 dias. Nenhuma loja real |

---

## Agente 1 — backend/dados Shopee

**Concluído**
- Auditoria do estado real da Shopee e dos acoplamentos com o ML (14/10) — `docs/MULTICHANNEL_CONTRACTS.md` §1–§6.
- E0: D-430 em produção (migration e worker `562b1e60`, 14/10); o ciclo das 14:20 UTC terminou `done` com o worker novo.

**Em andamento**
- E1, ingestão robusta (D-432): **em código e validada localmente** (unitários, integração com as migrations do zero, mutações); PR #147 — falta CI, merge, migration `20261014180000` em produção e o deploy do worker.
- E2, permissão por loja (D-433): **em código e validada localmente** (integração 946/946 com as 250 migrations do zero, mutação da política, ensaio do backfill); PR #148 — falta CI, merge, migration `20261014190000` e o deploy da api (convite com lojas).
- E3, contas dos marketplaces e vigia da loja (D-435): **em código e validada localmente** (integração 952/952 com as 251 migrations do zero, mutações do fan-out, da RLS e da referência do vigia); falta PR, CI, merge e a migration `20261014200000` (worker e api não mudam).

**Falta** (ordem proposta, `docs/MULTICHANNEL_CONTRACTS.md` §7)
- E4 vendas por marketplace e consolidado → E5 faturamento Shopee → E6 grão de SKU, ranking, ABC → E7 fontes financeiras que faltam → E8 Go Live e estoque.

**Bloqueios**
- E1 e E2 em produção dependem do dono (merge e migration; ver "Decisões pendentes do dono").

---

## Agente 2 — frontend multicanal

**Concluído**
- T0 — auditoria das telas e mapa de lacunas (14/10): `docs/MULTICHANNEL_SCREENS.md`.
- T1 — **em código e validada localmente, não publicada** (D-431, branch `feat/multicanal-t1-seletor`): seletor de marketplace no início da barra de `/vendas`, `/vendas/shopee`, `/anuncios` e `/anuncios/shopee` (só com os dois canais; leva o período ou a busca, nunca conta, loja, marca ou estado); período personalizado em `/vendas/shopee`; `/contas` e o menu como "Contas e lojas"; os quatro jobs `shopee.*` com cadência horária em `/saude` (C-09). Validado: `check`, `build`, `docs:check`, 13 unitários novos, e2e 41/41 nas telas tocadas e 208/208 na suíte inteira num stack isolado (4 só passaram reexecutadas, por ambiente — D-431).

**Em andamento**
- Publicar a T1: PR depois do aval do dono. Se o PR #147 (A1) entrar antes, rebase: fico com este arquivo e o `AGENTS.md` da `main` e reaplico só esta seção; a D-431 vai antes da D-432 no `DECISIONS.md`.

**Falta** (`docs/MULTICHANNEL_SCREENS.md` §8)
- T2 concessão de loja em `/usuarios` (C-54, E2) → T3 seletor sobre `marketplace_accounts` e as lojas em sincronização, integrações, configurações e shell (C-52, E3) → T4 `/vendas` única com "todos" (C-53, E4) → T5 `/faturamento` (E5) → T6 ranking, ABC, SKU e `/produtos` (E6, C-56) → T7 busca universal (C-57) → T8 central e meta (Go Live).
- Selo "Teste" no painel Shopee do SKU (C-06) quando a C-55 estiver em produção.
- T-R5: sobreposição de texto no cartão "Por loja" de `/vendas/shopee` no celular (preexistente, D-430).

**Bloqueios**
- T2 a T6 esperam os contratos C-52 a C-54 e os de E5/E6. Nenhuma tela nova lista loja Shopee antes de E2 (risco S1).

**Achados para o dono e o A1**
- O parâmetro `canal` já é o tipo de caso em `/atendimento`: o filtro novo usa `marketplace`.
- O filtro de conta tem cinco convenções na URL (`account`/`conta` por slug, `conta`/`escopo` por uuid, `loja`); os filtros salvos guardam esses valores, então o slug antigo continua aceito na leitura.
- Inferência a medir: a planilha do UpSeller desconta a venda Shopee do estoque, mas a reposição só conta a demanda do ML — cobertura alta demais para SKU que vende na Shopee (T-R3, R11 do A1).

---

## Contratos combinados

| Id | O quê | Dono | Consumidor | Estado | Critério de aceite |
|---|---|---|---|---|---|
| C-01 | Seletor Marketplace/Conta em toda tela que filtra por conta; lojas em `/contas`, `/sincronizacao` e no shell | A2 | — | aguarda C-52 (T3) | só lista o que a permissão deixa; slug antigo continua valendo |
| C-02 | `/vendas` e Home com "todos", "ml", "shopee" e várias contas | A2 | — | aguarda C-53 (T4) | ML idêntico ao de hoje; a web não soma linha |
| C-03 | `/faturamento` com marketplace e a linha por loja | A2 | — | aguarda E5 (T5) | componente não comparável nunca somado |
| C-04 | Ranking, curva ABC e aba Vendas do SKU com marketplace | A2 | — | aguarda E6 (T6) | — |
| C-05 | Concessão de loja em `/usuarios` | A2 | — | aguarda C-54 (T2) | usuário sem a loja não a vê em tela nenhuma |
| C-06 | Selo de loja de teste no painel Shopee do SKU | A2 | — | **pedido novo ao A1**: `get_sku_shopee_listings` devolver o ambiente | loja sandbox marcada "Teste" |
| C-07 | `/produtos` sem chamar de "sem anúncio/venda" o SKU que só a Shopee tem | A2 | — | **pedido novo ao A1**: `get_products_overview` com a Shopee (depois de E6) | — |
| C-08 | Busca universal achando loja, anúncio e pedido Shopee | A2 | — | **pedido novo ao A1**: `search_entities` com a Shopee | — |
| C-09 | `/saude` com veredito de atraso dos jobs `shopee.*` | A2 | — | em código (T1, D-431) | job horário atrasado aparece como atrasado |
| C-50 | Catálogo e vínculo Shopee: `get_shopee_listings`, `get_shopee_listings_summary`, `get_sku_shopee_listings`, `get_shopee_shop_catalog_counts`, `set_/remove_shopee_sku_link` | A1 | `/anuncios/shopee`, `/skus/[id]`, `/contas` | em produção | — (existente; §3.2) |
| C-51 | Vendas Shopee por loja: `get_shopee_sales_by_shop`, `get_shopee_orders` | A1 | `/vendas/shopee` | em produção (14/10) | migration em produção e a loja de teste na tela |
| C-52 | `marketplace_accounts`: a fonte única do seletor Marketplace/Conta, com `slug` do ML e `shop_id` da Shopee (colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.0); evento de loja `entity_type = 'shopee_shop'` com `shopee_shop_id` (rótulo e link na web: A2) | A1 | seletor do A2; notificações | em código (D-435, migration `20261014200000`) | uma linha por conta/loja visível ao usuário, respeitando a permissão por conta/loja |
| C-53 | `get_marketplace_sales_summary` + série diária (`p_marketplaces text[]`, `p_account_ids uuid[]`) | A1 | `/vendas` | proposto (E4) | só ML = números de hoje; linha consolidada no SQL; NULO no que não soma; sandbox fora |
| C-54 | Permissão por loja Shopee: `user_shopee_shop_permissions` (insert/delete direto sob RLS, só ADMIN, só para membro; como `user_account_permissions`), eventos `SHOPEE_SHOP_ACCESS_GRANTED`/`_REVOKED` (coluna `shopee_shop_id`), convite `POST /v1/organization/invites` com `shopeeShopIds` | A1 | tela de Usuários (A2, T2) | em código (D-433, migration `20261014190000`) | usuário sem a loja não lê nada dela, por tabela e por RPC — provado na integração |
| C-55 | `get_sku_shopee_listings` devolve `environment` da loja (atende C-06) | A1 | painel Shopee do SKU | em código (D-432, migration `20261014180000`); coluna `environment` no fim, sem quebrar quem lê | loja sandbox identificável na resposta |
| C-56 | `get_products_overview` conta anúncio e venda Shopee (atende C-07) | A1 | `/produtos` | aceito; depende da E6 (grão de SKU Shopee) | SKU só da Shopee deixa de aparecer como "sem anúncio/sem venda"; contagens do ML iguais |
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

1. **E1:** depois do merge, disparar `migrations-producao.yml` para `20261014180000` (D-432) e fazer as duas aprovações; depois, o deploy do worker. (A E0 está feita; há um run `38574819387` parado na 1ª aprovação do mesmo SHA da D-430, sem nada a aplicar — pode ser cancelado.)
2. **E2 (confirmar antes do merge):** implementada com a regra proposta — a loja segue a permissão por conta do ML (ADMIN vê tudo; os demais, o que for concedido), e as lojas atuais foram concedidas a quem hoje tem todas as contas ML. Loja conectada depois nasce só do ADMIN até ser concedida. Outra regra = ajuste na migration antes do merge.
3. **E5:** o resultado da venda Shopee usa o recebido provisório (pedido ainda não COMPLETED) ou só o definitivo?
4. **Vigia de sincronização (D-418, vale para o ML e, com a E3, para a Shopee):** NUNCA foi agendado em produção — `cron.job` vazio em 14/10. Ato único, no SQL Editor de produção: `select private.agendar_vigia_da_sincronizacao();`. Sem ele, conta ou loja que para de rodar não avisa (só a falha registrada e o ERROR avisam).
