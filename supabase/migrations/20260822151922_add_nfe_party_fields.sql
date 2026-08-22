-- ============================================================
-- Ajuste de NF-e: CNPJ da própria organização + destinatário do documento.
--
-- Achado ao analisar o PRIMEIRO XML real de NF-e recebido do usuário
-- (2026-08-22): `ide/tpNF` sozinho não decide entrada/saída DO ESTOQUE DA
-- SPEED BIKERS -- ele reflete a operação do EMITENTE do documento. Uma
-- compra de fornecedor chega com tpNF=1 ("saída" do lado do fornecedor),
-- que é o OPOSTO de entrada no nosso estoque. A fonte de verdade correta é
-- comparar `emit`/`dest` do XML contra o CNPJ da própria organização.
--
-- `organizations` não tinha CNPJ nenhum registrado até agora -- nada
-- precisava disso antes da NF-e. `documents` já extraía `recipientCnpj`/
-- `recipientName` no parser (packages/domain/src/nfe/parse.ts), mas a
-- migration original esqueceu de persistir essas duas colunas -- corrigido
-- aqui, junto, por serem a mesma causa raiz.
-- ============================================================

alter table public.organizations
  add column cnpj text check (cnpj is null or cnpj ~ '^\d{14}$');

comment on column public.organizations.cnpj is
  'CNPJ (14 dígitos, só números) da própria organização -- usado para decidir ENTRADA/SAIDA de uma NF-e comparando contra emit/dest (docs/NFE.md secao 2.2).';

alter table public.documents
  add column recipient_cnpj text,
  add column recipient_name text;

comment on column public.documents.recipient_cnpj is
  'CNPJ do destinatário da NF-e (dest/CNPJ) -- extraído pelo parser desde o início, persistido a partir desta migration.';

-- Preenche o CNPJ real da Speed Bikers, confirmado no XML real recebido do
-- usuário (dest/CNPJ da nota de exemplo). Único jeito de a comparação
-- emit/dest funcionar para as NF-e já existentes.
update public.organizations
set cnpj = '27810945000206'
where slug = 'speed-bikers';
