# Arquitetura V3

## Infraestrutura definida

- Frontend: Vercel / Next.js
- Banco, Auth e RLS: Supabase V3 Dev em São Paulo (`sa-east-1`)
- Backend pesado, workers, webhooks e jobs: Google Cloud em São Paulo (`southamerica-east1`)
- Código: este mesmo repositório GitHub

## Princípios

- SKU é a entidade analítica central.
- Separar frontend, backend pesado e processamento assíncrono.
- Dados operacionais e históricos devem ser rastreáveis.
- Analytics devem ser pré-calculados quando fizer sentido para manter a interface rápida.
- IA interpreta evidências; não inventa causa.
- Estoque deve utilizar movimentos auditáveis e idempotentes.
- A `main` é referência V2; a branch `v3` é reconstrução limpa.

Este documento será expandido antes da primeira implementação funcional.
