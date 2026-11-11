# Plano priorizado do Sentinel

| Prioridade | Tarefa | Critério de conclusão |
|---|---|---|
| P0 · depende do responsável | Restabelecer faturamento do GCP e acesso aos projetos Supabase necessários à operação | API `GET /health` responde com sucesso, Scheduler e Tasks voltam a ser observáveis, produção responde a consulta leve e `job_runs` confirma processamento recente. Conferir web, Auth e processamento em separado |
| P0 · pronto localmente | Atualizar Next.js e Zod | Auditoria alta, build e E2E selecionados aprovados. Publicação pelos fluxos existentes após revisão do responsável |
| P1 · pronto localmente | Restringir log do push Shopee | Regressão pelo endpoint demonstra 200, sem consulta ou enfileiramento para assinatura inválida, sem dados arbitrários no log |
| P1 · próxima alteração de banco | Tornar vínculo OAuth de lojas Shopee/TikTok atômico e vinculado à organização | Exercitar dois callbacks concorrentes para a mesma loja, mesmo dono pode reconectar e org concorrente não altera dono nem credenciais. Testar lote Shopee e ordem de aplicação da migration |
| P1 · próxima alteração no SAC | Recuperar tentativa PENDING quando o enfileiramento falha | Injetar falha antes e depois de criar a tarefa, repetir o mesmo ID, observar uma entrega externa e transição terminal auditável |
| P1 · depende do responsável pelo GitHub | Exigir revisão e checks na `main` que publica a web | Configurar os checks de typecheck/lint/test/build, integração, E2E e scripts, e conferir as regras efetivas e uma tentativa de merge com check pendente |
| P2 · primeira etapa concluída | Classificar branches e artefatos com o [inventário](BRANCH_AUDIT.md) e as [evidências de uso](CLEANUP_CANDIDATES.md) | 12 branches removidas e verificadas. Seis aliases residuais pendentes. Validar qualquer remoção adicional pelo caminho normal |
| P2 · depende de acesso | Medir consultas quentes e uso de estruturas com risco de descontinuação | Consultar catálogo e janela de estatísticas, inspecionar planos representativos em ambiente autorizado e confirmar consumidores indiretos e retenção |
| P2 · pronto localmente | Atualizar Hono, adaptador Node e parser XML | Auditoria passou. Testes locais cobrem o servidor HTTP e a leitura da NF-e |
| P2 · investigar | Medir chamadas ao Auth na navegação | Contar requisições por carregamento no proxy e no Shell, com p50/p95 e teste de sessão inválida se houver alteração |
| P3 · pronto localmente | Retirar casts temporários de Sugestões | Compilação e E2E de envio e triagem aprovados |

[Achados e evidências](FINDINGS.md) · [Checkpoint](SESSION_LOG.md)
