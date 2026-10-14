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
| Branches abertas | A1: `docs/multicanal-contratos` (local, não publicada) · A2: `docs/multicanal-auditoria` (local) |
| Web em produção | `562b1e60`, conferido na Vercel |
| Worker / api em produção | `worker-00043-694` / `api-00027-p7c` em `e037573f` (D-428), Shopee **sandbox** |
| Migrations em produção | até `20261014120000` (D-429); **falta `20261014150000` (D-430)** — `/vendas/shopee` mostra "chegam com a próxima atualização do banco" (degrada, não quebra) |
| Dev | todas as migrations da `main` (CI `38571140787` verde); serviços pausados (D-350) |
| Dado Shopee | 1 loja sandbox, 1 pedido, 1 item de catálogo; jobs horários sem falha em 7 dias. Nenhuma loja real |

---

## Agente 1 — backend/dados Shopee

**Concluído**
- Auditoria do estado real da Shopee e dos acoplamentos com o ML (14/10) — `docs/MULTICHANNEL_CONTRACTS.md` §1–§6.

**Em andamento**
- —

**Falta** (ordem proposta, `docs/MULTICHANNEL_CONTRACTS.md` §7)
- E0 publicar D-430 → E1 ingestão robusta (pedido envenenado no financeiro, gravação atômica) → E2 permissão por loja → E3 `marketplace_accounts` e saúde → E4 vendas por marketplace e consolidado → E5 faturamento Shopee → E6 grão de SKU, ranking, ABC → E7 fontes financeiras que faltam → E8 Go Live e estoque.

**Bloqueios**
- E0 e E2 dependem do dono (ver "Decisões pendentes do dono").

---

## Agente 2 — frontend multicanal

**Concluído**
- Auditoria das telas (14/10), lida rota a rota na `main` `562b1e60`: inventário de ~30 áreas com a classe multicanal, os filtros de conta de hoje, Vendas e Faturamento em detalhe, o desenho do filtro Marketplace/Conta e a sequência T0–T8 — `docs/MULTICHANNEL_SCREENS.md`.

**Em andamento**
- —

**Falta** (`docs/MULTICHANNEL_SCREENS.md` §8)
- **T1, sem depender de contrato novo:** seletor de marketplace (`lib` pura + componente) entre `/vendas` ↔ `/vendas/shopee` e `/anuncios` ↔ `/anuncios/shopee`, levando o período; período personalizado em `/vendas/shopee`; `/contas` falando dos dois canais; cadência dos jobs `shopee.*` em `/saude` (C-09).
- Depois, na ordem dos contratos: T2 concessão de loja (E2) → T3 seletor sobre `marketplace_accounts` e as lojas em sincronização, saúde, integrações e shell (E3) → T4 `/vendas` única com "todos" (E4) → T5 `/faturamento` (E5) → T6 ranking, ABC, SKU e `/produtos` (E6) → T7 busca universal → T8 central e meta (Go Live).

**Bloqueios**
- T2 a T6 esperam os contratos C-52 a C-54 e os de E5/E6. Nenhuma tela nova lista loja Shopee antes de E2 (risco S1).

**Achados para o dono e o A1**
- O parâmetro `canal` já é o tipo de caso em `/atendimento`: o filtro novo usa `marketplace`.
- O filtro de conta tem cinco convenções na URL (`account`/`conta` por slug, `conta`/`escopo` por uuid, `loja`); os filtros salvos guardam esses valores, então o slug antigo continua aceito na leitura.
- Inferência a medir: a planilha do UpSeller desconta a venda Shopee do estoque, mas a reposição só conta a demanda do ML — cobertura alta demais para SKU que vende na Shopee (T-R3).

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
| C-09 | `/saude` com veredito de atraso dos jobs `shopee.*` | A2 | — | T1, sem contrato novo | job horário atrasado aparece como atrasado |
| C-50 | Catálogo e vínculo Shopee: `get_shopee_listings`, `get_shopee_listings_summary`, `get_sku_shopee_listings`, `get_shopee_shop_catalog_counts`, `set_/remove_shopee_sku_link` | A1 | `/anuncios/shopee`, `/skus/[id]`, `/contas` | em produção | — (existente; §3.2) |
| C-51 | Vendas Shopee por loja: `get_shopee_sales_by_shop`, `get_shopee_orders` | A1 | `/vendas/shopee` | em código; Dev sim, produção não | migration em produção e a loja de teste na tela |
| C-52 | `marketplace_accounts`: a fonte única do seletor Marketplace/Conta, com `slug` do ML e `shop_id` da Shopee | A1 | seletor do A2 | proposto (E3) | uma linha por conta/loja visível ao usuário, respeitando a permissão por conta/loja |
| C-53 | `get_marketplace_sales_summary` + série diária (`p_marketplaces text[]`, `p_account_ids uuid[]`) | A1 | `/vendas` | proposto (E4) | só ML = números de hoje; linha consolidada no SQL; NULO no que não soma; sandbox fora |
| C-54 | Permissão por loja Shopee + concessão para a tela de Usuários | A1 | tela de Usuários (A2) | proposto (E2), depende do dono | usuário sem a loja não lê nada dela, por tabela e por RPC |

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

1. **E0:** disparar `migrations-producao.yml` para `20261014150000` (D-430) e fazer as duas aprovações; depois, o deploy do worker.
2. **E2:** a loja Shopee segue a mesma permissão por conta do ML (ADMIN vê tudo; os demais, o que for concedido)? Proposta: sim, concedendo as lojas atuais a quem hoje tem todas as contas ML.
3. **E5:** o resultado da venda Shopee usa o recebido provisório (pedido ainda não COMPLETED) ou só o definitivo?
