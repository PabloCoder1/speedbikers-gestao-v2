# Handoff V3

## Estado atual

- Branch: `v3`
- Referência V2: commit `8573d971a5cd427702575b52ed249c53588ec5ca` da `main`
- V3 reconstruída como branch limpa, sem código legado da aplicação.
- Supabase V3 Dev: criado em São Paulo e mantido sem tabelas de domínio.
- Google Cloud V3: fundação criada em São Paulo.
- `docs/PROMPT_MASTER.md`: criado e deve orientar qualquer nova sessão de desenvolvimento.
- `docs/PRODUCT_REQUIREMENTS.md`: inclui requisitos de estoque, compras, dashboards, filtros, Full, notificações em tempo real, Copiloto contextual, sugestões estruturadas de features, memória de decisões, busca universal e UX por progressive disclosure.

## Regra de início de sessão

Antes de alterar código, ler:

1. `README.md`
2. `AGENTS.md`
3. `docs/PROMPT_MASTER.md`
4. `docs/HANDOFF.md`
5. `docs/ROADMAP.md`
6. `docs/ARCHITECTURE.md`
7. `docs/PRODUCT_REQUIREMENTS.md`
8. `docs/AGENT_ROLES.md`
9. `docs/DECISIONS.md`, quando disponível

Depois verificar branch, `git status` e commits recentes.

## Próximo passo

Não escrever feature ainda.

A próxima sessão deve:

1. confirmar que a branch `v3` está limpa localmente;
2. ler a documentação completa;
3. revisar a `main` somente para extrair aprendizados arquiteturais/funcionais da V2;
4. propor arquitetura inicial definitiva da V3;
5. propor modelo de dados de alto nível;
6. definir limites entre `web`, `api` e `worker`;
7. definir estratégia inicial de eventos/notificações/Copiloto;
8. registrar decisões em documentação;
9. somente depois preparar a fundação técnica do projeto.

## Bloqueios atuais

Nenhum bloqueio conhecido de infraestrutura para iniciar a fase de arquitetura. O projeto Vercel V3 deve ser criado depois de existir uma fundação técnica mínima/branch pronta para deploy.
