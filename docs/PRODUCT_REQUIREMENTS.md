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

- `listing.price_changed`;
- `listing.title_changed`;
- `listing.status_changed`;
- `listing.available_quantity_changed`.

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
