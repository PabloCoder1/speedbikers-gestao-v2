# Avaliação de viabilidade: custo do banco do Speed Bikers

> Database Sentinel, 17/11/2026. Entrada para quem chega: responde às sete
> perguntas da primeira entrega e aponta o detalhe.
> [Tamanho](SIZE_REPORT.md) · [Otimização](OPTIMIZATION_PLAN.md) ·
> [Arquitetura](ARCHITECTURE_DECISION.md) · [Migração](MIGRATION_PLAN.md) ·
> [Validação](VALIDATION.md) · [Retorno](ROLLBACK.md) · [Registro](SESSION_LOG.md)

## 1. Respostas

| # | Pergunta | Resposta | Confiança |
|---|---|---|---|
| 1 | Tamanho real do banco | **~1,09 GB** no backup de 22/10 restaurado sem *bloat*. A produção hoje é maior: escritas posteriores mais *bloat* | Medido (estimativa por baixo) |
| 2 | Tabelas que mais ocupam | `orders` 144 MB, `order_items` 115, `fulfillment_stock_snapshots` 113, `notification_recipients` 96, `job_runs` 85, `ml_sales_lines` 69, `domain_events` 66, `shopee_orders` 59. Índices são 38% do total | Medido |
| 3 | O que otimizar sem perder dado importante | Compactar capturas repetidas do Full (94% repetem), reter telemetria (`job_runs`, `sync_runs`, entregas de notificação), parar a entrega de notificação informativa, trocar um índice quase duplicado | Medido + proposta |
| 4 | Dá para operar no Supabase Free? | **Não.** Só o dado de negócio (~520 MB) já passa dos 500 MB. Free acima da cota = somente leitura | Medido |
| 5 | Vale usar o Neon Launch? | **Não agora.** Como banco principal custaria ~US$ 19–39/mês contra US$ 25 do Pro, mais 3–6 semanas de reescrita (PostgREST, `auth.uid()`, Realtime, CI). Como banco de histórico não resolve: o quente já passa de 500 MB | Estimativa |
| 6 | Arquitetura recomendada e custo | **Supabase Pro só para a produção (US$ 25/mês) + Dev numa organização Free + o plano de otimização**, que segura o disco em 8 GB por ~4 anos | Estimativa |
| 7 | Plano de migração | Não há migração de banco no cenário recomendado. Há uma **retomada controlada** da produção numa organização paga e as migrations de otimização. Plano em [MIGRATION_PLAN.md](MIGRATION_PLAN.md), com a migração para o Neon como contingência | — |

Crescimento: **~420 MB/mês** no ritmo de outubro (70% telemetria); com o
plano, **~110–150 MB/mês**. No Free, um banco vazio sairia da cota em ~5
semanas no ritmo atual. Com o banco atual, nunca chega a estar dentro dela.

## 2. Arquitetura atual (o que o banco serve)

- **Supabase** (sa-east-1, Postgres 17.6): banco, Auth (e-mail/senha e
  convites), PostgREST (web, api e worker pelo `supabase-js`), RLS por conta e
  organização (`private.accessible_accounts()`), `pg_cron` (vigia,
  conciliação), Realtime
  (`notification_recipients`, `support_cases`), Storage (avatares).
- **Cloud Run** (`speedbikers-prod`): `worker` (Cloud Tasks; ML, Shopee e
  TikTok; webhooks) e `api`, saindo pelo IP fixo.
- **Vercel**: web Next.js (merge na `main` = produção).
- Integrações que dependem da URL do projeto Supabase: OAuth dos
  marketplaces (callback na api), webhooks (ML/Shopee → api), segredos no
  Secret Manager e na Vercel.

## 3. Estado em 17/11/2026: urgente

| | |
|---|---|
| Organização Supabase `Neurix` | **plano Free** |
| Produção `imvjfgnaprqsfjlnsyev` | **INACTIVE** (pausada) |
| Dev `nmgccyqquwxecqffsidr` | INACTIVE (pausado desde D-350) |
| Neon `Neurix` | Launch, 7 projetos de outras aplicações, nenhum do Speed Bikers |
| Último backup disponível | 22/10/2026 16:26 |

Consequências:

1. **Com o banco pausado, o sistema está fora do ar.** Worker e api não
   gravam, e webhooks do ML e da Shopee chegando agora se perdem ou são
   reentregues dentro da janela de cada marketplace. **Desconhecido:**
   desde quando está pausado, e se foi ato do dono ou da plataforma.
2. **Prazo:** um projeto Free pausado pode ser retomado por **90 dias**. A
   data da pausa não aparece pelo MCP. Ela é posterior a 22/10, então o
   prazo mais cedo possível é ~20/01/2027. Conferir no painel.
3. **Retomar na organização Free é o pior caminho:** o banco de mais de 1 GB
   entra em somente leitura e o worker falha em toda escrita.
4. **Desconhecido:** se um projeto pausado pode ser transferido para outra
   organização antes de retomar. A documentação de transferência não trata
   do caso, e só o painel responde.

## 4. Riscos operacionais

| Risco | Cenário | Mitigação |
|---|---|---|
| Perda de pedidos e eventos durante a pausa | Todos | Depois de retomar: `backfill.orders` cobre 365 dias do ML; Shopee e TikTok relidos pela janela de sincronização; conferir `job_runs`/`sync_runs` |
| Tokens OAuth vencidos durante a pausa | Todos | Contas em `ERROR` pedem nova autorização (D-217): lista para o dono |
| Somente leitura | A, B | Não usar Free para a produção |
| Pausa por inatividade | A, B, C (o projeto do Auth) | Só o Pro não pausa |
| Sem backup diário | Free | Dump próprio agendado, se ficar no Free |
| Regressão de autorização | C | Bateria RLS positivo/negativo completa (VALIDATION §2) |
| Crescimento de telemetria | Todos | OPTIMIZATION_PLAN R1–R5 |
