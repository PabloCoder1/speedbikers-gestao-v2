# Requisitos de Produto — V3

Documento inicial. Será consolidado antes do primeiro desenvolvimento funcional.

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
- permitir níveis de severidade/prioridade;
- o popup deve ser um resumo, com ação para abrir o produto/anúncio afetado;
- alterações automáticas e manuais devem ser distinguíveis quando a origem puder ser identificada.

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
