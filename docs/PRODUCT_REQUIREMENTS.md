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

## Simulador de decisão

Quando houver base matemática suficiente, permitir perguntas de cenário como:

- cobertura com determinado estoque;
- data estimada de ruptura conforme premissa explícita;
- quantidade necessária para X dias de cobertura;
- margem aproximada para determinado preço quando custos estiverem disponíveis.

Toda simulação deve exibir as premissas e nunca ser apresentada como certeza.

## Sugestões de features via Copiloto

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
