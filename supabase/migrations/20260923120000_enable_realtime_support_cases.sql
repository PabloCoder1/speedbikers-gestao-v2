-- Central de Atendimento — atualização incremental da Caixa de Entrada.
--
-- Postgres Changes reaplica a RLS de support_cases para cada assinante.
-- A tabela já tem policy por acesso à conta; não se cria policy em
-- realtime.messages, que seria para Broadcast/Presence. O navegador não
-- recebe transcript nem credencial: ao chegar um INSERT/UPDATE ele só
-- revalida a página pelo caminho servidor já protegido por RLS.

alter publication supabase_realtime add table public.support_cases;
