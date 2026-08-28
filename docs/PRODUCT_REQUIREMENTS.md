# Requisitos de Produto — V3

Documento oficial de requisitos funcionais e UX da reconstrução V3.

## Requisitos já definidos

- Filtros por conta em Estoque e Produtos.
- Períodos de 7, 15, 30, 60 e 90 dias e período personalizado.
- Comparação de períodos e análise por IA baseada no filtro selecionado.
- Filtros e histórico relacionados a Full.
- Saída de estoque via NF-e/XML, com PDF como alternativa, usando SKU e tela de conferência antes da confirmação.
- Pedidos de compra com edição de quantidades, separação entre nacional e importado e exportação de documento.
- Origem nacional/importada como dado estruturado; filtro por marca e demais classificações.
- Central de vinculações para itens não associados de planilhas, XML/NF-e e Mercado Livre.
- Vinculação manual de MLB e variation_id a SKU.
- Desconto de estoque por venda Mercado Livre com ledger idempotente e reversão para cancelamentos/devoluções quando aplicável.
- Histórico completo de movimentações de estoque.
- Estoque por localização/estado: local, Full por conta, reservado e em trânsito quando aplicável.
- Interface do produto organizada por abas/seções, evitando scroll excessivo.
- Filtros salvos e saúde da sincronização.
- Dashboards Geral, Conta, SKU e Anúncio.
- Central de Ações e Oportunidades priorizadas por impacto financeiro e confiança.
- Diagnóstico baseado em evidências antes da camada de IA.
- Home orientada a “o que precisa da minha atenção hoje?”.
- Histórico de decisões e medição do resultado posterior quando aplicável.
- Busca universal/Command Palette por entidades principais.

## Notificações em tempo real

Mudanças relevantes em anúncios devem gerar eventos de sistema e notificações para usuários logados autorizados.

Exemplos:

- preço alterado;
- título alterado;
- foto principal alterada;
- descrição alterada;
- promoção iniciada/encerrada;
- entrada/saída do Full;
- estoque zerado/reposto;
- catálogo ganho/perdido;
- anúncio pausado/reativado;
- outras alterações consideradas relevantes.

A interface poderá exibir toast/popup no canto inferior direito, por exemplo:

`OffRacer alterou o preço do SKU 5821 de R$ 399,90 para R$ 379,90.`

Regras:

- notificações devem respeitar permissões por conta;
- evitar avalanche de popups;
- eventos repetidos devem ser agrupados quando necessário;
- manter uma Central de Notificações com histórico e estado lido/não lido;
- permitir níveis informativo, importante e crítico;
- o popup deve ser um resumo, com ação para abrir o produto/anúncio afetado;
- alterações automáticas e manuais devem ser distinguíveis quando a origem puder ser identificada;
- permitir preferências individuais de notificação quando a feature for implementada.

## Copiloto Speed Bikers

A aplicação deve ter um assistente contextual integrado à interface, com acesso somente aos dados e ações permitidos para o usuário autenticado.

Exemplos de perguntas:

- “Como está o produto X?”
- “Como está a conta Y?”
- “Por que este produto caiu?”
- “Quais produtos precisam de atenção?”
- “Compare este SKU nas contas.”
- “O que é mais urgente em compras?”

O Copiloto deve conhecer, quando possível, o contexto da tela aberta, filtros e entidade selecionada.

Regras:

- consultar dados determinísticos antes de usar IA para interpretação;
- informar o escopo/período analisado;
- nunca inventar métricas ausentes;
- respeitar RBAC e permissões por conta;
- permitir abrir diretamente produto, anúncio, conta, ação ou relatório relacionado;
- IA deve explicar evidências, não substituir consultas confiáveis.

## Ação contextual “O que aconteceu?”

KPIs, gráficos, produtos e contas relevantes poderão oferecer uma ação contextual para investigar alteração ou queda.

A análise deve retornar, quando suportado pelos dados:

- principal evidência;
- fatores secundários;
- relação temporal;
- impacto;
- nível de confiança;
- próximos passos sugeridos.

**Primeira fatia implementada em 2026-08-25 (D-078)** — botão "O que aconteceu?" no Dashboard de SKU (`/skus/[skuId]`), reaproveitando o mesmo motor de `/diagnostico`/Central de Ações (`diagnoseSalesAnomaly`, `docs/ARCHITECTURE.md` secao 16): principal evidência (venda vs. baseline), fator secundário (evento correlato, quando existe), impacto estimado em R$, confiança e próximos passos — todos os seis itens listados acima, cobertos pelo sinal de vendas que já existe. **Não implementado ainda**: KPIs/gráficos do Dashboard de Vendas (`/vendas`) e nível de conta — o motor de diagnóstico hoje só cobre sinal de vendas por SKU; expandir para outros sinais (visitas, conversão, preço, estoque, Full, promoção, Ads, catálogo) é trabalho incremental separado, já registrado em `docs/HANDOFF.md` ("Lacunas funcionais confirmadas na revisão").

## Simulador de decisão

Quando houver base matemática suficiente, permitir perguntas de cenário como:

- cobertura com determinado estoque;
- data estimada de ruptura conforme premissa explícita;
- quantidade necessária para X dias de cobertura;
- margem aproximada para determinado preço quando custos estiverem disponíveis.

Toda simulação deve exibir as premissas e nunca ser apresentada como certeza.

**Implementado em 2026-08-25 (D-080)** — as três primeiras perguntas, no Dashboard de SKU (`/skus/[skuId]`): a base matemática já existia e estava em produção desde D-058 (`get_stock_coverage`, `cobertura = estoque / venda média diária`, já usada em `/cobertura`) — as três perguntas são a MESMA fórmula resolvida para uma incógnita diferente cada vez. Cálculo em `@sb/domain` (`simulateCoverageDays`/`simulateRequiredQuantity`/`simulateRuptureDate`), premissas sempre visíveis e editáveis ao lado do resultado, nunca escondidas atrás de um botão "calcular". **Margem aproximada continua fora de escopo** — `docs/METRICS.md` já registra que "margem depende de custo cadastrado por SKU", e isso não existe no schema hoje (só custo por pedido de compra individual, sem consolidação); não há base matemática confiável, exatamente a condição que este próprio requisito já previa.

## Sugestões de features via Copiloto

**Captura + Central de Sugestões implementadas em 2026-08-25 (D-079)** — `apps/web/app/sugestoes`. Estruturação por IA continua pendente (ver abaixo).

Usuários autorizados poderão enviar ideias de melhoria em linguagem natural pelo assistente.

A IA deve preservar a mensagem original e gerar uma versão estruturada com, quando possível:

- título;
- problema;
- objetivo;
- usuários impactados;
- fluxo sugerido;
- benefício esperado;
- critérios de aceite sugeridos;
- dependências/riscos aparentes;
- complexidade a avaliar;
- autor e data.

O painel administrativo terá uma Central de Sugestões com estados como:

- Nova;
- Em análise;
- Aprovada;
- Planejada;
- Em desenvolvimento;
- Entregue;
- Recusada.

**Implementado em 2026-08-25 (D-079)**: qualquer membro da organização envia uma sugestão em texto livre (`/sugestoes`), preservado íntegro (`feature_suggestions.original_text`, nunca sobrescrito); ADMIN/GESTOR muda o estado nos sete valores acima. **Pendente**: a estruturação por IA dos campos título, problema, objetivo, usuários impactados, fluxo sugerido, benefício esperado, critérios de aceite, dependências/riscos e complexidade. O schema já possui as colunas e o modelo/orçamento foram decididos em D-082; falta implementar o fluxo. Autor e data já aparecem na Central via `created_by`/`created_at`, sem depender de IA.

## Memória de decisões operacionais

A Central de Ações deve poder registrar decisões tomadas e, posteriormente, confrontá-las com o resultado observado.

Exemplo:

- problema detectado;
- decisão tomada;
- responsável;
- data;
- alteração aplicada;
- resultado em período posterior quando mensurável.

Objetivo: construir memória institucional sobre quais ações funcionam na operação.

## Busca universal

Planejar uma busca/Command Palette para localizar rapidamente SKU, produto, MLB, conta, pedido, fornecedor, ação e outras entidades importantes, sem exigir navegação por vários menus.

## Consolidação de requisitos pendentes — 2026-08-24

Esta seção registra requisitos já discutidos e aprovados conceitualmente, mas que ainda não devem ser considerados concluídos apenas porque existe parte da infraestrutura ou dos dados necessários.

A implementação deve preservar tudo o que já existe na V3 e evoluir incrementalmente.

### Filtros operacionais

As telas relacionadas a Produtos, Estoque e análises de SKU devem permitir, quando aplicável:

- filtro por conta Mercado Livre;
- visão consolidada de todas as contas;
- filtro por origem Nacional / Importado;
- filtro por marca;
- filtro por fornecedor quando houver relação disponível;
- combinação entre os filtros anteriores.

Regra importante de estoque:

- estoque `LOCAL`, `RESERVADO` e `TRANSITO` pertence à organização/operação física e não deve ser falsamente atribuído a uma conta Mercado Livre;
- estoque Full pertence ao contexto da respectiva conta Mercado Livre;
- ao filtrar uma conta, a interface deve deixar visualmente claro quais números são compartilhados pela organização e quais pertencem à conta selecionada.

### Separação Nacional / Importado em pedidos de compra

Não basta exibir se cada SKU é Nacional ou Importado.

Um mesmo pedido de compra não deve misturar SKUs nacionais e importados.

Regra esperada:

1. ao selecionar o primeiro SKU com origem conhecida, o pedido assume a origem `NACIONAL` ou `IMPORTADO`;
2. os próximos SKUs elegíveis devem respeitar a mesma origem;
3. tentativa de misturar as duas origens deve ser bloqueada antes da confirmação;
4. origem desconhecida deve ser tratada explicitamente e não silenciosamente classificada;
5. pedidos antigos continuam preservados e não devem ser reescritos retroativamente.

### Exportação de pedido de compra

Manter os formatos já implementados:

- Excel;
- PDF.

Planejar também exportação estruturada em XML próprio da Speed Bikers quando houver utilidade operacional.

Esse XML é um documento estruturado interno e NÃO é XML fiscal de NF-e.

Nunca apresentar XML interno de pedido como documento fiscal.

### NF-e / DANFE PDF

O XML autorizado continua sendo a fonte preferencial e estruturada para importação fiscal.

PDF/DANFE é fallback quando o XML não estiver disponível.

A implementação de PDF deve:

- manter tela de conferência humana;
- não movimentar estoque sem confirmação;
- não inventar campos ausentes;
- preferir dados estruturados quando existirem;
- seguir as mesmas garantias de idempotência do fluxo XML.

A implementação de PDF não é bloqueio para o fluxo XML já operacional.

### Vínculo reutilizável de código de fornecedor para SKU

Quando um usuário resolver manualmente um item de fornecedor, o sistema deve poder aprender um alias determinístico reutilizável.

Conceito esperado:

`fornecedor + código do produto do fornecedor -> SKU`

Exemplos de identificadores possíveis, quando disponíveis:

- `cProd`;
- EAN/GTIN;
- código interno do fornecedor;
- outra referência estável confirmada.

O vínculo deve registrar origem, autor e data da confirmação.

Em futuras NF-e do mesmo fornecedor, um alias confirmado pode gerar sugestão ou match determinístico.

Nunca criar vínculo automático incerto silenciosamente.

### Vinculação manual livre de anúncio Mercado Livre

A Central de Vinculações não deve depender exclusivamente de existir um `link_candidate`.

Deve existir um fluxo manual explícito onde um usuário autorizado possa informar:

- conta Mercado Livre;
- MLB/item_id;
- variation_id quando aplicável;
- SKU de destino.

Exemplo:

`OffRacer + MLB123456789 + variation_id opcional -> SKU 5821`

A operação deve:

- validar duplicidade/conflito;
- respeitar permissões por conta;
- registrar usuário/data/origem;
- manter histórico auditável;
- nunca sobrescrever silenciosamente um vínculo existente incompatível.

### Dashboard de SKU organizado por abas

A página de SKU deve evoluir para uma interface orientada por progressive disclosure, evitando uma página vertical excessivamente longa.

Estrutura inicial desejada:

- Visão Geral;
- Vendas;
- Estoque;
- Anúncios;
- Preços;
- Full;
- Tráfego;
- Histórico;
- Diagnóstico;
- Decisões.

O cabeçalho do SKU e seus KPIs principais devem permanecer facilmente acessíveis.

Nem toda aba precisa existir desde o primeiro redesenho. Criar apenas quando houver dado real para sustentá-la.

### Home orientada à atenção

A rota inicial autenticada deve deixar de ser uma página de progresso de construção quando a base funcional estiver suficientemente madura.

A Home de produto deve responder prioritariamente:

`O que precisa da minha atenção hoje?`

Exemplos de blocos:

- problemas críticos;
- ações abertas;
- produtos em risco de ruptura;
- SKUs de alta importância sem Full;
- alterações relevantes de anúncios;
- problemas de sincronização;
- decisões aguardando medição;
- oportunidades detectadas.

Abaixo da camada de atenção podem aparecer KPIs gerais de vendas, receita, conversão, estoque, Full e demais métricas confiáveis.

A Home não deve criar alertas novos apenas para preencher espaço. Deve consumir dados, ações, eventos e diagnósticos reais já existentes.

**Primeira fatia implementada em 2026-08-27 (D-105)** — `apps/web/app/page.tsx`. O painel de progresso da construção foi REMOVIDO: na data da troca ele mentia em sete pontos (dava `PENDENTE` para NF-e/XML, Reservado/trânsito, Reconciliação ERP e Pedidos de compra, todos entregues na Fase 4, e "Nada começado" para as Fases 5B, 6 e 7, todas concluídas). A tela nova não tem lista escrita à mão: **todo número vem de consulta ao mesmo dado que a tela correspondente mostra**, que é o que impede a divergência de voltar. Quatro blocos nesta fatia — ações abertas, atendimentos abertos, atendimentos em mediação e notificações não lidas —, cada um linkando para a tela real. **Pendentes**, um por um, quando houver consulta agregada que os sustente: produtos em risco de ruptura, SKUs de alta importância sem Full, alterações relevantes de anúncios, problemas de sincronização, decisões aguardando medição e oportunidades detectadas. Falha de leitura aparece como “—”, nunca como zero (D-067).

### Evolução do diagnóstico

A Fase 6 estabelece o motor inicial de diagnóstico, mas não encerra a evolução das fontes de evidência.

O diagnóstico deve ser progressivamente capaz de correlacionar, quando os dados existirem e forem confiáveis:

- unidades vendidas;
- receita;
- visitas;
- conversão;
- preço;
- estoque local;
- ruptura;
- estoque Full;
- entrada/saída do Full;
- alterações de anúncio;
- promoções;
- catálogo;
- Ads, somente quando a integração estiver confirmada;
- outros sinais externos somente quando houver fonte real disponível.

A regra permanece:

`DADOS -> EVIDÊNCIAS -> REGRAS/ESTATÍSTICA -> DIAGNÓSTICO -> IA EXPLICA`

A Fase 6 pode estar concluída como primeira versão operacional sem significar que todas as possíveis causas já são observáveis.

### Motor de alterações de anúncio

Antes de notificações sobre mudanças de anúncios, deve existir uma fonte confiável de eventos de alteração.

Fluxo conceitual:

`estado anterior -> sincronização atual -> diff determinístico -> domain_event -> notificação/diagnóstico`

Primeiros eventos esperados, quando os campos estiverem disponíveis:

- `listing.price.changed`;
- `listing.title.changed`;
- `listing.status.paused` / `listing.status.reactivated`;
- `listing.available_quantity.changed`.

Eventos posteriores, somente depois de confirmar as fontes oficiais necessárias:

- alteração da foto principal;
- alteração da descrição;
- promoção iniciada/encerrada;
- entrada/saída de catálogo;
- entrada/saída do Full;
- outras mudanças relevantes.

Nunca gerar evento de mudança sem possuir estado anterior confiável para comparação.

### Navegação e organização visual

A aplicação deve evitar uma barra de navegação com todas as telas no mesmo nível.

Estrutura conceitual desejada:

- Visão Geral;

- Comercial:
  - Vendas;
  - Produtos;
  - Anúncios;

- Estoque:
  - Estoque;
  - Cobertura;
  - Curva ABC;
  - Notas Fiscais;
  - Compras;

- Inteligência:
  - Diagnóstico;
  - Ações;

- Atendimento (Fase 7B, registrado em 2026-08-24 — ver seção própria abaixo):
  - Caixa de Entrada — **implementada em 2026-08-25 (D-090)**;
  - Base de Conhecimento;

  "Perguntas", "Mensagens", "Reclamações" e "Mediações" estavam listadas aqui
  como itens de navegação próprios, mas D-084 decidiu depois que são FILTROS
  sobre a mesma projeção (`support_cases`), não telas distintas — mediação e
  devolução são inclusive facetas do claim, não canais. Viraram pílulas de
  filtro dentro da própria Caixa de Entrada; rotas separadas duplicariam a
  mesma tabela cinco vezes.

- Gestão:
  - Vinculações;
  - Fornecedores;
  - Contas Mercado Livre;
  - Sincronização;

- Administração:
  - Usuários;
  - Integrações;
  - Saúde do Sistema;
  - Sugestões;
  - Configurações.

A estrutura pode evoluir conforme o produto, mas deve priorizar clareza e evitar sobrecarga visual.

### Saúde de deploy e versão

O sistema deve tornar observável qual versão está realmente em execução.

Idealmente a área administrativa deverá permitir visualizar:

- commit do Web;
- commit da API;
- commit do Worker;
- migration mais recente esperada/aplicada;
- quantidade/status dos schedulers esperados;
- frescor da última execução relevante.

Documentação afirmando que um serviço está publicado não substitui verificação contra a infraestrutura real.

Essa regra nasce do incidente em que API/Worker ficaram dezenas de commits atrás do HEAD e schedulers documentados como existentes ainda não haviam sido provisionados.

## Central de Atendimento / SAC Mercado Livre (Fase 7B) — registrado em 2026-08-24

Requisito novo. Posicionamento e decisões de arquitetura em D-071
(`docs/DECISIONS.md`). Detalhe técnico em `docs/ARCHITECTURE.md` (domínio
`support`), `docs/COPILOT.md` (sugestão de resposta), `docs/API.md` e
`docs/DATABASE.md` (modelo aprovado em D-084, núcleo de banco criado em D-085 e
persistência isolada de Perguntas concluída em D-086) e
`docs/MERCADO_LIVRE.md` (pesquisa oficial concluída em D-083). A infraestrutura
read-only e a transformação/persistência local de Perguntas estão implementadas;
o adaptador de rede e, portanto, a ingestão externa ainda não. Caixa de entrada,
notificações de SAC, triagem e resposta continuam pendentes — ver `docs/ROADMAP.md` Fase 7B.

### Objetivo

Administrar, dentro da Speed Bikers Gestão, o atendimento das diferentes
contas Mercado Livre sem alternar entre contas e telas do próprio Mercado
Livre.

### Caixa de entrada unificada

Perguntas pré-venda, mensagens pós-venda, reclamações/claims, devoluções,
mediações e outros tipos de atendimento, conforme a API oficial realmente
disponibilizar — nenhum endpoint, payload, permissão, webhook, status, SLA
ou regra de mediação deve ser presumido antes da pesquisa oficial
(`docs/PROMPT_MASTER.md` §9).

### Notificações de atendimento

Reaproveitam integralmente a cadeia já aprovada na Fase 7
(`domain_events -> severidade -> notifications`, `docs/NOTIFICATIONS.md`).
Devem: respeitar permissão por conta; indicar de qual conta vieram; informar
o tipo de atendimento; abrir o atendimento relacionado; persistir na Central
de Notificações; poder gerar toast; manter lido/não lido; evitar avalanche;
agrupar quando fizer sentido; usar severidade.

Exemplos de severidade — regras conceituais iniciais, a calibrar depois com
dado real e regras confirmadas do Mercado Livre:

- **Informativo**: nova pergunta comum; nova mensagem sem urgência.
- **Importante**: nova reclamação; cliente respondeu conversa pendente;
  pergunta aguardando resposta há muito tempo.
- **Crítico**: nova mediação; atendimento próximo de prazo crítico;
  reclamação com risco operacional relevante.

### Estrutura da Central

Grupos: Todos, Perguntas, Mensagens, Reclamações, Devoluções, Mediações.
Conforme D-084, “Devoluções” e “Mediações” são filtros/facetas de claim e
podem mostrar o mesmo atendimento; não são cases duplicados. Pergunta,
conversa pós-venda e claim ligados ao mesmo pedido continuam cases separados,
relacionados pelo pedido/pack, porque têm status, ações e prazos diferentes.

Filtros desejados: conta Mercado Livre; tipo; status; prioridade;
responsável; SKU; MLB/anúncio; pedido; período; aguardando resposta; próximo
do SLA/prazo; resolvido/não resolvido.

Cada atendimento deve mostrar, quando os dados estiverem disponíveis: conta
Mercado Livre; comprador/cliente; pedido; `pack_id` quando aplicável; SKU;
MLB/`item_id`; `variation_id`; título do produto; histórico da conversa;
tipo do atendimento; status do Mercado Livre; status interno; responsável
interno; datas; prazo/SLA; prioridade; links para SKU, anúncio, pedido e
demais entidades relacionadas.

### Status e responsável interno

Além do status externo do Mercado Livre, o status operacional interno aprovado
em D-084 usa: `NOVO`, `EM_ATENDIMENTO`, `AGUARDANDO_CLIENTE`,
`AGUARDANDO_MERCADO_LIVRE`, `RESOLVIDO`. Não existe `FECHADO` interno: o
fechamento remoto permanece no status do Mercado Livre. Atividade inbound nova
reabre um item resolvido para `NOVO`; sincronização não pode sobrescrever outra
decisão humana de status.

Permitir atribuição de responsável interno. Registrar histórico de quem
assumiu, quem respondeu, quando respondeu, mudança de status, resolução e
reabertura quando aplicável. Nada importante deve depender apenas do estado
visual da interface.

Prioridade interna: `NORMAL`, `ALTA`, `CRITICA`, separada da severidade da
notificação. Na primeira regra determinística, mediação parte crítica, claim
parte alta e pergunta/mensagem parte normal; prazo em risco pode elevar a
prioridade. Calibrar com dado real antes de automatizar qualquer regra além
dessas classificações iniciais.

### Prazo/SLA por fonte

O modelo aceita vários prazos por atendimento. Pergunta não possui prazo
individual remoto e só recebe SLA após uma política interna aprovada. Mensagem
intermediada preserva a regra documentada de 48 horas úteis, mas não calcula
`due_at` somando horas corridas; isso exige calendário canônico de horas úteis.
Claim usa `detail.due_date`/`available_actions[].due_date` quando presentes.
Toda exibição deve informar a fonte (`INTERNAL_POLICY`, regra de mensageria ou
prazo remoto do claim); prazo ausente nunca vira estimativa apresentada como
oficial.

### Identidade, vínculos e auditoria

Identidade de atendimento usa organização + conta + canal + chave remota:
pergunta por `question_id`, conversa por pack (ou pedido fallback) e claim por
`claim_id`. `buyer_id` e `from/to` são atributos, não identidade, pois o Agente
de Mensageria do MLB pode ocupar esses campos. Um atendimento pode vincular
múltiplos pedidos, SKUs e anúncios; os filtros devem usar esses vínculos, sem
escolher um “SKU principal” arbitrário.

Webhook e reconciliação precisam convergir para as mesmas linhas por
constraints únicas. O histórico operacional detalhado é append-only; somente
transições relevantes viram `domain_events support.*`, evitando notificação a
cada atualização técnica. Detalhe físico e chaves em `docs/DATABASE.md`.

### Copiloto sugerindo respostas

Detalhe arquitetural em `docs/COPILOT.md` secao 11. O Copiloto sugere
respostas para perguntas, mensagens, reclamações e mediações quando existir
informação suficiente e a API permitir resposta. **A primeira versão não
responde automaticamente** — aprovação humana é obrigatória:

```
ATENDIMENTO -> buscar contexto determinístico -> montar evidências
   -> Copiloto gera sugestão -> usuário revisa -> usuário edita se quiser
   -> usuário confirma -> somente então a resposta é enviada
```

**Isto não é uma ferramenta de escrita do Copiloto** (D-071) — a sugestão é
geração de texto, mesma categoria já aprovada de "estruturar ideia de
feature" (`docs/COPILOT.md`). O envio em si é um comando privilegiado
separado, executado por `apps/api` após confirmação humana explícita, nunca
uma ação que o Copiloto executa sozinho.

Contexto que o Copiloto deve consultar via ferramentas determinísticas,
quando aplicável: conta Mercado Livre; anúncio; título atual; SKU;
`variation_id`; informações cadastradas do SKU; compatibilidades conhecidas;
histórico de vendas do SKU; histórico do anúncio; pedido do cliente; item
efetivamente comprado; quantidade; status da venda; status da entrega;
reclamação/devolução/mediação relacionada; mensagens e respostas anteriores;
histórico de atendimentos semelhantes; Base de Conhecimento Validada. A IA
não recebe acesso livre ao banco nem escreve SQL — mesma regra já aplicada a
todo o Copiloto.

**Perguntas de compatibilidade merecem atenção especial.** Com evidência
confiável, sugerir algo como "Sugerimos responder que sim, pois o SKU X
possui compatibilidade confirmada com X-ADV 2025." Sem evidência suficiente,
responder isso explicitamente ("Não encontrei informação suficiente para
confirmar"). Nunca inventar compatibilidade.

### Base de Conhecimento Validada (aprendizado operacional)

Quando o Copiloto sugerir algo incorreto ou incompleto e um funcionário
corrigir com conhecimento real da empresa, essa correção pode virar
conhecimento reutilizável. **O sistema não deve fazer o modelo de IA
"aprender sozinho"** — existe uma memória operacional própria, com
confirmação humana explícita em cada item (D-071: é uma tabela relacional
consultada por ferramenta determinística, não RAG/embeddings/pgvector —
`docs/COPILOT.md` continua excluindo isso).

Fluxo conceitual: Copiloto sugere → humano corrige → sistema percebe
divergência ou usuário marca informação útil → oferece registrar como
conhecimento → humano confirma → conhecimento estruturado é salvo → futuras
respostas consultam esse conhecimento.

Exemplo de conhecimento:

```
SKU: 5821
Tipo: COMPATIBILIDADE
Marca: Honda
Modelo: X-ADV 750
Ano inicial: 2022
Ano final: 2025
Resultado: COMPATÍVEL
Fonte: CONFIRMAÇÃO_INTERNA
Observação: "Compatibilidade confirmada pela equipe."
Confirmado por: usuário X
Confirmado em: data/hora
```

Cada conhecimento deve possuir, quando aplicável: `organization_id`;
`sku_id`; tipo; conteúdo estruturado; texto livre complementar; fonte;
confidence/status; criado_por; confirmado_por; `created_at`; `confirmed_at`;
`updated_at`; ativo/inativo. Estados possíveis: `SUGERIDO`, `VALIDADO`,
`REJEITADO`, `OBSOLETO`. Somente conhecimento `VALIDADO` deve ser tratado
pelo Copiloto como informação operacional confirmada.

Não sobrescrever silenciosamente conhecimento antigo. Se houver conflito
("SKU X compatível com Y" versus "SKU X NÃO compatível com Y"), sinalizar
para revisão humana.

**Histórico de resposta não é automaticamente verdade.** Separar histórico
de resposta (contexto) de conhecimento validado (fato confirmado) —
conhecimento reutilizável exige confirmação explícita ou regra
determinística confiável, nunca "alguém já respondeu isso uma vez".

### Respostas rápidas e templates

Templates, respostas rápidas, mensagens favoritas, assinatura por conta
quando necessário, placeholders seguros (ex.: `"Olá, {nome}. Obrigado pelo
contato..."`). Templates não devem substituir o contexto específico do
atendimento.

### Métricas de SAC

Exemplos: novos atendimentos; atendimentos pendentes; perguntas/mensagens
sem resposta; reclamações/mediações abertas; devoluções; tempo médio de
primeira resposta; tempo médio de resolução; atendimentos por
conta/tipo/SKU; reclamações por SKU e por quantidade vendida (quando
matematicamente correto); principais motivos; reincidência; atendimentos
próximos do prazo; produtividade por responsável quando fizer sentido
operacionalmente. Definição canônica obrigatória antes de exibir qualquer
métrica — mesmo princípio de `docs/METRICS.md`.

### SAC como fonte de diagnóstico e Central de Ações

SAC vira evidência adicional do pipeline determinístico já aprovado
(`docs/ARCHITECTURE.md` secao 16: `DADOS -> EVIDÊNCIAS -> REGRAS -> DIAGNÓSTICO
-> IA EXPLICA`) — nunca conclusão automática só por palavra solta na
mensagem; primeiro coletar sinal e evidência.

Um atendimento individual geralmente não precisa virar ação, mas um padrão
relevante pode: muitas reclamações semelhantes no mesmo SKU, aumento
anormal de mediações, dúvidas recorrentes sobre compatibilidade, perguntas
repetidas indicando descrição insuficiente, devoluções recorrentes pelo
mesmo motivo. Pipeline: atendimentos → agregação determinística → sinal →
diagnóstico → Central de Ações (a mesma já existente, D-064) → humano
decide.

### Auditoria de resposta

Toda resposta enviada deve registrar: atendimento; conta; usuário
responsável; conteúdo efetivamente enviado; data/hora; se houve sugestão de
IA; texto originalmente sugerido pela IA quando necessário para auditoria;
texto final enviado pelo humano; sucesso/falha de envio; identificador
retornado pelo Mercado Livre quando existir.

### Permissões

Respeitar integralmente organização, conta Mercado Livre, RBAC e
`user_account_permissions` — mesma regra já aplicada em toda a V3. Usuário
sem acesso a uma conta não pode ver mensagens dela, receber notificação
dela, consultar seu SAC pelo Copiloto, nem responder atendimento dela.
Autorização no backend/RLS, nunca só escondendo componente de interface.

### UX conceitual

Três áreas, se fizer sentido na implementação: lista/filtros dos
atendimentos; conversa/histórico do atendimento selecionado; contexto do
pedido/produto + Copiloto + conhecimento relacionado (coluna ou drawer). A
interface deve priorizar rapidez de atendimento.

### Automação futura

Primeira versão: `COPILOTO SUGERE -> HUMANO CONFIRMA -> SISTEMA ENVIA`.
Resposta automática autônoma não entra nesta etapa. No futuro, automação
parcial só seria avaliada para casos extremamente seguros e repetitivos,
com decisão arquitetural explícita e métricas de confiança.

## Consolidação de requisitos — 2026-08-28 (D-120)

Trinta blocos de features, melhorias e correções trazidos pelo usuário, confrontados com o código real e com o banco de produção antes de virarem requisito. **Nada aqui invalida o que já existe**; os itens que a auditoria provou estarem quebrados estão marcados como CORREÇÃO, não como feature nova.

Ordem de construção e dependências em `docs/ROADMAP.md`. Achados que sustentam as prioridades em `docs/DECISIONS.md` D-120.

### Regra transversal: configuração em vez de hardcode

Sempre que uma regra operacional puder mudar — lead time, cobertura alvo, buffer, origem de compra, política de reposição —, ela é **configuração estruturada**, nunca condicional por nome dentro do domínio.

Medição que reforça a regra: `origin_code` (fiscal) diz que **82% dos SKUs Navetec são NACIONAIS**, e 91% dos Off Racer também — contra a premissa operacional de que essas marcas são importação. Ou o código fiscal do export está errado, ou "importado" no vocabulário da operação significa **rota de compra/fornecedor**, não origem fiscal do item. São conceitos diferentes, e o sistema só conhece o segundo. **Decisão pendente** (D-120, questão aberta 2). Enquanto ela não vier: nem hardcode por marca, nem confiança cega em `is_imported`.

`skus` **não tem `supplier_id`** — a relação fornecedor→SKU nunca existiu. Toda configuração por fornecedor nasce de algo que ainda não existe.

### Dashboard de Vendas

Manter os seis KPIs atuais e acrescentar: taxas do Mercado Livre, margem operacional por pedido (**nunca chamada de "receita líquida"** — `docs/METRICS.md` 5C.1), pedidos cancelados, taxa de cancelamento, valor cancelado, SKUs distintos vendidos e a visão "hoje" com a incompletude do dia sinalizada.

O gráfico deve permitir trocar a métrica entre faturamento, unidades, pedidos e compras/packs. **A RPC `get_sales_daily_series` já devolve as quatro** e a tela plota uma — é trabalho de interface, não de banco. Presets de 7/15/30/60/90 e personalizado já existem; a comparação com período anterior existe nos cards e deve alcançar o gráfico.

### Dashboard de Anúncios

Deixa de ser lista e passa a responder: quais anúncios existem, em qual conta, SKU, status, preço, disponível, Full, vendas, faturamento, visitas, conversão, última sincronização e problemas relevantes. Filtros por conta, status, SKU, MLB, período, com/sem Full, com/sem estoque, vinculado/sem vínculo, com/sem venda.

**CORREÇÃO estrutural, não ajuste de tela:** anúncio sem vínculo não aparece porque **a linha não existe** — o sync enumera `sku_listing_links`, não o catálogo do vendedor. A interface já trata `sku_id` nulo. O trabalho é trocar a fonte de enumeração e rodar backfill. Anúncios **com variação** também estão fora hoje, e representam 15,5% da receita.

### Estoque

Enriquecer com marca, categoria, fornecedor, origem, custo, Full, data de criação e último movimento; filtros pelas mesmas dimensões. **Marca, categoria, origem, custo e data de criação já existem em `skus` e nenhuma tela os mostra** — `purchase_cost` está 94,9% preenchido.

Valor do estoque **fica bloqueado** até a questão do estoque sentinela ser resolvida (`docs/METRICS.md` 5C.4).

### Cobertura, reposição e sugestão de compra

A tela deve responder **"quanto eu deveria comprar?"**, não só "quantos dias eu tenho". Para cada SKU: estoque atual, Full, reservado, em trânsito, venda média, tendência, cobertura, prazo de reposição, cobertura desejada, estoque de segurança, quantidade sugerida, custo unitário usado e custo total estimado.

Regras:

- A quantidade vem de **cálculo auditável, nunca de IA**. A IA pode explicar a sugestão; nunca produzi-la.
- Toda sugestão precisa de decomposição visível ("por que comprar 48?"): demanda projetada, meta de cobertura, buffer, estoque aproveitável, em trânsito, resultado.
- **"Estoque real aproveitável" exige definição explícita** para não contar duas vezes nem ignorar Local, Full, Reservado e Trânsito — quatro estados com quatro autoridades diferentes.
- Tendência analisa janelas (90/60/30/15 dias) e classifica crescendo/estável/caindo, com fórmula determinística e documentada.
- Importado e nacional têm políticas diferentes (referências iniciais: cerca de 90 dias de cobertura para importação; cerca de 15 dias de lead time para nacional). **Lead time não é cobertura alvo** — comprar 15 dias de estoque com 15 dias de prazo zera antes da entrega.
- Excesso de estoque é estado próprio, calculado, não opinião da IA.
- Priorização de compra (Curva ABC, risco de ruptura, cobertura, crescimento, margem quando conhecida, prazo, valor necessário) é camada de ordenação, **nunca compra automática**.
- Custo cadastrado e custo de simulação são distintos: simular um pedido não pode destruir o custo histórico do SKU.
- Da cobertura para o pedido: selecionar, revisar quantidade e custo, criar pedido — com aprovação humana, respeitando a regra de não misturar nacional e importado.

**Pré-condição declarada:** tudo isto lê `inventory_balances.LOCAL`, hoje contaminado por estoque sentinela (581 de 828 SKUs com saldo positivo acima de 1.000 unidades) e por 1.639 saldos negativos. **Construir sobre isso produz número errado com aparência de precisão** — exatamente o que a Regra de Progressão do roadmap proíbe.

### Configurações de reposição

Estrutura por fornecedor/origem/SKU: lead time, cobertura desejada, buffer máximo, política de compra. Evolui sem alterar código quando um fornecedor ou prazo mudar.

### Curva ABC

Critério trocável (faturamento, unidades, pedidos), períodos de 30/60/90 e personalizado, e **escopo por conta com RECÁLCULO dentro do escopo** — não filtrar uma curva global.

Medido: **726 SKUs vendem em mais de uma conta e 450 deles (62%) mudam de classe conforme a conta.** Recalcular não é refinamento: muda a resposta na maioria dos casos. Exige o parâmetro de conta **dentro** do RPC, nas duas CTEs; filtrar em JavaScript repetiria o bug de grão multi-conta que já derrubou um job em 2026-08-25.

### Central de Ações e Diagnóstico com IA

Manter a matemática determinística e acrescentar a camada de explicação: o que aconteceu, por que o sistema acredita nisso, evidências, confiança, ação recomendada, impacto esperado e o que o humano deve conferir. A IA **narra o que já foi calculado** e nunca inventa diagnóstico — regra já vigente.

Vocabulário obrigatório: causa mais provável, fatores contribuintes, hipóteses, evidências contrárias e o que ainda não conseguimos verificar. Nunca "causa verdadeira".

Ações ganham atalhos operacionais (abrir cobertura, abrir anúncio, abrir SKU, ver Full, abrir diagnóstico). **Hoje não existe nenhum link na Central de Ações** — só quatro botões —, e a própria recomendação manda "abrir a Caixa de Entrada deste SKU", navegação que a interface não oferece.

### Timeline do diagnóstico

A ordem dos acontecimentos é mais útil que o fato isolado. `domain_events` já é a linha do tempo e **não existe nenhuma tela cronológica**.

Limite a resolver antes: a correlação filtra `entity_type='sku'`, e todo evento de anúncio é `entity_type='listing'`. **Mudança de preço, título ou status nunca chega ao diagnóstico hoje.**

### Integridade de vinculações

Indicadores por conta: anúncios sincronizados, vinculados, sem vínculo, percentual, candidatos abertos e resolvidos, inconsistências, variações sem vínculo. A tela deve permitir clicar na diferença.

**Nunca tratar "candidatos abertos = 0" como "tudo vinculado".** A reconciliação tem de ser independente, comparando fontes que não dependem do mesmo pipeline.

### Saúde da sincronização

Diferenciar **backfill** (processo finito, chega a 100%) de **sincronização contínua** (permanente, cujo indicador honesto é frescor, não barra). Por conta e por recurso: status, progresso, processados, esperados quando conhecidos, percentual quando houver denominador confiável, última execução, último sucesso, último dado, erros, tentativas e frescor.

**Nunca inventar porcentagem.** Sem denominador confiável, mostrar página atual, importados, último registro e frescor.

Também distinguir **dado puxado do Mercado Livre** de **dado processado por nós** (métricas recalculadas), que é onde os gargalos aparecem.

### Filtros consistentes entre telas

Padronizar conta, período, marca, fornecedor, origem, SKU e status; componente compartilhado em vez de cada tela reinventar; filtros relevantes na URL; compatível com os Filtros Salvos já existentes — cujo mecanismo é agnóstico de tela e está plugado em apenas uma das cinco.

### Recriar / republicar anúncio (relist)

Operação **oficial** de republicação, nunca uma cópia via criação de item com parâmetros presumidos. Contrato e lacunas em `docs/MERCADO_LIVRE.md` secao 2.16.

Requisitos:

- **Não prometer** recuperação de experiência de compra, exposição, posição orgânica ou vendas. A documentação oficial **não afirma nada** sobre reputação em relist, em nenhuma direção. O que se pode afirmar é: "republicar pelo fluxo oficial quando elegível". Resultado observado depois vira medição, nunca garantia.
- **Preflight obrigatório** antes de qualquer comando destrutivo; se uma pré-condição crítica falhar, **não fechar o anúncio**. Encerrar é irreversível — a doc afirma que item encerrado não pode ser reativado.
- **Ler a tag de republicação no pai**: existe uma republicação por item pai, e essa é a checagem mais barata de todas.
- **Snapshot auditável** antes da ação, suficiente para auditoria, diagnóstico e comparação antes/depois.
- **Execução assíncrona** pela arquitetura existente (web → api → Cloud Tasks → worker), com estados rastreáveis e falhas nomeadas.
- **Idempotência é 100% nossa** — a API do Mercado Livre não documenta nenhum mecanismo. Chave de operação, dedup e reconciliação de estado antes de recriar.
- **Remapear variações é etapa obrigatória**, não cuidado opcional: a doc afirma que o identificador de variação é renovado.
- **Bloquear inicialmente Full e Catálogo** — a documentação é silenciosa nos dois, e o risco é prender ou desvincular estoque físico.
- **Relação pai → filho preservada para sempre**, nos dois sentidos, inclusive na Busca Universal: pesquisar o MLB antigo encontra o registro e aponta o atual.
- **Permissão específica** para executar, imposta no backend, nunca só escondendo o botão.
- **Confirmação humana explícita.** A IA pode recomendar avaliação; nunca executa e nunca afirma que republicar corrigirá o problema.
- **Republicação não é atalho para qualidade**: antes de sugerir, verificar causas corrigíveis sem encerrar o anúncio (estoque, preço, título, foto, descrição, compatibilidade, Full, promoção, catálogo, Ads, logística).
- **Medir 7/15/30 dias** com baseline capturado no ato. `action_decisions`/`action_outcomes` (D-065) já fazem exatamente isso — é reuso, não feature nova. Linguagem "após a republicação", nunca "por causa da".
- Aprendizado agregado só quando houver amostra suficiente, vindo dos nossos dados e não de opinião da IA.

## Design System

Paleta oficial inicial:

- Branco: `#FFFFFF`
- Primary: `#0F1158`
- Secondary: `#373993`
- Danger: `#E83736`
- Muted: `#CCC5D5`
- Supporting: `#655D89`
- Accent: `#F8E523`

A aplicação deve priorizar hierarquia visual, densidade controlada e progressive disclosure. Não exibir todas as informações simultaneamente quando abas, drill-downs, drawers, tooltips ou expansões forem mais apropriados.
