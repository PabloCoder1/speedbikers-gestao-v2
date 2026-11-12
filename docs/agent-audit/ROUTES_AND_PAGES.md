# Rotas e páginas

Inventário App Router de `d6169205`. Contém 58 páginas e 11 handlers. O grupo `(app)` usa o layout autenticado, e a exposição por caminho é conferida em [proxy.ts](../../apps/web/proxy.ts). O [menu](../../apps/web/components/nav.tsx) e o [hub Configurações](<../../apps/web/app/(app)/configuracoes/page.tsx>) apontam para as principais entradas.

As consultas abaixo são referências literais da própria entrada. Siga imports para componentes, Server Actions, clientes da API e leituras delegadas. Consulte [API e jobs](API_AND_JOBS_MAP.md) e [Banco](DATABASE_MAP.md) para chegar aos produtores e às migrations.

## Painel e diagnóstico

Specs relacionados em `apps/web/e2e/` (sufixo `.spec.ts`) · home, acoes, central, copiloto, copiloto-gaveta, diagnostico, notificacoes, sugestoes.

| Rota | Entrada | Referências diretas de dados |
|---|---|---|
| `/` | [page.tsx](<../../apps/web/app/(app)/page.tsx>) | RPC `get_stock_coverage_summary`, `get_marketplace_sales_summary`, `get_marketplace_sales_daily`. Tabelas `actions`, `support_cases`, `notification_recipients`, `listings`, `profiles` |
| `/acoes` | [page.tsx](<../../apps/web/app/(app)/acoes/page.tsx>) | RPC `get_actions_queue`. Tabelas `action_decisions`, `action_outcomes` |
| `/central` | [page.tsx](<../../apps/web/app/(app)/central/page.tsx>) | RPC `get_faturamento`, `get_ads_overview`, `get_meta_do_mes`, `get_detector_frete`, `get_sinais_ads`. Tabelas `ml_accounts` |
| `/central/ads` | [page.tsx](<../../apps/web/app/(app)/central/ads/page.tsx>) | RPC `get_sinais_ads`, `get_faturamento` |
| `/central/frete` | [page.tsx](<../../apps/web/app/(app)/central/frete/page.tsx>) | RPC `get_detector_frete` |
| `/central/limites` | [page.tsx](<../../apps/web/app/(app)/central/limites/page.tsx>) | Tabelas `central_thresholds` |
| `/central/metas` | [page.tsx](<../../apps/web/app/(app)/central/metas/page.tsx>) | RPC `get_meta_do_mes`. Tabelas `monthly_goals`, `tax_rates`, `monthly_goals_marketplace` |
| `/central/produtos` | [page.tsx](<../../apps/web/app/(app)/central/produtos/page.tsx>) | RPC `get_ranking_produtos`. Tabelas `ml_accounts` |
| `/copiloto` | [page.tsx](<../../apps/web/app/(app)/copiloto/page.tsx>) | Ver a entrada e seus imports |
| `/diagnostico` | [page.tsx](<../../apps/web/app/(app)/diagnostico/page.tsx>) | RPC `get_sku_sales_baseline`, `get_sku_correlated_events`, `get_sku_average_prices`. Tabelas `support_case_links` |
| `/notificacoes` | [page.tsx](<../../apps/web/app/(app)/notificacoes/page.tsx>) | Tabelas `notification_recipients`, `ml_accounts`, `shopee_shops` |
| `/notificacoes/preferencias` | [page.tsx](<../../apps/web/app/(app)/notificacoes/preferencias/page.tsx>) | Tabelas `notification_preferences`, `ml_accounts` |
| `/sugestoes` | [page.tsx](<../../apps/web/app/(app)/sugestoes/page.tsx>) | Tabelas `feature_suggestions` |

## Comercial e anúncios

Specs relacionados em `apps/web/e2e/` (sufixo `.spec.ts`) · anuncios, anuncio-detalhe, anuncio-excluido, anuncios-shopee, vendas, vendas-shopee, vendas-multicanal, faturamento, faturamento-multicanal, precos, full, vinculacoes.

| Rota | Entrada | Referências diretas de dados |
|---|---|---|
| `/anuncios` | [page.tsx](<../../apps/web/app/(app)/anuncios/page.tsx>) | RPC `get_listings_dashboard`, `get_listings_dashboard_counts`. Tabelas `ml_accounts`, `saved_filters` |
| `/anuncios/[itemId]` | [page.tsx](<../../apps/web/app/(app)/anuncios/[itemId]/page.tsx>) | RPC `get_listing_dashboard_summary`, `get_listings_dashboard`, `get_fulfillment_overview`, `get_listing_content_change_analysis`. Tabelas `listings`, `domain_events`, `actions`, `daily_listing_metrics`, `daily_listing_visits`, `listing_relists`, `action_decisions` |
| `/anuncios/shopee` | [page.tsx](<../../apps/web/app/(app)/anuncios/shopee/page.tsx>) | RPC `get_shopee_listings`, `get_shopee_listings_summary`. Tabelas `shopee_shops`, `saved_filters` |
| `/faturamento` | [page.tsx](<../../apps/web/app/(app)/faturamento/page.tsx>) | RPC `get_faturamento`, `get_ads_overview`. Tabelas `ml_accounts` |
| `/full` | [page.tsx](<../../apps/web/app/(app)/full/page.tsx>) | RPC `get_fulfillment_overview`. Tabelas `ml_accounts` |
| `/precos` | [page.tsx](<../../apps/web/app/(app)/precos/page.tsx>) | RPC `get_price_changes`. Tabelas `ml_accounts` |
| `/vendas` | [page.tsx](<../../apps/web/app/(app)/vendas/page.tsx>) | RPC `get_sales_top_skus`, `get_sales_expanded_summary`, `get_sales_summary`, `get_sales_today_summary`, `get_supplier_brands`. Tabelas `ml_accounts`, `saved_filters` |
| `/vendas/shopee` | [page.tsx](<../../apps/web/app/(app)/vendas/shopee/page.tsx>) | RPC `get_shopee_returns_summary`, `get_shopee_returns`, `get_shopee_sales_by_shop`, `get_shopee_orders`. Tabelas `shopee_shops`, `saved_filters` |
| `/vinculacoes` | [page.tsx](<../../apps/web/app/(app)/vinculacoes/page.tsx>) | RPC `get_listings_link_overview`, `get_link_integrity`, `get_listings_dashboard`. Tabelas `ml_accounts`, `link_candidates`, `sku_listing_links` |

## Catálogo, estoque e compras

Specs relacionados em `apps/web/e2e/` (sufixo `.spec.ts`) · compras, pedido-compra, curva-abc-multicanal, estoque-ajuste, fornecedores, importacoes, nota-fiscal, produtos, reposicao, reposicao-configuracoes, sku-dashboard, sku-shopee, vendas-por-sku-multicanal.

| Rota | Entrada | Referências diretas de dados |
|---|---|---|
| `/cobertura` | [page.tsx](<../../apps/web/app/cobertura/page.tsx>) | Ver a entrada e seus imports |
| `/compras` | [page.tsx](<../../apps/web/app/(app)/compras/page.tsx>) | RPC `get_purchase_orders_overview`, `get_purchase_orders` |
| `/compras/[id]` | [page.tsx](<../../apps/web/app/(app)/compras/[id]/page.tsx>) | Tabelas `purchase_orders`, `purchase_order_items`, `purchase_order_events` |
| `/compras/[id]/editar` | [page.tsx](<../../apps/web/app/(app)/compras/[id]/editar/page.tsx>) | Tabelas `purchase_orders`, `purchase_order_items`, `suppliers` |
| `/compras/novo` | [page.tsx](<../../apps/web/app/(app)/compras/novo/page.tsx>) | RPC `get_suppliers_overview`, `get_supplier_brands`. Tabelas `purchase_orders`, `skus` |
| `/curva-abc` | [page.tsx](<../../apps/web/app/(app)/curva-abc/page.tsx>) | RPC `get_sku_abc_analysis`, `get_supplier_brands`, `get_sku_categories`. Tabelas `ml_accounts`, `saved_filters`, `marketplace_accounts` |
| `/estoque` | [page.tsx](<../../apps/web/app/(app)/estoque/page.tsx>) | RPC `get_stock_balances`, `get_supplier_brands`, `get_stock_summary` |
| `/estoque/[skuId]/ajuste` | [page.tsx](<../../apps/web/app/(app)/estoque/[skuId]/ajuste/page.tsx>) | Tabelas `skus`, `inventory_balances`, `stock_movements`, `profiles` |
| `/estoque/movimentacoes` | [page.tsx](<../../apps/web/app/(app)/estoque/movimentacoes/page.tsx>) | RPC `get_stock_movements`, `get_stock_movements_summary` |
| `/fornecedores` | [page.tsx](<../../apps/web/app/(app)/fornecedores/page.tsx>) | RPC `get_suppliers_overview` |
| `/fornecedores/[supplierId]` | [page.tsx](<../../apps/web/app/(app)/fornecedores/[supplierId]/page.tsx>) | RPC `get_supplier_overview`, `get_supplier_purchased_skus`. Tabelas `purchase_orders`, `suppliers` |
| `/fornecedores/[supplierId]/editar` | [page.tsx](<../../apps/web/app/(app)/fornecedores/[supplierId]/editar/page.tsx>) | Tabelas `suppliers`, `purchase_orders` |
| `/fornecedores/novo` | [page.tsx](<../../apps/web/app/(app)/fornecedores/novo/page.tsx>) | Ver a entrada e seus imports |
| `/importacoes` | [page.tsx](<../../apps/web/app/(app)/importacoes/page.tsx>) | Tabelas `erp_import_batches` |
| `/importacoes/[id]` | [page.tsx](<../../apps/web/app/(app)/importacoes/[id]/page.tsx>) | Tabelas `erp_import_rows`, `erp_import_batches` |
| `/importacoes/nova` | [page.tsx](<../../apps/web/app/(app)/importacoes/nova/page.tsx>) | Ver a entrada e seus imports |
| `/notas-fiscais` | [page.tsx](<../../apps/web/app/(app)/notas-fiscais/page.tsx>) | RPC `get_documents_overview`. Tabelas `documents` |
| `/notas-fiscais/[id]` | [page.tsx](<../../apps/web/app/(app)/notas-fiscais/[id]/page.tsx>) | Tabelas `documents`, `document_items` |
| `/notas-fiscais/nova` | [page.tsx](<../../apps/web/app/(app)/notas-fiscais/nova/page.tsx>) | Ver a entrada e seus imports |
| `/produtos` | [page.tsx](<../../apps/web/app/(app)/produtos/page.tsx>) | RPC `get_products_overview`, `get_sku_curation_summary`, `get_sku_curation` |
| `/reposicao` | [page.tsx](<../../apps/web/app/(app)/reposicao/page.tsx>) | RPC `get_replenishment_overview`, `get_supplier_brands`. Tabelas `replenishment_settings`, `marketplace_accounts` |
| `/reposicao/configuracoes` | [page.tsx](<../../apps/web/app/(app)/reposicao/configuracoes/page.tsx>) | RPC `get_replenishment_reach`, `get_supplier_brands`. Tabelas `replenishment_settings` |
| `/skus/[skuId]` | [page.tsx](<../../apps/web/app/(app)/skus/[skuId]/page.tsx>) | RPC `get_sku_abc_curve`, `get_sku_sales_daily_by_marketplace`, `get_shopee_orders`, `get_sku_dashboard`, `get_sku_listings`, `get_stock_coverage`, `get_sku_timeline`, `get_fulfillment_overview`, `get_price_changes`, `get_sku_sales_breakdown`, `get_sku_shopee_listings`, `get_sku_sales_by_marketplace_account`. Tabelas `skus`, `ml_accounts`, `sku_cost_history`, `action_decisions`, `actions`, `organization_members` |

## Atendimento

Specs relacionados em `apps/web/e2e/` (sufixo `.spec.ts`) · atendimento, conhecimento.

| Rota | Entrada | Referências diretas de dados |
|---|---|---|
| `/atendimento` | [page.tsx](<../../apps/web/app/(app)/atendimento/page.tsx>) | RPC `get_support_metrics`. Tabelas `support_cases`, `support_case_links`, `listings`, `skus`, `ml_accounts` |
| `/atendimento/[caseId]` | [page.tsx](<../../apps/web/app/(app)/atendimento/[caseId]/page.tsx>) | Tabelas `support_cases`, `support_messages` com cursor de data e ID (D-665), `support_case_deadlines`, `support_case_events`, `support_reply_attempts`, `reply_templates` |
| `/atendimento/conhecimento` | [page.tsx](<../../apps/web/app/(app)/atendimento/conhecimento/page.tsx>) | Tabelas `knowledge_entries`, `profiles` |
| `/atendimento/metricas` | [page.tsx](<../../apps/web/app/(app)/atendimento/metricas/page.tsx>) | RPC `get_support_metrics` |
| `/atendimento/perguntas` | [page.tsx](<../../apps/web/app/(app)/atendimento/perguntas/page.tsx>) | `ml_accounts` e casos paginados com a primeira mensagem recebida por cartão (D-664). `support_reply_attempts` e `reply_templates` para a pergunta aberta |
| `/atendimento/templates` | [page.tsx](<../../apps/web/app/(app)/atendimento/templates/page.tsx>) | Tabelas `reply_templates` |

## Sessão e operação

Specs relacionados em `apps/web/e2e/` (sufixo `.spec.ts`) · configuracoes, contas, integracoes, saude, sincronizacao, usuarios, login, convite-aceite, cabecalhos, web-vitals.

| Rota | Entrada | Referências diretas de dados |
|---|---|---|
| `/configuracoes` | [page.tsx](<../../apps/web/app/(app)/configuracoes/page.tsx>) | RPC `get_settings_overview`. Tabelas `shopee_shops` |
| `/contas` | [page.tsx](<../../apps/web/app/(app)/contas/page.tsx>) | RPC `get_ml_account_cards`, `get_shopee_shop_catalog_counts`. Tabelas `shopee_shops` |
| `/integracoes` | [page.tsx](<../../apps/web/app/(app)/integracoes/page.tsx>) | RPC `get_sync_health`, `get_system_health`, `get_ai_monthly_cost_usd`. Tabelas `ml_accounts`, `marketplace_accounts`, `erp_import_batches`, `ai_runs`, `domain_events` |
| `/login` | [page.tsx](<../../apps/web/app/login/page.tsx>) | Ver a entrada e seus imports |
| `/saude` | [page.tsx](<../../apps/web/app/(app)/saude/page.tsx>) | RPC `get_system_health` |
| `/sincronizacao` | [page.tsx](<../../apps/web/app/(app)/sincronizacao/page.tsx>) | RPC `get_sync_health`, `get_processing_health`, `get_job_failures`. Tabelas `ml_accounts`, `domain_events`, `marketplace_accounts`, `shopee_shops` |
| `/usuarios` | [page.tsx](<../../apps/web/app/(app)/usuarios/page.tsx>) | RPC `get_organization_members`. Tabelas `organization_members`, `ml_accounts`, `user_account_permissions`, `shopee_shops`, `user_shopee_shop_permissions`, `organization_access_events` |

## Route handlers

| Caminho | Entrada | Método e uso |
|---|---|---|
| `/anuncios/exportar` | [route.ts](<../../apps/web/app/(app)/anuncios/exportar/route.ts>) | `GET` · Download de exportação |
| `/anuncios/shopee/exportar` | [route.ts](<../../apps/web/app/(app)/anuncios/shopee/exportar/route.ts>) | `GET` · Download de exportação |
| `/api/vitals` | [route.ts](<../../apps/web/app/api/vitals/route.ts>) | `POST` · Telemetria Web Vitals |
| `/auth/sign-out` | [route.ts](<../../apps/web/app/auth/sign-out/route.ts>) | `POST` · Encerramento de sessão |
| `/compras/[id]/export/pdf` | [route.ts](<../../apps/web/app/(app)/compras/[id]/export/pdf/route.ts>) | `GET` · Download de exportação |
| `/compras/[id]/export/xlsx` | [route.ts](<../../apps/web/app/(app)/compras/[id]/export/xlsx/route.ts>) | `GET` · Download de exportação |
| `/curva-abc/export/xlsx` | [route.ts](<../../apps/web/app/(app)/curva-abc/export/xlsx/route.ts>) | `GET` · Download de exportação |
| `/full/exportar` | [route.ts](<../../apps/web/app/(app)/full/exportar/route.ts>) | `GET` · Download de exportação |
| `/precos/export/xlsx` | [route.ts](<../../apps/web/app/(app)/precos/export/xlsx/route.ts>) | `GET` · Download de exportação |
| `/vendas/exportar` | [route.ts](<../../apps/web/app/(app)/vendas/exportar/route.ts>) | `GET` · Download de exportação |
| `/vendas/shopee/exportar` | [route.ts](<../../apps/web/app/(app)/vendas/shopee/exportar/route.ts>) | `GET` · Download de exportação |

O [mapa do projeto](PROJECT_MAP.md) explica como atualizar o inventário a partir de um diff.
