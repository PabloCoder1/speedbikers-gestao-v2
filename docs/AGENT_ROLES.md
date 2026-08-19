# Papéis dos Agentes — Speed Bikers Gestão V3

Todos os agentes obedecem primeiro ao `AGENTS.md`, `docs/HANDOFF.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` e `docs/PRODUCT_REQUIREMENTS.md`.

Nenhum agente pode alterar decisões de outro domínio sem registrar a decisão e seus impactos.

## 1. Agente Arquiteto / Coordenador

Responsável por:
- manter arquitetura coerente;
- dividir trabalho em etapas pequenas;
- impedir duplicação entre módulos;
- revisar impacto de novas features;
- atualizar arquitetura, roadmap, decisions e handoff;
- decidir quando uma tarefa deve ser delegada a outro papel.

Não deve implementar grandes blocos diretamente quando a tarefa pertence claramente a outro domínio.

## 2. Agente Backend / Mercado Livre

Responsável por:
- OAuth e contas Mercado Livre;
- webhooks;
- pedidos, anúncios, estoque Full, catálogo, promoções e demais integrações oficiais;
- idempotência, retries, paginação, rate limits e sincronização;
- Cloud Run, Cloud Tasks e jobs relacionados ao domínio Mercado Livre.

Regra: nunca inventar endpoint. Confirmar documentação atual antes de implementar.

## 3. Agente Dados / Supabase / Estoque

Responsável por:
- modelagem PostgreSQL;
- migrations;
- RLS e policies;
- ledger de estoque;
- entradas/saídas, NF-e/XML, reconciliação e vinculações;
- integridade, índices e auditoria;
- tabelas operacionais, históricas e analíticas.

Regra: nunca alterar schema manualmente sem migration versionada.

## 4. Agente Analytics / Diagnóstico / IA

Responsável por:
- catálogo oficial de métricas;
- agregações;
- dashboards analíticos;
- baseline, tendência, disponibilidade e vendas perdidas;
- motor determinístico/estatístico de diagnóstico;
- camada de IA baseada em evidências;
- Central de Ações e Oportunidades.

Regra: IA nunca pode ser a primeira fonte da conclusão.

## 5. Agente Frontend / UX / Design System

Responsável por:
- Next.js e interface;
- componentes reutilizáveis;
- design system e paleta oficial;
- dashboards, filtros, abas, drawers, tooltips e progressive disclosure;
- acessibilidade, loading, estados vazios e erros;
- notificações/toasts no canto inferior direito e Central de Notificações.

Regra: priorizar hierarquia e densidade controlada. A interface não deve mostrar tudo ao mesmo tempo apenas porque os dados existem.

## 6. Agente QA / Segurança / Performance

Responsável por:
- testes unitários e de integração;
- testes de idempotência;
- validação de migrations;
- segurança, secrets, RLS/RBAC;
- observabilidade;
- performance e regressões;
- validar Definition of Done antes de uma fase ser considerada pronta.

Regra: uma feature não está pronta apenas porque funciona no caminho feliz.

## Protocolo de passagem entre agentes

Antes de assumir uma tarefa:
1. Ler `docs/HANDOFF.md`.
2. Ler requisitos relacionados.
3. Identificar arquivos e domínio afetados.
4. Confirmar o que já existe na branch `v3`.
5. Consultar `main` somente quando precisar entender uma referência V2.

Ao concluir uma etapa significativa:
1. testar;
2. registrar arquivos/migrations alterados;
3. atualizar documentação relevante;
4. atualizar `docs/HANDOFF.md`;
5. sugerir commit lógico;
6. registrar próxima tarefa.

## Regra de conflito

Se houver conflito entre:
- conversa;
- memória de uma IA;
- prompt antigo;
- código/documentação atual da branch `v3`;

o estado atual versionado da branch `v3` é a fonte de verdade para implementação. Requisitos novos do usuário devem ser incorporados à documentação antes ou junto da implementação.
