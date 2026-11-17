# Plano de migração e de retomada

> Database Sentinel, 17/11/2026. **Nada aqui foi executado.** Todo passo
> marcado **[dono]** é ato com cobrança, visível ao cliente ou em produção, e
> espera aprovação explícita.

## Parte 1 — Caminho recomendado: retomar a produção numa organização Pro

### 1.1 Antes (sem cobrança, sem tocar produção)

1. Conferir no painel do Supabase: data e motivo da pausa da produção, prazo
   de retomada, e se o projeto pausado aceita transferência.
2. Conferir se o projeto Dev deve continuar existindo (D-350: pausado desde
   14/09, sem app ML próprio).
3. Aplicar no **stack local** as migrations de otimização R5, R3/R4 e R1
   ([OPTIMIZATION_PLAN.md](OPTIMIZATION_PLAN.md)) e rodar as suítes
   ([VALIDATION.md](VALIDATION.md)).

### 1.2 Retomada [dono]

Opção 1, se o pausado aceitar transferência:

1. **[dono]** Criar a organização `Speed Bikers` no plano **Pro** (US$ 25/mês;
   o crédito de US$ 10 cobre o Micro).
2. **[dono]** Transferir `imvjfgnaprqsfjlnsyev` para ela. A transferência não
   muda URL, chaves nem *ref*: Vercel, Cloud Run e OAuth continuam valendo.
3. **[dono]** Retomar o projeto.

Opção 2, se não aceitar:

1. **[dono]** Subir a `Neurix` para Pro, retomar a produção e transferir o
   Dev para uma organização Free. Se o Dev ficasse, cobraria ~US$ 10 a mais.

Sem cópia de dados, sem troca de URL e sem corte de banco: é a mesma
instância.

### 1.3 Depois de retomar

1. Medir no projeto real o que o backup não deu: `pg_database_size`,
   *bloat*, *dead tuples*, `pg_stat_user_indexes`, WAL. Atualizar o
   SIZE_REPORT.
2. Conferir que o worker e a api voltaram (revisões fixas, `APP_COMMIT`) e
   que `job_runs` cresce.
3. Recuperar o período da pausa: estado das contas (`ERROR` = nova
   autorização, pedido ao dono), janela de pedidos do ML, Shopee e TikTok.
4. Publicar as migrations de otimização pelo workflow de produção (CI da
   `main` verde, duas aprovações, nunca pelo MCP).
5. Ativar o backup diário do Pro e registrar o teste de restore (item
   bloqueador do ROADMAP: "backup e restore verificados").

## Parte 2 — Contingência: migrar o banco para o Neon (cenário C)

Só se o dono escolher C ([ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md)).
**Não restaurar o dump de cluster num destino novo:** o restore de ensaio
mostrou ~40 erros só no schema `auth` (colunas que divergem entre versões do
GoTrue, chaves primárias duplicadas, FKs que caem) e `\connect` bloqueado
pelo `\restrict`.

1. **Origem atualizada:** a produção retomada, nunca o backup de 22/10.
   Dump por schema (`pg_dump --schema=public --schema=private`), sem
   `auth`/`storage`/`realtime`/`supabase_*`.
2. **Destino:** projeto Neon novo, `speedbikers-prod`, em `aws-sa-east-1`, PG
   17. **[dono]** aprova o custo antes de criar. Projetos Neon existentes
   não são tocados.
3. **Schema pelas migrations do Git** (305 na `main`; mais 10 só na
   `codex/sentinel-audit`), com os ajustes de compatibilidade: *shim* de
   `auth.uid()`/`auth.jwt()`, Vault → cifragem própria, `pg_cron` ou
   agendador externo. Conferir `supabase_migrations.schema_migrations`
   contra o Git antes.
4. **Dados:** `pg_restore --data-only --disable-triggers` (os gatilhos
   append-only recusariam), na ordem das FKs. Depois, `setval` de todas as
   sequências e `analyze`.
5. **Auth:** fica no Supabase. Os `user_id` não mudam, porque `profiles.id`
   = `auth.users.id`.
6. **Acesso:** Neon Data API com JWKS do Supabase Auth; papéis `anon`,
   `authenticated` e `service_role` recriados com os mesmos *grants*.
7. **Código:** cliente de dados configurável por URL (web, api, worker);
   Realtime → *polling*; CI com Postgres próprio no lugar de `supabase start`.
8. **Captura de mudanças:** janela de escrita congelada (worker escalado
   a 0, Scheduler pausado, webhooks enfileirados no ML/Shopee por até a
   janela de reentrega), dump incremental das tabelas que mudaram,
   conferência pela VALIDATION §1. Sem escrita dupla.
9. **Corte [dono]:** troca das variáveis na Vercel e no Cloud Run (revisão
   nova, tráfego fixo, D-342), OAuth e webhooks continuam na api (URL igual).
   A origem fica intacta e pausada por pelo menos 30 dias ([ROLLBACK.md](ROLLBACK.md)).
