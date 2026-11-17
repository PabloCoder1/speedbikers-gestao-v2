# Registro do Database Sentinel

> Um bloco por sessão: base, o que foi medido, o que mudou e a próxima ação.
> Checkpoint para Claude Code e Codex. Não editar os mesmos arquivos ou
> migrations em paralelo: quem pegar R1–R5 anota aqui antes.

### 17/11/2026 · Diagnóstico de viabilidade (sessão 1)

- **Base.** Branch `sentinel/custo-do-banco` criada de `origin/main`
  (`d6169205`), na worktree `.claude/worktrees/custo-do-banco`. A checkout
  principal (`v3`, com edições alheias) e a `codex/sentinel-audit` não foram
  tocadas. A `codex/sentinel-audit` tem 10 migrations posteriores ao backup
  (OAuth atômico, cercas do SAC, telemetria, cobertura de estoque etc.).
- **Infraestrutura (MCP, só leitura).** Supabase `Neurix` = plano **Free**;
  produção e Dev **INACTIVE**. Neon `Neurix` = Launch, 7 projetos alheios,
  nenhum criado ou alterado.
- **Backups.** `db_cluster-22-10-2026@16-26-28.backup.gz` (161 MB, dump de
  cluster em texto, `\restrict`) e `imvjfgnaprqsfjlnsyev.storage.zip` (2
  avatares, 55 KB), em `Downloads`. Nada copiado para o repositório.
- **Restore isolado.** Container `sentinel-dbsize`
  (`public.ecr.aws/supabase/postgres:17.6.1.159`, porta `127.0.0.1:56622`),
  `gzip -dc … | psql -U supabase_admin`. O `public` entrou inteiro. O `auth`
  falhou por divergência de schema do GoTrue (esperado numa imagem crua,
  e prova de que o dump de cluster não se restaura às cegas).
- **Medições.** Ver [SIZE_REPORT.md](SIZE_REPORT.md): 1.092 MB; negócio
  ~520 MB; ~420 MB/mês de crescimento; 94,3% das capturas do Full repetidas;
  80% das entregas de notificação não lidas.
- **Simulação destrutiva (só no container).** R1–R5 "em 22/10": 1.092 →
  979 MB. Ganho imediato pequeno (telemetria jovem), grande no regime.
- **Conclusão.** Free inviável (A e B); Neon principal possível, mas com
  custo empatado e alto esforço (C); recomendado Pro só para a produção (D) +
  otimização. Ver [ARCHITECTURE_DECISION.md](ARCHITECTURE_DECISION.md).
- **Não feito.** Nenhuma migration escrita, nenhum projeto criado, nada
  publicado. O container `sentinel-dbsize` segue de pé com a cópia
  **pós-simulação** (para medir de novo do zero: `docker rm -f
  sentinel-dbsize` e refazer o restore, ~2 min).
- **Próxima ação.** Dono: decidir o cenário e a retomada da produção
  (MIGRATION_PLAN §1.2). Agente: escrever R5 e R3/R4 como migrations, com
  teste, no stack local.

### 17/11/2026 · R5 e R3 como migrations (sessão 2)

- **Base.** A `sentinel/custo-do-banco` foi refeita sobre `origin/codex/sentinel-audit` (`513c38f4`). Sobre a `main`, as migrations novas ficariam com carimbo maior que as 10 que só existem nela, e o `db push` recusaria a versão menor. A sessão do Codex está ativa na `codex/sentinel-audit`, com 13 commits locais, migrations `20261117171808` e `20261117173152` e decisões até D-715. Daí os carimbos `20261117182500`/`182600` e as decisões D-720/D-721. **Se o Codex carimbar depois de 18:26 UTC e mergear antes, renumerar as duas antes do merge.**
- **D-720 (R5).** Unique na ordem do `distinct on` no lugar da constraint ASC e do `timeline_idx`. Os índices da tabela caíram de 67 para 47 MB, a construção travou por 0,42 s, e as três formas de leitura mantiveram as páginas ([medição](../PERFORMANCE.md#unicidade-do-full-e-retenção-de-job_runs-d-720-e-d-721-17112026)).
- **D-721 (R3).** `private.expurgar_job_runs()` e `private.agendar_expurgo_de_telemetria()`; gatilho de DELETE com interruptor de transação. O teste novo pegou uma proteção larga demais (a vencida mais nova ficava mesmo com execução recente do tipo), e ela foi corrigida antes do commit.
- **Validação.** Stack isolado `sb-custo` (portas 5947x, `config.toml` alterado só localmente) com todas as migrations: 7 casos novos em `telemetry-retention.integration.test.ts` e a suíte de integração inteira, 1.165 casos em 12 arquivos. Passaram `pnpm run check`, `pnpm run build` e `pnpm docs:check`. O e2e não rodou: nenhuma tela mudou.
- **Pendente.** R4 (`sync_runs`), R1 (compactação do Full) e a decisão do dono sobre notificação informativa (R2). Antes do merge: commit, push e PR, que pedem autorização.
