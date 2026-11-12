# Plano priorizado do Sentinel

| Prioridade | Tarefa | Critério de conclusão |
|---|---|---|
| P0 · depende do responsável | Restabelecer faturamento do GCP e acesso aos projetos Supabase necessários à operação | API `GET /health` responde com sucesso, Scheduler e Tasks voltam a ser observáveis, produção responde a consulta leve e `job_runs` confirma processamento recente. Conferir web, Auth e processamento em separado |
| P0 · pronto localmente | Atualizar Next.js e Zod | Auditoria alta, build e E2E selecionados aprovados. Publicação pelos fluxos existentes após revisão do responsável |
| P1 · pronto localmente | Restringir log do push Shopee | Regressão pelo endpoint demonstra 200, sem consulta ou enfileiramento para assinatura inválida, sem dados arbitrários no log |
| P1 · pronto localmente | Tornar vínculo OAuth de lojas Shopee/TikTok atômico e vinculado à organização | Concorrência, rollback, reconexão e papéis verificados. Publicar migration antes da API (D-657) |
| P1 · pronto localmente | Recuperar tentativa PENDING quando o enfileiramento falha | Mesmo ID retoma tentativa nova ainda sem início de envio. Verificados deduplicação, concorrência e POST único. Conciliação operacional para legado e desfecho incerto (D-658) |
| P1 · pronto localmente | Isolar regras de toast da Shopee por loja | Testes verificam lojas distintas, Mercado Livre e eventos sem conta. Publicar C-82 antes do build web |
| P1 · pronto localmente | Impedir resultado tardio de renovação de sobrescrever reconexão Shopee (A14, D-659) | Testes preservam o par, o status e a trava atuais. Migration deve preceder o worker |
| P1 · próxima correção local | Proteger reconexão Mercado Livre de refresh anterior (A15) | Reproduzida a sobrescrita do novo par. Cobrir também recusa definitiva tardia e tornar a troca de credenciais, invalidação da trava e atualização da conta consistentes |
| P1 · depende do responsável pelo GitHub | Exigir revisão e checks na `main` que publica a web | Configurar os checks de typecheck/lint/test/build, integração, E2E e scripts, e conferir as regras efetivas e uma tentativa de merge com check pendente |
| P2 · segunda triagem concluída | Classificar branches e artefatos com o [inventário](BRANCH_AUDIT.md) e as [evidências de uso](CLEANUP_CANDIDATES.md) | Seis aliases residuais pendentes. Dois registros órfãos de worktrees e três rotinas sem consumidores removidos localmente |
| P2 · depende de acesso | Medir consultas quentes e uso de estruturas com risco de descontinuação | Consultar catálogo e janela de estatísticas, inspecionar planos representativos em ambiente autorizado e confirmar consumidores indiretos e retenção |
| P2 · pronto localmente | Atualizar Hono, adaptador Node e parser XML | Auditoria passou. Testes locais cobrem o servidor HTTP e a leitura da NF-e |
| P2 · medido localmente | Medir chamadas ao Auth na navegação | Dois GETs por render completo nas três rotas medidas, com Auth simulado. Repetir o ensaio após o PR #312 |
| P3 · pronto localmente | Retirar casts temporários de Sugestões | Compilação e E2E de envio e triagem aprovados |

[Achados e evidências](FINDINGS.md) · [Checkpoint](SESSION_LOG.md)
