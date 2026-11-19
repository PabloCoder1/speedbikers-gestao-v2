# Estado e finalização do Speed Bikers V3 — 18/11/2026

Este corte substitui a leitura de disponibilidade de 11/11. Foi apresentado ao dono antes de novas alterações. Não é autorização para merge, deploy, mudança de faturamento, exclusão de nuvem ou migration em produção.

## Atualização de 19/11/2026

- **Fechamento técnico de 59,3%.** F05 passou a Publicado após o PR #332 incorporar o #330. O run `44381338715` em `2da04c93` registrou 1.197 testes SQL e 342 E2E. Em 19/11, GitHub e o alias de produção da Vercel apontaram para `f2eb787c`, deployment `dpl_DxjdksaBE1QZRqzK7o9B52mgcKbN` READY. O registro do #333 inclui navegação autenticada e deixa a validação de três planilhas reais pendente. [PR #332](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/332) · [PR #333](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/333)
- **Recuperação da VM.** O #333 registra 17 versões de novembro no catálogo até `20261118211000`, um restore isolado bem-sucedido e o ensaio da mesma faixa de SQL. Em 19/11, o snapshot automático estava READY e a listagem de `diario/` retornou vazia. I03 continua em andamento até provar dump recorrente e alerta. Run mantém `api-00039-22b` e `worker-00058-mbc` com 100% do tráfego. Dois dos 18 agendamentos habilitados tinham último código 14. A `main` continua sem proteção ou rulesets.
- **Continuidade Sentinel.** `58fc91fb` consolidava 18 commits do Gemini sobre `76a27296`. A Sentinel avançou linearmente e acrescentou D-747. O Gemini registrou 397 E2E e 1.160 testes de integração em sua base. Nesta retomada passaram 85 testes selecionados de ERP/NF-e, check e build. A correção de NF-e amplia a evidência de B02 com o mesmo peso. [Checkpoint](SESSION_LOG.md)
- **Integração restante.** A simulação de merge entre `f2eb787c` e `58fc91fb` encontrou conflitos em `docs/DECISIONS.md`, `docs/DECISIONS_INDEX.md` e `docs/HANDOFF.md`. Há colisão D-720 a D-725 com compras. O #331 segue aberto e mantém suas duas migrations separadas da faixa documentada na VM. As evidências anteriores nesta página ficam como histórico da auditoria de 18/11. [PR #331](https://github.com/PabloCoder1/speedbikers-gestao-v2/pull/331)
- **Leitura de NF-e e ERP.** D-748/D-749 protegem o início dos parsers contra mudanças de estado ou versão. D-750 cobre A104 na NF-e, com gravação em uma transação e falhas vinculadas à versão. A105 registra a lacuna restante no ERP. B02 acumula evidência dentro dos 134 pontos registrados. [Checkpoint](SESSION_LOG.md)

O diagnóstico inicial usa a base 010c252d. Foi atualizado com A87/D-729 e A88/D-730: transporte e recusa do banco nas quatro confirmações da Central. F04 mantém os mesmos dois pontos; não houve aumento de progresso por esta extensão da cobertura. Os estados remotos permanecem como observados na auditoria, não como nova verificação de disponibilidade.

A89/D-731 acrescenta a confirmação real de papel/revogação em Usuários, com cinco regressões e treze contratos. A evidência de F03 foi ampliada sem novos pontos ou mudança de status. Em continuidade no checkpoint Gemini (`D-732` a `D-746`), foram corrigidas Notificações/Preferências, Sugestões/Atendimento, erros transitórios de conta ML em 10 handlers + `ml-token`, `relist-prepare` atômico, Copiloto API (`replenishment_settings`, SAC recente, papel e teto SSE), uploads/convites/rotas HTTP e corrida/rollback no apply ERP/NF-e, handlers de parse/apply ERP+NF-e no worker, paginação `>1.000` + memoização no worker e em `/diagnostico`, recuperação de transporte/sessão/JSON/SSE nos componentes cliente web restantes, além de Next.js `16.4.6` (suíte completa em `048b9774`: `37/37` no check, `1.160` integração, `397/397` E2E). O fechamento segue em `129/226 = 57,1%` (`22/43` entregas), preservando os estados remotos sem publicação. Compras/reposição e pedidos de importação realizados continuam na frente do Claude, fora destas alterações.

## A. Estado confirmado e limites

- Worktree Sentinel: `C:/Users/usuario/.codex/worktrees/sentinel-speedbikers-20261111`; branch `codex/sentinel-audit`, base desta etapa `010c252d`, limpa antes da auditoria.
- Pasta original: branch `v3`, HEAD `9642d921`, alterações de outras frentes preservadas. A `main` **remota** atual é V3; a referência V2 é `v2-final`. Não usar a `main` local antiga como base.
- `origin/main=d6169205`; `origin/codex/sentinel-audit=60784059`. Sentinel local: 9 commits adiante da remota, zero atrás; 98 adiante da main remota.
- 24 refs remotas, 31 worktrees registradas e 17 PRs abertos. Presença de worktree não prova agente ativo; nenhuma foi removida.
- PR #328 tem checks remotos verdes de check/build, integração, E2E e scripts. Migrations Dev/preview Supabase puladas. **Não cobre os nove commits locais nem #330/#331**.
- GitHub consultado em 18/11: `main.protected=false`, proteção desabilitada, sem required checks e lista de rulesets vazia. CI verde não é check obrigatório. A07 permanece aberto; alteração depende do responsável pelo repositório.
- PR #330, `feat/compras-reposicao-inteligente`, HEAD observado `d451cfd9`, propõe compras, recebimento, importação, margem e análise. Está separado; o diff direto contra a Sentinel mais nova inclui diferenças de ancestralidade, não prova exclusões intencionais.
- PR #331, `sentinel/custo-do-banco`, HEAD observado `db695e82`, contém a frente de banco e infraestrutura self-hosted. Seu `supabase/config.toml` local e o de compras estão alterados para stacks próprias: preservar.
- D-720/D-721 da frente de banco e D-720–D-725 de compras colidem com decisões Sentinel. Resolver numeração, contratos e ancestralidade antes de integrar.
- Vercel: alias `speedbikers-prod.vercel.app`, deployment `dpl_6zpmnqQQ1ibHguhxkq2Snfq24zv7`, READY, SHA `d6169205`. Login HTTP 200; CSP aponta HTTPS/WSS para a VM.
- API: `api-00039-22b`, 100% tráfego; worker: `worker-00058-mbc`, 100%. Ready. `GET /health` da API: 200, commit `dc69d1fb`. Health prova processo, não banco ou sucesso de jobs.
- VM `sb-db`: RUNNING, `southamerica-east1-b`, e2-standard-2, disco pd-balanced 50 GB, proteção contra exclusão, IP interno `10.20.1.2`, externo reservado. Endereço provisório `https://34-39-221-164.sslip.io`.
- Supabase hospedado Dev `nmgccyqquwxecqffsidr` e produção `imvjfgnaprqsfjlnsyev`: MCP lista INACTIVE; consulta leve não acessa banco. Esses projetos não representam mais o backend atual da produção.
- Dev GCP conhecido: `speedbikers-gestao-v3`. Consulta atual negada (`CONSUMER_INVALID/PERMISSION_DENIED`); não distinguir projeto ausente de falta de acesso. Pausa de 15 jobs/7 filas e revisões antigas são histórico, não inventário confirmado hoje. Uma primeira consulta ao nome incorreto `speedbikers-dev` também falhou e não é evidência sobre o Dev correto.
- Billing API retornou 429 de quota. Não repetir em laço; faturamento habilitado, saldo e custo realizado **não foram comprovados** por esta consulta.
- SSH por IAP não executou SQL: cliente inicial usou flags incompatíveis com plink; em batch a chave do host ainda não estava confiada. Não desativamos a verificação de identidade do host. Contagens, migrations, cron e job_runs da VM continuam como evidência da outra frente, não nova medição desta sessão.
- `/auth/v1/health` sem apikey retornou 401 no gateway. Não usar essa recusa esperada para declarar Auth indisponível nem saudável.

### Migrations candidatas

A Sentinel tem 12 arquivos adicionais à main: `20261111175813`, `20261111175814`, `20261112120939`, `20261112122618`, `20261112124430`, `20261112181422`, `20261112182921`, `20261112184110`, `20261113131644`, `20261116164846`, `20261117171808`, `20261117173152`. Cobrem OAuth, fencing SAC, escopo/saúde de jobs, cobertura Shopee, IDs de compra, SKUs Full e anúncios por conta/canal.

Compras acrescenta três: `20261117100000_margem_por_sku.sql`, `20261117110000_compras_revisao_recebimento_importacao.sql`, `20261117120000_analise_de_compra.sql`. Banco acrescenta `20261117182500_full_snapshot_unique_in_distinct_order.sql` e `20261117182600_job_runs_retention.sql`.

São **17 candidatas**, não 17 comprovadamente ausentes no catálogo real. Conferir versões, nomes/timestamps registrados pelo procedimento Dev, dependências e testes no conjunto antes de aplicar. A outra frente registra 305 migrations da main restauradas até `20261022170000`. Último workflow hospedado com sucesso observado: `39665807654`; execução `39817649217` falhou na guarda. Nenhum desses registros substitui o catálogo da VM.

## B. O que existe e o que falta publicar

O [mapa do projeto](PROJECT_MAP.md), o [mapa API/jobs](API_AND_JOBS_MAP.md), o [mapa do banco](DATABASE_MAP.md), os [achados](FINDINGS.md), o [plano](PLAN.md) e o [checkpoint](SESSION_LOG.md) preservam a auditoria anterior; não a reiniciamos.

| Conjunto | Evidência e estágio | Limite atual |
|---|---|---|
| Estoque, ledger, pedidos, NF-e, compras, fornecedores, produtos e vinculação | ROADMAP fases 4–7, migrations e consumidores na main | Nova operação após restauração precisa de reconciliação externa com ERP |
| ML: pedidos, catálogo, financeiro, Full, Ads e SAC | Handlers e contratos na main; API/worker executam SHA conhecido | Backlog desde 22/10 e 403 de itens registrados pela frente de banco |
| Shopee: pedidos, catálogo, financeiro, Ads, repasse, devoluções e telas | D-425–D-632, contratos multicanal | Estoque/Go Live requer conferência real; não declarar integração inteira fechada |
| TikTok Shop | OAuth/conexão e proteções preparados | Atos do dono e fatias transacionais 2–8 continuam abertas |
| Segurança/dependências | Next, Zod, Hono e XML no lockfile; testes e auditoria registrados | Correções Sentinel ainda não publicadas |
| OAuth concorrente | RPCs atômicas, identidade de trava, proteção de renovação ML/Shopee/TikTok | Migrations e deploy conjunto pendentes |
| SAC | Fencing de envio, idempotência, recuperação e estados locais, D-658–D-684 | Validar revisão publicada e recuperação sem repetir envio incerto |
| SQL/performance | Saúde agregada, cobertura limitada por timestamp, consultas paralelas e paginação | Ganhos locais não são benchmark da nova VM |
| UX/transportes | D-685–D-729; nove commits locais anteriores mais esta etapa; 43 E2E relacionados passaram | As quatro confirmações foram corrigidas/testadas localmente; não publicadas |
| Limpeza | 106 exclusões verificadas; três helpers e 32 exports desnecessários retirados | 24 refs preservadas; 17 PRs e worktrees requerem nova classificação |
| Compras e banco recentes | PRs #330 e #331, código e migrations inspecionados | Testes relatados por outro agente ainda precisam de revisão integrada |

Os nove commits locais são `e6cff19a`, `7a5528fb`, `9747f146`, `80e16dbf`, `1c4e7daa`, `2db2f2b5`, `367c4e40`, `ad903d41` e `010c252d`. O último conserva preenchimento da Central após falha/recusa; não mudou fórmulas ou schema.

### Rechecagem de dependências em 18/11

Em `76a27296`, `pnpm audit --audit-level=high` retornou código 1: três moderados (`uuid` e dois avisos Next.js) e um alto em `picomatch` ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), já retirado pelo GitHub em 18/11; o [mantenedor](https://github.com/micromatch/picomatch/pull/235) discordou da classificação e `pnpm why` mostrou `picomatch` apenas em Vitest/Vite).

No commit `8af66328` (`D-737`), o Next.js foi atualizado de `16.4.1` para `16.4.6`, eliminando [GHSA-mfr8-8qww-v76h](https://github.com/advisories/GHSA-mfr8-8qww-v76h) e [GHSA-vc7v-qv4w-wrv8](https://github.com/advisories/GHSA-vc7v-qv4w-wrv8). Após a atualização, `pnpm audit --prod --audit-level high` encerrou com código 0, restando apenas 1 aviso moderado transitivo em `uuid <11.1.1` (via `gaxios`/`exceljs`). A classificação continua usando o critério da skill `security-review` e aguarda publicação para ter efeito no ambiente remoto.



## C. Google Cloud: inventário e evolução

A arquitetura V3 já separava web/Vercel, API/worker Cloud Run, filas Tasks, Scheduler, GCS e Supabase. O IP fixo/NAT entrou para a whitelist Shopee em outubro (D-457). Em 18/11, a outra frente executou o corte para Supabase self-hosted. **A concentração no GCP aumentou com banco/Auth na VM**, além da dependência de execução que já existia. Não atribuir todo o desenho atual a uma mudança recente.

Inventário vivo abaixo é do projeto `speedbikers-prod`. No Dev, existência/uso/custo atual não foram acessíveis; referências em scripts indicam desenho, não presença real.

| Serviço e uso | Evidência atual/configuração | Efeito da falha e alternativa | Custo/ação recomendada |
|---|---|---|---|
| Cloud Run API | Ready; 1 CPU/512Mi; mínimo 1, máximo 10; SA própria; egress all-traffic | Webhooks, OAuth e comandos privilegiados param; leitura direta pode funcionar se Auth/DB e Vercel estiverem disponíveis | Preservar instância quente para ACK; medir latência/CPU/requests antes de redimensionar |
| Cloud Run worker | Ready; 1 CPU/512Mi; máximo 5; sem mínimo configurado; SA própria | Jobs deixam de consumir; Tasks retenta até limite; replay pode exigir reconciliação | Medir memória por importação e duração/concorrência; revisão antiga sem tráfego/mínimo não equivale a instância faturada |
| Cloud Tasks | 7 RUNNING: analytics-recompute, backfill, maintenance e 4 ml-sync por conta | Ingestão, SAC e importações assíncronas param; tarefas esgotadas não têm recuperação automática infinita | 3–10 tentativas por fila; backfill conc2, maintenance1, analytics20, ML10 por fila. Worker máximo5 × concorrência4 limita capacidade conjunta; medir atraso e 429, não aumentar cota por palpite |
| Cloud Scheduler | 18 ENABLED; 8 últimos status code14 | Sem reconciliação, manutenção e atualizações periódicas; webhooks existentes continuam apenas onde há produtor ativo | Status antigo pode anteceder corte. Confirmar próxima execução e efeito no DB; não disparar manualmente jobs de escrita nesta auditoria |
| Cloud Storage | 5 buckets: raw-ml, erp-imports, documents, db-backups, cloudbuild | Importação/NF-e e leitura de bruto dependem de objetos; DB já materializado pode continuar | Medir bytes por prefixo e lifecycle; documentos fiscais não são lixo. Bucket Cloud Build não foi provado abandonado |
| Compute Engine / disco | Uma VM e2-standard-2, 50GB pd-balanced; sem segunda instância/replicação observada | Banco/Auth/gateway/storage/realtime da pilha ficam indisponíveis; não há failover automático demonstrado | Principal novo custo fixo; medir RAM/IO/CPU por 7 dias antes de reduzir. Proteção contra exclusão não é HA |
| Backups/snapshots | Bucket com uniform access, public access prevention, versionamento e lifecycle35dias em diario/. Política sb-db-diario anexada ao disco:07UTC,7dias | Perda da VM exige restore; dump na mesma VM não protege desastre | Snapshot list vazio e diario/ vazio no corte; primeira execução ainda por ocorrer. Conferir dump completo, restore em pilha limpa e alertas; versionamento precisa lifecycle de versões não correntes |
| Cloud Build / Artifact Registry | Últimos builds de 22/10 SUCCESS; 1 repositório Docker,1.332.242.344bytes; sem cleanupPolicy retornada | Builds/deploys novos param; serviços já em execução podem continuar | Definir retenção com janela de rollback; 1,33GB é oportunidade pequena diante da VM |
| Secret Manager | Consumido por SAs API/worker; selfhost-supabase-env documentado pela outra frente | Nova revisão/boot e integrações podem falhar; processos com segredo já carregado podem continuar | Nunca acessar payload em relatório; revisar concessão por segredo e política de rotação, evitar ambiguidades de latest |
| Cloud Logging | _Default30dias, _Required400dias; NAT registra ERRORS_ONLY | Diagnóstico e investigação perdem visibilidade; tráfego não depende do log | Medir volume e excluir ruído comprovado; não cortar trilha de segurança/negócio |
| Cloud NAT / rede / IP fixo | v3-nat,IP34.95.145.35 IN_USE; Run em v3-vpc/v3-run-egress,all-traffic; VM em10.20.1.2 | Saída para ML/Shopee e outros destinos públicos falha; IP trocado pode invalidar whitelist | IP NAT não é recurso abandonado. Medir bytes e esgotamento de portas; não desligar para economizar |
| Firewall / HTTPS | VM:80/tcp,443/tcp/udp públicos;22 só IAP35.235.240.0/20;8000 só10.20.0.0/24; sem5432 público nessas regras | Regra incorreta quebra gateway ou expõe serviço | Gateway público é necessário à web/RLS. Confirmar Caddy só publica rotas necessárias e Studio bloqueado; domínio sslip.io é dependência adicional |
| IAM / service accounts | API/worker dedicadas; VM sb-db-vm com logWriter/metricWriter no projeto; SA padrão Compute ainda Editor | Erro/revogação impede tarefas, segredos ou backups; credencial excessiva amplia dano | Investigar consumidores do Editor e permissões em recursos antes de remover. Ausência no IAM do projeto não implica ausência de concessões por recurso |
| Monitoring | 0 uptimeCheckConfigs e0 alertPolicies na API consultada | Falha silenciosa até alguém abrir app; mesmos credenciais/projeto são falha comum | Canal externo e alertas de banco/disco/backup/idade de sync; vigia no próprio DB não detecta morte do DB |
| APIs habilitadas | Run/Tasks/Scheduler/Build/Compute/Storage/IAM/IAP/Secrets/Logging/Monitoring e APIs de BigQuery/Dataform/Dataplex/PubSub/Datastore/SQL-component, entre outras | Dependência só existe se houver consumidor | Habilitação não prova recurso nem custo. Não há evidência suficiente para desativar APIs analíticas ou atribuir custo de Cloud SQL |

### Fluxos conferidos no código

| Fluxo | Caminho principal e recuperação |
|---|---|
| Mercado Livre | ML → webhook API (allowlist) → fila ML por conta → worker → PostgREST/DB → web direta sob RLS. Reconciliação por Scheduler complementa eventos; janela missed_feeds limitada, não prometer recuperar semanas só por webhook |
| Shopee | Push HMAC → API → backfill → worker → DB; Scheduler horário também lê pedidos/catálogo; jobs encadeiam financeiro, devoluções, Ads e repasse. Saída usa NAT/IP autorizado |
| TikTok | Web → API connect → OAuth externo → callback → RPC atômica de credencial. Não há evidência de fluxo completo pedidos→estoque→faturamento |
| Estoque | Pedidos/NF-e/ERP → jobs/RPCs → ledger idempotente → inventory_balances → web; ajuste manual autorizado usa ação/RPC. Full é retrato separado. Conciliação diária ajusta alvo do ERP somado aos movimentos posteriores |
| UpSeller / NF-e | Web/API → URL/upload GCS → parse/apply em worker → lotes/documentos/ledger → web. Remover bucket ou fila interrompe importação |
| Pedidos e faturamento | Ingestão worker e complementação financeira → tabelas e agregações SQL → web sob RLS. Web não precisa chamar worker para toda leitura; dado antigo acessível não significa faturamento atualizado |
| Reposição e compras | Web → RPC de demanda/cobertura/estoque → recomendação → ações/RPC de pedido; recebimento escreve ledger. Nova análise de compras está em PR330; Neon compras contém modelo separado, sem prova de integração completa com V3 |
| SAC | ML → API/filas/reconciliação → projeções support → web; envio web→API→task→worker→ML com trava/fencing. Resposta perdida é ambígua: não repetir automaticamente |
| Notificações | Eventos/diagnósticos → SQL/projeções de destinatário → web/RLS e Realtime quando configurado; preferências e leitura também usam ações diretas |
| Métricas/relatórios | Jobs/dirty keys → agregações SQL e tabelas diárias → RPCs → web. Não há agregação de negócio em JS nem BigQuery comprovado nesse caminho |
| Agendados | Scheduler OIDC→API→Tasks→worker→DB; cron vigia no DB é mecanismo separado. API200/Schedulerverde não prova job materializado |

Não apareceu dependência circular de implantação nos fluxos inspecionados. Há ciclo de operação normal evento→job→evento e jobs encadeados; idempotência e limites precisam continuar protegendo esses ciclos. Isso não constitui prova exaustiva de ausência de ciclos.

### Falhas, concentração e recuperação

- **Run indisponível:** ingestão e comandos privilegiados param; Vercel pode servir dados existentes via banco/Auth. **Tasks indisponível:** produtores podem receber falha de enqueue; não assumir ACK durável sem rastrear log e reconciliação. **Scheduler parado:** perdem-se varreduras, enriquecimento e manutenção; dados ficam antigos.
- **VM indisponível:** Auth, REST, DB e serviços locais da pilha param juntos. **Falha geral de projeto/faturamento GCP:** também ameaça banco e backups no mesmo projeto. Backups locais ou outro bucket no mesmo projeto não são independência de provedor.
- **Vercel indisponível:** UI para; worker e webhooks podem continuar. **Marketplace/OAuth indisponível:** impacto no canal, dados existentes continuam legíveis se infraestrutura saudável. **Supabase hospedado pausado:** hoje afeta Dev/recuperação e não prova queda da VM.
- Reconciliação, chaves idempotentes, ledger, tasks com retry e checkpoints já existem; não demonstram restauração de um mês de atraso. Provar pedidos perdidos, diferenças de saldo, faturamento, tentativas SAC incertas e credenciais atuais.
- Melhorar primeiro monitoramento independente, restauração ensaiada e caminho de replay limitado. Não adicionar outro provedor/cluster apenas para criar redundância nominal.

### Custos: valores são cenários, não fatura

A consulta de billing falhou com quota429; não há total mensal/consumo de novembro confirmado. A revisão mais recente da frente de banco (MIGRATION_PLAN §3.8) estima US$ 90–105/mês: VM São Paulo US$ 77,65, disco ~US$ 7,50 e IP/snapshots ~US$ 5–10. É estimativa do catálogo/configuração, não consumo faturado; substitui as faixas preliminares menores. Reconciliar com SKUs regionais e manter separados compute, disco, IPv4, backup, egress e operação humana.

Preços consultados em 18/11: [Cloud Run](https://cloud.google.com/run/pricing), [Scheduler](https://cloud.google.com/scheduler/pricing), [NAT](https://cloud.google.com/nat/pricing), [Compute](https://cloud.google.com/compute/vm-instance-pricing).
Scheduler: US$ 0,10/job-mês;18 jobs≈US$ 1,80 antes da franquia de3jobs por conta de billing (atéUS$ 1,50 se disponível). NAT: IPv4US$ 0,005/h≈US$ 3,65/730h, processamentoUS$ 0,045/GiB, mais gateway e egress. Não transportar a estimativa antiga deUS$8 como fatura. Run mínimo1 é custo/latência deliberado, worker pode escalar a zero. Filas vazias e revisões antigas não são automaticamente custos fixos.

Prioridade de economia: (1) relatório de billing por SKU/serviço/projeto e janela de 7 dias; (2) RAM/IO/CPU e carga real da VM; (3) retenções R1–R5 com semântica preservada; (4) logs ruidosos, imagens sem referência de rollback, versões antigas de backup; (5) cadências só após medir benefício/cota/latência. Não desligar Dev ou recursos candidatos sem mapear usuários e recuperação.

## D. Supabase, Neon e alternativas

Medição física existente da frente de banco: backup de 22/10 restaurado em PG17.6 isolado, **1092 MB**, sem bloat; aproximadamente520 MB de negócio,440 MB telemetria e114 MB derivado. É base histórica mínima, não tamanho atual da VM. Simulação R1–R5:1092→979MB; crescimento previsto420→110–150MB/mês depende de políticas e ainda não foi medido em produção.

Neon: organização Neurix, Launch. Projeto pertinente `lively-feather-93434224`, branch `br-twilight-sun-b6rs53s4`, PG18/sa-east-1. Consulta readonly no banco `compras`:8110080bytes,7tabelas (canais, contas_integracao, marcas, pedidos_compra, pedidos_compra_itens, skus, vendas_diarias). Não copiar nem divulgar dados. Endpoint observado idle, tamanho1 CU fixo; isso não prova730 horas de uso nem ausência de custo. A consulta pode acordá-lo; medir CU-h faturadas. Outros projetos Neon não fazem parte deste inventário.

| Opção | Custo e capacidade | Compatibilidade/risco | Parecer |
|---|---|---|---|
| A: Free otimizado | 500 MB DB,500 MB RAM; US$ 0,franquias e pausa por inatividade | PostgreSQL/RLS/RPC/Auth/Storage/Realtime familiares, mas tamanho mínimo atual já excede cota; sem backup automático incluído | Não cabe com evidência disponível; não excluir negócio para caber |
| B: Free + histórico/analytics Neon | Free + compute/storage/transfer Neon | Duplica acesso, autorização, sincronização, restore e consistência; tirar telemetria não prova núcleo menor que500 MB; queries entre bases exigem projeto próprio | Não recomendado agora; só com recorte mensurado e economia total demonstrada |
| C: principal Neon Launch | US$ 0,106/CU-h +US$ 0,35/GB-mês;730h:0,25CU≈US$ 19,35;0,5≈38,69;1≈77,38, antes de storage/egress | PostgreSQL/RPCs podem portar; PostgREST, auth.uid/JWT, RLS, identidades, roles, extensões, Storage, Realtime e clientes exigem compatibilidade testada. Neon já oferece Auth/Storage/Functions/Realtime; existência do produto não é equivalência automática | Prova em branch isolada, sem segundo corte apressado; estimativa histórica3–6semanas não é compromisso |
| D: Supabase Pro gerenciado | A partirUS$ 25/mês,8GB e crédito decompute que cobre1Micro; segundo compute/extras cobrados | Menor reengenharia e operação; sem garantia de resolver pendência de pagamento ou restaurar estado mais novo | Comparador de custo total mais simples, condicionado a acesso/regularização e restauração testada |
| E: self-hosted já escolhido | VM+disco+IPv4+backups+egress+manutenção; preço real por medir | Preserva componentes Supabase, mas dono assume upgrade, TLS, SMTP, backup, incidentes e HA; VM única/sslip.io são dependências | Estabilizar corte existente antes de decidir outra migração; não vender como opção mais barata |

[Supabase Pricing](https://supabase.com/pricing) · [Neon Pricing](https://neon.com/pricing). Preços USD, sem impostos, câmbio, créditos contratuais ou extrapolação para fatura.

Otimizações: R5 reorganiza índice único Full no DISTINCT ON; R3 expurga job_runs com guarda explícita. Estão em PR331. R1 compactação de snapshots, R2 retenção de notificações e R4 sync_runs exigem política/consumidores e preservação de auditoria. Application credentials usam AES-GCM/Secret Manager segundo código e correção da outra frente; não fundamentar migração na alegação antiga de dependência obrigatória do Vault.

## E. Escopo, cálculo e confiança

100% significa: funcionalidades V3 assumidas abaixo entregues, defeitos conhecidos importantes corrigidos, infraestrutura recuperável, testes exigidos passados, conjunto publicado por fluxo autorizado e critérios de negócio validados. Manutenção indefinida não entra.

Recontagem de todas as linhas markdown `- [x/~ / ]` do ROADMAP:300 itens,261 marcados,7 parciais,32 abertos (87% marcado). Esse total não é escopo limpo: há agregados (linha626), duplicatas (recebimento parcial e vendas perdidas), itens publicados ainda marcados parciais e futuros explícitos. Não usar190/213nem261/300 como conclusão atual.

D-223 já exclui do bloqueio V3: recebimento parcial antigo como evolução, estimativa de venda perdida sem dado, XML próprio/DANFE sem fonte, pesquisa de eventos adicionais e Terraform. Afiliados/atribuição Ads futura também não bloqueiam este corte. Não são cancelados; continuam no ROADMAP, fora do inventário de fechamento. O novo escopo de compras já pedido no PR330 entra emF05; não remover esse trabalho sob rótulo de futuro. TikTok2–8 permaneceM04até decisão explícita do dono de diferir. Nenhuma tarefa bloqueada foi retirada do denominador.

Inventário agrupado de43 entregas em [CLOSURE_INVENTORY.json](CLOSURE_INVENTORY.json): cada entrega aparece uma vez. Agrupamentos representam fronteiras de aceite, não todas as centenas de subitens. Pesos:2: rotina curta,3: médio,5: alto,8: núcleo complexo/crítico. Responsáveis são frentes propostas, não novos agentes criados.

Aceite técnico do inventário = status **Testado localmente**, **Publicado** ou **Validado em produção**, com evidência indicada. Publicado significa código/configuração acessível ou SHA implantado; não significa função revalidada após restauração. Critérios de implantação conjunta e aceite operacional ficam separados emV01–V03/Q04/S04/M05, sem contar de novo a implementação. Implementado, Em andamento, Não iniciado e Bloqueado valem zero. Não há percentual parcial arbitrário.

<!-- closure-table:start -->
| Área | Pontos fechados/previstos | Concluído | Falta | Entregas fechadas/previstas |
|---|---:|---:|---:|---:|
| Frontend e telas | 25/25 | 100.0% | 0.0% | 5/5 |
| Backend e APIs | 21/21 | 100.0% | 0.0% | 3/3 |
| Integrações dos marketplaces | 16/34 | 47.1% | 52.9% | 2/5 |
| Banco de dados | 15/21 | 71.4% | 28.6% | 3/5 |
| Google Cloud e infraestrutura | 13/29 | 44.8% | 55.2% | 2/6 |
| Segurança e autenticação | 18/26 | 69.2% | 30.8% | 3/5 |
| Performance | 8/16 | 50.0% | 50.0% | 1/3 |
| Testes e qualidade | 13/23 | 56.5% | 43.5% | 2/4 |
| Limpeza técnica | 5/10 | 50.0% | 50.0% | 2/4 |
| Publicação e validação | 0/21 | 0.0% | 100.0% | 0/3 |
<!-- closure-table:end -->

**Geral em 19/11: 134/226 = 59,3%, com 40,7% restante. Por contagem simples, 23/43 = 53,5%.** O avanço de 5 pontos sobre os 129 anteriores vem de F05 publicada. Cálculo reproduzível em `node scripts/report-closure-progress.mjs`.

Confiança média no aceite técnico e baixa no aceite operacional completo. A revisão e os testes de D03 ainda podem acrescentar 3 pontos, chegando a 60,6%. As portas de publicação e validação continuam abertas para o conjunto final.

Backend100% mede implementação dos três pacotes definidos, não ausência de bugs ou disponibilidade. Publicação/validação0% mede os três gates ainda abertos. Funcionalidades incompletas, backlog e recuperação impedem declarar uso diário seguro após simples deploy. A proximidade funcional não elimina o trabalho de operação.

## F. Plano executável

| Fase | Avanço técnico inicial | Ordem, dependência e risco | Critério de encerramento | Agora / autorização |
|---|---:|---|---|---|
|1 — Críticos|15/30=50%|Auth/SMTP e acesso real; atrasos/403ML; estoqueERP/Shopee; correções segurança/OAuth/SAC já locais. Risco:duplicação, credencial antiga, saldo incorreto|Login/convite/reset; pedidos e financeiro reconciliados por janela; ledger sem divergência; envioSAC único e incertos conferidos; patches aprovados publicados|Auditar/testar local agora; dono validaERP/login; escrita de recuperação/migrations/deploy exige autorização|
|2 — Infraestrutura|15/34=44,1%|Dependente do corteVM:primeiro backup e restoreisolado, alertas externos, pipelineVM, IAMEditor, custos/limites. Risco:perda daVM e falha comum de projeto|Restore completo comRPO/RTO medidos, backup recorrente observado, alertas exercitados, migração/rollback ensaiados, custo porSKU|Preparar scripts/testes/planos agora; recursos pagos, IAM/produção/canais e alterações reais dependem do dono|
|3 — Técnica|86/108 = 79,6%|Compras publicada. Revisar Sentinel, #331, retenção e benchmarks na VM|Regressões aprovadas, decisões únicas, migrations comparadas e desempenho medido|Testes locais e revisão de integração. Política de retenção depende do responsável|
|4 — Limpeza|5/10=50%|17PRs/31worktrees/24refs; nuvem com consumidores e rollback. Risco:apagar trabalho de outroagente ou janela de recuperação|Cada candidato com proprietário, consumidor, evidência e tratamento; recursos ativos preservados|Inventariar/remover código comprovadamente morto local; excluirprojetos/recursos produtivos não autorizado|
|5 — Validação|13/44=29,5%|Após 1–3:CI exata, integração/RLS/E2E,carga/recuperação, deployworker→API→web apósmigrations, aceiteobservado. Risco:falsoverde com dados antigos|SHAfinal emtodosserviços, catálogoalvo, pedidos/estoque/faturamento/SAC/importaçãoconsistentes, limites de erro/atraso e janelaobservação acordados|Ensaiarlocal agora; merge/main,migrationsprod,deploy e aceite real com dono|

Operação estável exige monitoramento externo, backups restauráveis e rotina de recuperação/reconciliação. Não inflar progresso por commit/arquivo. Atualizar uma linha só quando o critério tiver evidência. Registrar histórico no SESSION_LOG e manter HANDOFF curto.

## Inventário de entregas no corte

| ID | Área / entrega | Responsável | Peso | Status | Evidência | Fase |
|---|---|---|---:|---|---|---:|
| F01 | Frontend e telas: Telas operacionais ML, estoque, pedidos, NF-e e fornecedores | A2/A3 | 8 | Publicado | ROADMAP fases 4–7; main d6169205 | 3 |
| F02 | Frontend e telas: Central, multicanal e navegação sem perder recorte | Sentinel/A3 | 5 | Testado localmente | D-517–632; D-685–717, specs e SESSION_LOG | 3 |
| F03 | Frontend e telas: Recuperação de falhas nos formulários e transições | Sentinel | 5 | Testado localmente | D-720–728, D-731/A89, D-732–733, D-740–741, D-745/A99; confirmação real, gavetas, OAuth/SAC/aplicação/SSE/convite protegidos (1.501 unit + 397/397 E2E) | 3 |
| F04 | Frontend e telas: Quatro operações da confirmação compartilhada | Sentinel | 2 | Testado localmente | D-729/A87 e D-730/A88: transporte e recusa sem linhas; banco/papéis conferidos e oito testes de contrato | 3 |
| F05 | Frontend e telas: Nova experiência de compras e reposição aprovada | Agente Compras | 5 | Publicado | #330 incorporado pelo #332. CI 44381338715 e alias READY em f2eb787c. Validação das planilhas reais pendente | 3 |
| B01 | Backend e APIs: API autenticada, contratos e limites de organização | Backend | 8 | Publicado | apps/api/src; main dc69d1fb na API | 3 |
| B02 | Backend e APIs: Worker idempotente, despacho e retentativas | Backend | 8 | Publicado | Worker em produção. D-746 a D-750 validados localmente | 3 |
| B03 | Backend e APIs: SAC: envio único, fencing e recuperação | Sentinel | 5 | Testado localmente | D-658–684; migrations 11175814; SESSION_LOG | 1 |
| M01 | Integrações dos marketplaces: ML: ingestão, pedidos, anúncios, SAC e reconciliação | Backend | 8 | Publicado | main; apps/worker handlers; validação pós-corte pendente | 3 |
| M02 | Integrações dos marketplaces: Shopee: pedidos, financeiro, catálogo, Ads e devoluções | Multicanal | 8 | Publicado | D-425–632; main | 3 |
| M03 | Integrações dos marketplaces: Estoque Shopee: corte e conferência com ERP | Dono/Backend | 5 | Bloqueado | ROADMAP 750,757; requer loja real e conferência | 1 |
| M04 | Integrações dos marketplaces: TikTok: OAuth preparado; integração transacional restante | Multicanal/Dono | 8 | Em andamento | ROADMAP 796–797; conexão sem pedidos/webhook completo | 3 |
| M05 | Integrações dos marketplaces: Recuperação do atraso e diagnóstico ML 403 | Backend | 5 | Em andamento | MIGRATION_PLAN §3.9; SQL/externo ainda por validar | 1 |
| D01 | Banco de dados: Schema, ledger, RLS e agregação SQL do núcleo | Database | 8 | Publicado | supabase/migrations até main; DATABASE | 3 |
| D02 | Banco de dados: Migrations Sentinel transacionais, segurança e consultas | Sentinel/Database | 5 | Testado localmente | 12 migrations em diff origin/main; integração registrada | 3 |
| D03 | Banco de dados: R3/R5: retenção de job_runs e índice Full | Database | 3 | Implementado | PR #331; duas migrations 17182500/17182600 | 3 |
| D04 | Banco de dados: R1/R2/R4: compactação e retenções com política aprovada | Database/Dono | 3 | Não iniciado | OPTIMIZATION_PLAN; não apagar negócio | 3 |
| D05 | Banco de dados: Inventário e medição física; comparação de provedores | Database/Sentinel | 2 | Testado localmente | SIZE_REPORT: dump 22/10 restaurado 1092 MB; preços oficiais | 2 |
| I01 | Google Cloud e infraestrutura: Run, Tasks, Scheduler e rede de produção provisionados | Infra | 8 | Publicado | Em 19/11, 18 agendamentos habilitados e dois com último código 14. Revisões Run mantidas | 2 |
| I02 | Google Cloud e infraestrutura: Cutover VM self-hosted e HTTPS | Database/Infra | 5 | Publicado | VM Running; CSP nova; API200; PR331 docs | 2 |
| I03 | Google Cloud e infraestrutura: Backup/restore recorrente com prova e alerta | Infra/Database | 5 | Em andamento | Restore isolado do #333 e snapshot automático READY. Dump diário e alerta pendentes | 2 |
| I04 | Google Cloud e infraestrutura: Monitoramento externo, disco e falha de backup | Infra/Dono | 3 | Não iniciado | Monitoring18/11:0uptimechecks e0alertPolicies | 2 |
| I05 | Google Cloud e infraestrutura: Pipeline de migrations para VM e rollback ensaiado | Infra/Database | 5 | Não iniciado | workflow ainda Supabase hospedado; README pendência6 | 2 |
| I06 | Google Cloud e infraestrutura: Custo real, retenção de artefatos e dimensionamento | Infra/Dono | 3 | Em andamento | Billing429; ArtifactRegistry1.33GB; consumo não medido | 2 |
| S01 | Segurança e autenticação: Auth/RLS e isolamento negativo implementados | Backend/Database | 8 | Publicado | DATABASE; integration tests; revalidação VM separada S04 | 3 |
| S02 | Segurança e autenticação: Dependências Next/Zod/Hono/XML e webhook Shopee | Sentinel | 5 | Testado localmente | lockfile, Next.js 16.4.6 (`D-737`, `audit --prod --audit-level high` = 0), testes, histórico Sentinel; não publicados | 1 |
| S03 | Segurança e autenticação: OAuth ML/Shopee/TikTok concorrente e credenciais protegidas | Sentinel | 5 | Testado localmente | migrations11175813,12120939,12122618,12124430 | 1 |
| S04 | Segurança e autenticação: Auth VM real: login, convites, recuperação, SMTP e política | Dono/Database | 5 | Bloqueado | Navegação autenticada registrada no #333. SMTP, convites e recuperação de senha pendentes | 1 |
| S05 | Segurança e autenticação: Revisão IAM e proteção efetiva de main | Infra/Dono | 3 | Em andamento | SA padrão Editor; main protected=false, sem checks obrigatórios ou rulesets em 18/11 | 2 |
| P01 | Performance: RPCs, paginação e consultas existentes otimizadas | Sentinel/Backend | 8 | Testado localmente | PERFORMANCE: baseline, SQL health/coverage, parallelreads A26–36, D-736/D-738/D-739/D-743/D-746 paginam >1.000 no worker, Copiloto e /diagnostico + lotes .in 200 | 3 |
| P02 | Performance: Benchmarks representativos após restauração | Performance | 5 | Não iniciado | Baseline antiga não mede VM atual; faturamento90d e frete frio | 3 |
| P03 | Performance: Reduzir crescimento Full/telemetria sem perder auditoria | Database | 3 | Em andamento | 1092→979MB apenas simulação; medir retenções | 3 |
| Q01 | Testes e qualidade: Suíte unitária, contratos, RLS e idempotência | Todos/Sentinel | 8 | Testado localmente | check 37/37 tarefas, 1.160 integração, 39 embeds em 048b9774 | 5 |
| Q02 | Testes e qualidade: Regressões de navegação, transporte e escrita real local | Sentinel | 5 | Testado localmente | Playwright E2E completo: 397/397 (chromium + loja-live) em 048b9774 | 5 |
| Q03 | Testes e qualidade: Carga e falhas representativas em stack equivalente | QA/Infra | 5 | Não iniciado | ROADMAP696; carga histórica não fecha ensaio | 5 |
| Q04 | Testes e qualidade: Ensaio completo negócio→dados após recuperação | Dono/QA | 5 | Bloqueado | Pedidos/estoque/faturamento/SAC e importação; requer ambiente recuperado | 5 |
| L01 | Limpeza técnica: Branches obsoletas verificadas e removidas | Sentinel | 3 | Testado localmente | BRANCH_AUDIT:106exclusões;24refs atuais | 4 |
| L02 | Limpeza técnica: Código sem consumidor e exports desnecessários | Sentinel | 2 | Testado localmente | A24/A25;3helpers e32exports; consumidores indiretos preservados | 4 |
| L03 | Limpeza técnica: PRs/worktrees remanescentes e colisões documentais | Sentinel/Outros | 3 | Em andamento | 17PRs;31worktrees; D720–725 duplicados PR330/331 | 4 |
| L04 | Limpeza técnica: Recursos de nuvem candidatos com dependência e rollback | Infra | 2 | Em andamento | Nenhuma exclusão autorizada; revisões não custam runtime sem tráfego/min | 4 |
| V01 | Publicação e validação: CI de compras, Gemini/Codex Sentinel e banco no conjunto final | Sentinel/QA | 5 | Não iniciado | #332 e Gemini testados em bases separadas. Falta integração com #331 e CI do conjunto | 5 |
| V02 | Publicação e validação: Migrations, worker, API e web no SHA aprovado | Dono/Infra | 8 | Bloqueado | #333 registra as 17 versões da main na VM. Workflow ainda no hosted. Publicação conjunta pendente | 5 |
| V03 | Publicação e validação: Aceite operacional e observação de estabilidade pós-deploy | Dono/QA | 8 | Não iniciado | janela e limites de erro/atraso acordar; não basta /health | 5 |

## Fontes e atualização

Infra consultada readonly em 18/11 por CLIgcloud, APIs Monitoring, HTTP público e MCPs Supabase/Neon/Vercel; Git/PRs por git/gh. Não lemos segredos. Base dos testes anteriores:SESSION_LOGe commits indicados. Medições/restauração/cutover da outra frente estão em `docs/database-migration/` e `infra/selfhost-db/` do PR331, não copiados nem considerados já integrados. Captura é temporal: reconsultar tráfego, alias e banco antes de deploy.
