# Candidatos a limpeza

| Recurso | Evidência | Decisão nesta sessão |
|---|---|---|
| Casts em `apps/web/app/(app)/sugestoes/actions.ts` | `feature_suggestions` já está em `packages/db/src/types.ts`, com tipos de leitura e escrita. A página usa a tabela diretamente | Removidos os casts e o comentário que dizia que a tabela ainda estava ausente. E2E cobre envio e triagem |
| `get_shopee_repasse_daily` | Busca inicial encontra migrations, grants, documentação e testes de integração, com leitura de faturamento em outras RPCs | Investigar chamadas externas, rotinas SQL e estatísticas reais antes de planejar a retirada |
| `support_attachments` | Contrato de metadados do SAC, migration e teste. Cobertura de uso externo e retenção pendente | Preservar até confirmar a finalidade operacional e a retenção |
| `/cobertura` | Rota direta de compatibilidade no App Router. Acesso por URL pode sobreviver a mudanças na navegação | Preservar a rota e conferir tráfego/links antes de descontinuar |
| Exportações e autenticação | Route handlers App Router são pontos de entrada por URL. Download, logout e vitals têm consumidores fora da lista de páginas | Preservar |
| `.claude/launch.json` | Configura os processos `web-dev` e `web-build` para o ambiente de edição | Preservar. No snapshot não há agentes ou skills rastreados além da instrução principal |
| Relatórios de auditoria e skills no checkout `v3` | Arquivos preexistentes fora do snapshot da `main`, junto a mudanças locais em andamento | Preservar na origem. Comparar com o novo índice antes de consolidar |
| Dependências transitivas com avisos moderados | `pnpm why` encontra `uuid` por ExcelJS e pela cadeia Google Cloud Storage → `gaxios`. A cópia 10.x afetada de `minimatch` vem do lint. A cadeia da exportação Excel usa outras versões | As versões corrigidas indicadas cruzam a versão principal das cópias afetadas. Conferir atualização nos pais e testar exportação, GCS e lint antes de forçar resolução |
| Branches | [Inventário](BRANCH_AUDIT.md) registra integração, PRs, worktrees e evidências de deploy | Aplicar a classificação registrada |

A investigação de estruturas precisa de catálogo, dependências SQL, atividade real e retenção. O [mapa do banco](DATABASE_MAP.md) registra a cobertura de cada fonte.
