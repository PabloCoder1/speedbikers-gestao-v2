# Roadmap V3

## Fase 0 — Fundação

- [x] Google Cloud V3 preparado
- [x] Supabase V3 Dev preparado
- [x] Branch `v3` criada a partir do último commit de referência da V2
- [x] Branch V3 limpa e documentação inicial criada
- [x] Consolidar requisitos iniciais do produto e UX
- [x] Criar Prompt Mestre final inicial
- [ ] Definir arquitetura detalhada de módulos e modelo de dados
- [ ] Definir contratos iniciais entre web, API e worker
- [ ] Definir estratégia detalhada de eventos/notificações e Copiloto
- [ ] Criar fundação técnica/monorepo
- [ ] Criar projeto Vercel V3 conectado à branch `v3`
- [ ] Conectar fundação técnica ao Supabase V3 Dev e Google Cloud sem criar domínio prematuramente

## Fase 1 — Fundação técnica

- [ ] Estrutura web/api/worker e packages compartilhados
- [ ] TypeScript, lint, testes e build
- [ ] ambientes e variáveis
- [ ] Auth/RBAC base
- [ ] observabilidade base

## Regra de progressão

Não iniciar features de domínio antes de concluir a arquitetura detalhada e registrar as decisões relevantes.

## Próximo passo imediato

Executar uma sessão de arquitetura orientada pelo `docs/PROMPT_MASTER.md`: ler toda a documentação, revisar a `main` apenas como referência e propor a arquitetura inicial definitiva, modelo de dados de alto nível e estrutura de monorepo.
