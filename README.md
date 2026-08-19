# Speed Bikers Gestão V3

Branch de reconstrução da V3.

A `main` preserva a V2 como referência histórica e funcional. Esta branch será reconstruída progressivamente com nova arquitetura, Supabase V3 Dev, Google Cloud e documentação orientada a agentes.

## Antes de qualquer desenvolvimento

Leia, nesta ordem:

1. `AGENTS.md`
2. `docs/PROMPT_MASTER.md`
3. `docs/HANDOFF.md`
4. `docs/ROADMAP.md`
5. `docs/ARCHITECTURE.md`
6. `docs/PRODUCT_REQUIREMENTS.md`
7. `docs/AGENT_ROLES.md`
8. `docs/DECISIONS.md`

Depois, a documentação especializada do assunto da tarefa:

| Documento | Assunto |
|---|---|
| `docs/DATABASE.md` | Modelo de dados, tabelas, constraints, índices, RLS, migrations |
| `docs/API.md` | Fronteiras entre web/api/worker, rotas, jobs, eventos, erros |
| `docs/METRICS.md` | Catálogo oficial de métricas (normativo) |
| `docs/MERCADO_LIVRE.md` | Integração e estratégia de sincronização |
| `docs/NOTIFICATIONS.md` | Eventos, severidade, agrupamento e tempo real |
| `docs/COPILOT.md` | Copiloto, ferramentas determinísticas e uso de IA |
| `docs/DEPLOYMENT.md` | Plataformas, ambientes, secrets, CI/CD |
| `docs/TESTING.md` | Camadas de teste e regras obrigatórias |

Cada assunto tem **um único dono documental**. Não duplicar regra entre documentos: `docs/ARCHITECTURE.md` é o mapa que decide e aponta; os documentos acima carregam a profundidade.

> Não implemente funcionalidades antes de executar o protocolo de início definido em `AGENTS.md` e `docs/PROMPT_MASTER.md`.

## Regra central

O repositório versionado é a memória oficial do projeto. A `main` serve apenas como referência V2; o desenvolvimento da nova versão acontece na branch `v3` e em branches de trabalho derivadas dela quando apropriado.
