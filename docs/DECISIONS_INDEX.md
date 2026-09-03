# Índice de decisões — Speed Bikers Gestão V3

> **Arquivo gerado.** Não edite à mão: rode `pnpm docs:index`.
> A fonte é `docs/DECISIONS.md`, que continua sendo o documento normativo.

## Como usar

Não leia `DECISIONS.md` inteiro (são mais de 600 KB). Ache aqui o `D-xxx`
relevante para a tarefa e leia **apenas** aquela seção, por exemplo:

```bash
grep -n "^## D-171" -A 40 docs/DECISIONS.md
```

Decisões registradas: **232** (D-001 a D-234).

## Por domínio

### atendimento (33)

- **D-005** — Dados antes de IA
- **D-009** — Copiloto contextual
- **D-021** — Copiloto por tool calling determinístico
- **D-039** — Marca vem da coluna `Categorias`, normalizada
- **D-070** — Auditoria dos serviços implantados contra a infraestrutura real (item P0 do Checkpoint pré-Fase 7): tudo em dia
- **D-078** — Ação contextual "O que aconteceu?": primeira fatia, zero lógica nova
- **D-079** — Sugestões de features: captura + Central de Sugestões, estruturação por IA continua pendente
- **D-084** — Modelo unificado de atendimento preserva a identidade de cada canal; mediação/devolução são facetas do claim
- **D-085** — Núcleo read-only de atendimento nasce isolado da integração externa, com escopo físico por conta e eventos append-only
- **D-095** — Detalhe do atendimento: a conversa aparece, e `body_state` nunca vira bolha em branco
- **D-104** — Claims na Caixa de Entrada, e a mediação NÃO é `type = "mediations"`
- **D-105** — O painel de construção mentia em sete pontos, e a correção não é atualizá-lo: é não ter lista escrita à mão
- **D-106** — Transcript do claim: sem `id` no payload, a chave TEM de ser fingerprint
- **D-107** — Prazos do claim: duas fontes remotas, e o cancelamento é a parte que ninguém lembra
- **D-111** — Templates de resposta: inserir é pré-preencher, nunca enviar
- **D-112** — As duas ferramentas de geração do Copiloto: sugerir resposta e estruturar sugestão
- **D-117** — Dois defeitos P0 achados por auditoria: a Central de Ações quebrada pela própria ação de SAC, e o envio de resposta sem fronteira de conta
- **D-120** — Trinta blocos de features viram roadmap: o que a auditoria mediu antes de aceitar qualquer um deles
- **D-129** — `brand` não é marca, é categoria: a marca real do fornecedor ganha coluna própria
- **D-133** — Curadoria do catálogo: `false` deixa de significar duas coisas ao mesmo tempo
- **D-135** — `stock.balance.diverged` significava duas coisas opostas, e a severidade mentia para uma delas
- **D-149** — Custo de simulacao separado do cadastrado, e o custo passa a ter historia
- **D-177** — O contexto dos agentes virou problema de engenharia, e o bootstrap caiu de 1,2 MB para 7,6 KB
- **D-184** — A unica leitura do caminho vivia na janela em que o pedido esta sem itens
- **D-187** — Uma linha de `stock_movements` nao e telemetria: e o saldo
- **D-199** — 485 mil escritas por dia para atualizar duas linhas
- **D-200** — O cast escondia quais guardas eram reais, e foi o compilador que separou
- **D-201** — "4xx a descarta sem repetir" e falso, e custou 2.234 execucoes em 7 dias
- **D-215** — Um checkbox que mentia ha uma semana, e uma secao que era o segundo dono da verdade
- **D-223** — O que significa "V3 100%", e a auditoria de checkbox que veio junto
- **D-229** — A varredura de custos falhava em TODO pedido real, e repetia o fracasso oito vezes por dia
- **D-231** — A Central de Integracoes compoe e aponta: tres perguntas por integracao, e configuracao nunca e verde
- **D-232** — A revisao adversarial de D-231: uma lista com dois consumidores, e o defeito que so aparece no segundo usuario

### banco/rls (25)

- **D-012** — Modelo A: `web` lê o Supabase diretamente sob RLS
- **D-014** — Cloud Tasks é a fila; o Postgres registra o executado
- **D-015** — Payload bruto no Cloud Storage, nunca em coluna do Postgres
- **D-062** — Filtros salvos: por USUÁRIO, jsonb genérico, escrita só via RPC — achado de GRANT no caminho
- **D-066** — Auditoria de GRANTs de tabelas antigas (item P0 do Checkpoint pré-Fase 7): 23 tabelas com INSERT/UPDATE/DELETE revogado de `authenticated`
- **D-071** — Central de Atendimento/SAC Mercado Livre vira Fase 7B; Copiloto sugere texto, nunca envia; Base de Conhecimento é SQL, não RAG
- **D-074** — Central de Notificações: lista + lido/não lido, Server Action direta sob RLS, sem RPC
- **D-092** — Os ~9.800 "erros" diários do Postgres eram a idempotência funcionando; o problema era enterrarem o erro de verdade
- **D-094** — Triagem do atendimento é RPC transacional, e não escrita direta sob RLS
- **D-098** — GRANTs excessivos reintroduzidos depois de D-066: revoga e ganha um teste-guarda permanente
- **D-113** — Base de Conhecimento Validada: SQL determinístico, validação humana, e o Copiloto ganha evidência de verdade
- **D-114** — O chat do Copiloto: planner por tool use, streaming de verdade, e nenhuma SQL gerada por LLM
- **D-130** — O teste-guarda de GRANTs nunca passou, e a razão é de catálogo: `TRUNCATE` não tem RLS por trás
- **D-131** — O PostgREST corta em 1.000 linhas sem avisar, e isso corrompeu o saldo de estoque de produção
- **D-137** — Comparação de período no gráfico, e o alinhamento por índice que estava certo por sorte
- **D-150** — Priorizacao de compras: a primeira derivacao SQL da formula canonica, com teste de equivalencia
- **D-168** — Dashboard 360º do Anuncio: o destino individual nasce em secoes, com read model somado em SQL
- **D-181** — A RLS deixa de ser avaliada uma vez por linha
- **D-183** — O CTE que o Postgres decidiu nao materializar, e o contador que contava a pagina
- **D-185** — Nao era o PostgREST: era o round trip
- **D-192** — O tipo gerado nao conhece a RLS, e por isso o cast estava certo
- **D-198** — A triagem de indices nao produziu indice nenhum, e o motivo de cada metade e diferente
- **D-207** — A migration que existia so no banco volta para o git
- **D-225** — A aba Full do SKU sai sem SQL novo, e a suite cobrou duas armadilhas de ambiente
- **D-228** — A aba Decisoes fecha as nove, e a prova do embed e a paridade das policies, nao o texto delas

### estoque (19)

- **D-001** — Mesmo repositório, branch V3 limpa
- **D-002** — Repositório é a memória oficial
- **D-006** — Estoque auditável
- **D-019** — Ledger é o único escritor do estoque local
- **D-029** — Em divergência de estoque, o UpSeller vence, com ajuste auditável
- **D-038** — O saldo do UpSeller é estoque real
- **D-052** — Reversão de estoque por cancelamento reverte o movimento gravado, não recalcula dos itens atuais
- **D-056** — Conferência ledger × projeção só detecta e alerta, nunca corrige; reusa `stock.balance.diverged`
- **D-061** — "Vendas perdidas estimadas" fica ADIADO — o ledger não tem entrada de saldo inicial, então não há como detectar QUANDO uma ruptura começou
- **D-127** — Estoque virtual é deliberado: a Fase 5D destrava, mas com outro desenho
- **D-139** — Estoque enriquecido, e a segunda coluna fiscal que mente sobre a rota de compra
- **D-141** — Filtros padronizados, e a medicao de exposicao do repositorio publico
- **D-144** — Configuracao de reposicao: a fundacao da 5D, e a recusa como contrato
- **D-146** — Estoque real aproveitavel: a definicao que faltava, e as duas honestidades dela
- **D-151** — Da cobertura para o pedido: a ponte que encurta o caminho, nunca a decisao -- FASE 5D COMPLETA
- **D-166** — Margem operacional: so sobre pedidos COBERTOS, cobertura declarada -- o item de Vendas COMPLETO
- **D-167** — Movimentacoes: o ledger vira extrato legivel, e o EXPLAIN reprovou duas versoes
- **D-173** — Central Full: o GRAO do Full estava errado em duas leituras, e isso aparecia como fila de trabalho falsa
- **D-204** — Tres definicoes de "Full atual", e as tres devolviam o mesmo numero

### interface (16)

- **D-030** — Retenção do payload bruto: 90 dias quente mais arquivamento frio
- **D-072** — Motor de diff de `listings`: fecha o pré-requisito crítico da Fase 7 (preço, título, status, quantidade disponível)
- **D-090** — Caixa de Entrada é UMA tela com filtros, não seis rotas; e o login perdia a query string de qualquer tela filtrada
- **D-119** — Vinculação manual livre: o requisito P1 mais antigo aberto, e o que a revisão adversarial mudou nele
- **D-143** — Saude da sincronizacao por recurso, e os dois problemas de producao que a tela antiga escondia
- **D-147** — Sugestao de compra auditavel: a composicao das tres pecas, e a divida do gerador quitada
- **D-169** — Abas do Dashboard de SKU: progressive disclosure que tambem economiza consulta, e a primeira tela VISTA
- **D-175** — Administracao de Usuarios: a tela e a parte menos importante, e a revisao adversarial achou quatro defeitos meus
- **D-178** — Escrita critica que falha nao pode deixar o handler seguir
- **D-189** — Grava e so entao apaga: o pre-requisito que deixou o caminho mais seguro do que era
- **D-190** — A pagina vira a unidade de escrita
- **D-194** — O filtro de marcas escondia 10 das 19, e eu tinha chamado isso de cosmetico
- **D-195** — O waterfall que se paga em toda tela estava no cabecalho, e a varredura quase nao olhou la
- **D-224** — O Dashboard de SKU encolhe de 11 abas para 9, e as duas que saem tem motivo
- **D-226** — A aba Precos sai por reuso, e o barato so apareceu porque a forma obvia foi MEDIDA
- **D-234** — O defeito que D-119 achou, adiou e ninguem colheu: 26 telas quebravam no segundo usuario

### mercado-livre (39)

- **D-017** — Um fato diário por anúncio + dois rollups derivados
- **D-018** — Full é espelho do Mercado Livre, não ledger
- **D-027** — Carga inicial: backfill do ML mais ETL do insubstituível
- **D-032** — Visitas, conversão e Ads entram na Fase 5B
- **D-036** — Uma fila do Cloud Tasks por conta do Mercado Livre
- **D-037** — Vínculo de anúncio restrito ao Mercado Livre
- **D-041** — Autorização multi-conta confirmada: OAuth padrão por conta, feito pelo ADMIN
- **D-042** — Rate limit do Mercado Livre sem número oficial: filas mantêm valor conservador e ajustam por observação
- **D-043** — Validação de origem do webhook por allowlist de IP
- **D-044** — Webhook: sem tabela de landing; o corpo da Cloud Task é o registro da notificação
- **D-045** — IP confiável do webhook é o penúltimo do `X-Forwarded-For`
- **D-046** — Cifra dos tokens do Mercado Livre: AES-256-GCM, chave em variável de ambiente
- **D-049** — OAuth do Mercado Livre usa PKCE S256 e guarda o verifier cifrado
- **D-054** — `domain_events.ml_account_id` aceita NULL para eventos organizacionais
- **D-059** — Visitas e conversão entram na Fase 5B; Ads fica ADIADO — evidência de esforço, não de dado
- **D-088** — O produtor do tópico `questions` mora no ACK da `api`, não no worker que consome `sync.webhook.received`
- **D-091** — O webhook do Mercado Livre NUNCA foi chamado: o marco do Fast Path da Fase 3 nunca foi verdade em produção
- **D-093** — A allowlist do webhook era contornável por um header, e rejeitaria toda notificação legítima: o IP confiável é o ÚLTIMO do `X-Forwarded-For`
- **D-096** — Envio de resposta: a primeira escrita do projeto no Mercado Livre, e o único job que NÃO pode retentar
- **D-101** — O webhook VIVE: a primeira hora de tráfego real revelou três contratos errados
- **D-121** — A V3 passa a saber quais anúncios existem: enumeração pelo catálogo real
- **D-122** — A fila de anúncios sem vínculo é DERIVADA, não materializada: `link_candidates` não recebe o Mercado Livre
- **D-123** — Venda de anúncio COM variação volta a contar: R$ 469.593,20 que a tela escondia
- **D-124** — Visitas passam a enumerar o catálogo ativo: mais cobertura com MENOS chamadas
- **D-138** — Dashboard de Anuncios, e a SEXTA ocorrencia do truncamento de 1.000 linhas
- **D-152** — Fase 6B comeca: o ruido medido como resolvido, e a correlacao alcanca anuncio e pedido
- **D-156** — Rate limit de visits: cada tentativa passa a somar progresso, e a rajada ganha espacamento
- **D-160** — Preflight do relist: fail-safe por desenho -- snapshot ilegivel reprova, nunca presume
- **D-161** — O fio do relist comeca pela CRIACAO: a api autoriza e enfileira, o worker captura e avalia, nada destrutivo acontece
- **D-162** — O executor do relist: re-entrante por ESTADO, e a janela sem idempotencia atravessada sem mentir
- **D-163** — Remapeamento pos-relist: transacao unica, e variacao renovada vira trabalho HUMANO
- **D-164** — Medicao 7/15/30 do relist: reuso LITERAL de D-065 -- FASE 9 COMPLETA NO BACKEND
- **D-170** — Visitas e conversao entram no catalogo, e catalogar revelou que a conversao estava errada em TRES lugares
- **D-171** — O 429 das visitas: a defesa inteira estava no eixo que o Mercado Livre nao limita
- **D-179** — Topico de webhook sem consumidor deixa de virar Cloud Task
- **D-203** — O 429 do snapshot de visitas e real, e o dano que eu registrei nao era
- **D-220** — O caminho de pedidos, enfim medido: 17 a 28x na janela, e ZERO no webhook
- **D-222** — O expurgo do entulho de webhook: limpeza unica, nao politica de retencao
- **D-230** — O snapshot do Full morreu no dia em que a escrita passou a abortar, e a causa era dois anuncios com um estoque

### outros (38)

- **D-004** — SKU como entidade central
- **D-007** — UX com progressive disclosure
- **D-008** — Eventos e notificações
- **D-010** — Evitar infraestrutura prematura
- **D-011** — Monorepo pnpm + Turborepo
- **D-016** — Um `domain_events` com `before`/`after`; sem tabelas de snapshot
- **D-024** — OIDC serviço-a-serviço
- **D-025** — Três ambientes: local, development, production
- **D-026** — Vitest com descoberta automática e quatro regras de teste
- **D-028** — UpSeller permanece como ERP; a V3 reconstrói o importador
- **D-031** — `organization_id` em todas as tabelas
- **D-035** — TypeScript 6.0.3, não 7.x
- **D-051** — Chave suja usa janela de minuto; ID diário fixo perde atualizações
- **D-053** — Direção da NF-e (ENTRADA/SAIDA) compara emit/dest contra o CNPJ da organização, nunca `ide/tpNF` sozinho
- **D-055** — TRANSITO nasce ao marcar o pedido de compra `ORDERED`, fecha em `RECEIVED`/`CANCELLED`; nunca gera LOCAL
- **D-081** — Bug real de produção: get_sku_sales_baseline multiplicava linhas para SKU vendido em duas contas
- **D-099** — Ator de tabela append-only: `on delete restrict`, fechando D-094 e o gêmeo que D-094 não viu
- **D-102** — Respondida fora da V3 não fica "NOVO" para sempre: transição automática guardada pela atividade remota
- **D-103** — A instrumentação de D-101 pagou-se em horas: `seller_max_message_length` chega como ZERO
- **D-125** — Desfazer vínculo + histórico auditável, e um furo de escrita que estava aberto desde a Fase 2
- **D-158** — Visao "hoje": le orders ao vivo E sinaliza -- as duas metades da alternativa de 5C.4
- **D-172** — Central de Precos: mostrar o que mudou sem fingir que se sabe o efeito
- **D-180** — O papel ganha escopo de organizacao, e o predicado sem escopo deixa de existir
- **D-182** — O inventario do P0-E nao achou o furo que procurava, e achou outro
- **D-188** — O embed que so um teste de integracao consegue provar
- **D-191** — A varredura das projecoes: 33 aceitas, 26 formas conferidas, e a guarda que faltava
- **D-193** — A varredura do truncamento: dois cortes vivos, e um a 16 linhas de comecar
- **D-197** — O guarda de D-195 estava cego para quatro classes, e quem mostrou foi uma varredura que LEU o codigo
- **D-202** — Falha definitiva passa a responder 200, e o 200 nao e fingir sucesso
- **D-205** — O relatorio de saude carrega as armadilhas junto dos numeros
- **D-206** — O mesmo ataque separa os quatro casts, e a regra nao era "depende"
- **D-209** — O escopo que faltava tinha uma terceira saida, e o guarda ao lado estava vazio
- **D-210** — O DELETE que ninguem chamava atravessava a blindagem que protege o segredo
- **D-211** — A torneira que faltava, e os dois bancos discordavam sobre ela
- **D-212** — A conta ganha autor, e o caminho revelou o que D-210 tinha quebrado sem notar
- **D-213** — Como atualizar o contrato gerado sem perder as correcoes manuais
- **D-218** — A retencao nao era o problema: 335 mil linhas custavam 1,1 s por causa de UMA consulta
- **D-233** — Hub de Configuracoes: a resposta e APONTAR, e o que torna isso seguro e o Hub nao saber editar

### processo/docs (1)

- **D-214** — O ROADMAP passou do budget porque 62% dele era narrativa de item pronto

### vendas/métricas (13)

- **D-023** — Catálogo de métricas normativo
- **D-033** — Tela âncora: Dashboard de vendas Geral e por Conta
- **D-048** — Checkpoint de pedidos usa `date_last_updated`, não `last_updated`
- **D-050** — Métricas de venda usam status pago, receita bruta e compra por pack
- **D-057** — Pós-venda (Claims/Returns): reversão só quando devolução TOTAL do item; parcial vira alerta, não cálculo
- **D-063** — Diagnóstico de anomalia de venda: baseline por MESMO dia da semana, |z|>=2, correlação com `domain_events` de SKU
- **D-097** — Ingestão de Mensagens pós-venda: a conversa como unidade, e um contrato permissivo de propósito
- **D-115** — Métricas de SAC com definição canônica, e o filtro de SLA que D-107 destravou
- **D-136** — Métrica trocável no gráfico de vendas: a Fase 5C começa pelo dado que já viajava e era descartado
- **D-140** — Curva ABC com escopo e criterio, e a SETIMA ocorrencia do truncamento (a primeira que corrompe uma estatistica)
- **D-157** — Metricas 5C de vendas: cancelamento sai do L1 de proposito, e a ressalva vira parte do card
- **D-165** — Custos por pedido: as fontes da margem operacional persistidas, e NULL nunca vira zero
- **D-227** — A aba Vendas: tres perguntas, um round trip, e a soma que precisou ser medida antes de ser somada

### worker/infra (48)

- **D-003** — Infraestrutura principal
- **D-013** — `api` e `worker` como dois serviços Cloud Run
- **D-020** — SKU resolvido e gravado na persistência do pedido
- **D-022** — Infraestrutura por scripts `gcloud` versionados; Terraform na Fase 8
- **D-034** — Exportação de pedido de compra: Excel é o formato principal
- **D-040** — ETL da V2 (D-027): descartado por evidência medida, exceto compras
- **D-058** — `listings` é UMA tabela (não três), projeção mutável — achado ao inspecionar o banco real da V2
- **D-060** — Busca Universal (Command Palette): cinco entidades com destino real; "Filtros salvos" e Central de Ações ficam de fora
- **D-064** — Central de Ações: severidade espelha confiança, worker escreve direto (sem RPC), impacto é `|Δunidades| x preço médio`
- **D-065** — Memória de decisões: mesma função de snapshot para baseline e outcome, medição histórica fixa, ação sem SKU não bloqueia
- **D-067** — Auditoria de erro `.error` do Supabase client não abortado (item P0 do Checkpoint pré-Fase 7): 34 pontos achados, corrigidos os que arriscavam corromper dado de negócio
- **D-068** — Navegação do Shell agrupada por categoria (item P1 do Checkpoint pré-Fase 7); colapso do dropdown virou regra CSS explícita, não UA stylesheet implícita
- **D-069** — Playwright nos fluxos críticos (item P0 do Checkpoint pré-Fase 7 e da Fase 5B): login, página do produto, conferência de NF-e, pedido de compra
- **D-073** — Persistência de notificações: fan-out por trigger em `domain_events`, não RPC nem código de aplicação
- **D-075** — Realtime + toasts: pesquisa oficial confirmada ao vivo, agrupamento por janela com contador que sobrevive ao toast sumir
- **D-076** — Preferências por usuário (UI) + correção de D-073: preferência nunca mais apaga a Central de Notificações
- **D-077** — Copiloto: ferramentas determinísticas + `ai_runs`, sem LLM ainda (decisão de escopo deliberada)
- **D-080** — Simulador de decisão: mesma fórmula já em produção, três incógnitas diferentes
- **D-082** — Copiloto: modelo, orçamento e política de custo decididos pelo usuário
- **D-083** — Fase 7B: APIs oficiais de Perguntas/Mensagens confirmadas; ingestão read-only antes de resposta
- **D-086** — Perguntas ganham contrato externo, projeção pura e persistência idempotente antes do adaptador de rede
- **D-087** — Detalhe de uma Pergunta entra por job próprio, com identidade da conta validada antes da escrita
- **D-089** — Reconciliação de Perguntas recorta por `status=UNANSWERED` porque a API não oferece filtro de data nem ordenação garantida
- **D-100** — Aviso de orçamento de IA: a pendência mais antiga do projeto, fechada com um evento mensal deduplicado
- **D-108** — Reconciliação de Reclamações: aqui existe janela de verdade, ao contrário de Perguntas
- **D-109** — A reconciliação de D-108 nunca funcionou: `sort` foi suposição minha, e a evidência estava sendo jogada fora
- **D-110** — Notificações de atendimento, fatia 1: um evento só, e a medição decidiu quase tudo
- **D-116** — SAC vira sinal: padrões na Central de Ações e evidência no Diagnóstico. Fase 7B completa.
- **D-118** — A CI vermelha de D-117 expôs dois defeitos que não eram meus: a terceira ocorrência do padrão de D-099 e um teste que nasceu impossível de passar
- **D-126** — A supressão que faltava: decisão humana não é desfeita pela planilha
- **D-128** — Integridade de vinculações: a fila não pode ser acreditada por si mesma
- **D-132** — O alvo da reconciliação é o snapshot ROLADO PARA A FRENTE, não o retrato congelado
- **D-134** — O banco andou e o código ficou: o descompasso que quebrou a reconciliação, e o reparo que ele acidentalmente preservou
- **D-142** — A CI voltou e cobrou a conta dos 17 commits: quatro defeitos, um deles quebrando /produtos
- **D-145** — Tendencia deterministica -- e o buraco de recalculo que fazia junho mentir em TODAS as telas
- **D-148** — Estados operacionais calculados: todos os limiares vem da politica, nenhuma constante inventada
- **D-153** — Timeline de evidencias: historia nao edita o passado
- **D-154** — Atalhos operacionais na Central de Acoes: so se aponta para tela que existe
- **D-155** — IA explicando a ACAO: o vocabulario obrigatorio vira instrucao, e a leitura da evidencia vira uma so -- FASE 6B COMPLETA
- **D-159** — Fase 9 abre pelo MODELO: idempotencia vira constraint, e o estado que exige gente tem nome
- **D-174** — Dashboard de Fornecedor: o relacionamento real e o que foi COMPRADO, e so isso
- **D-176** — Saude do Sistema: a tela responde a pergunta que esta sessao precisou fazer varias vezes
- **D-186** — As leituras viram uma por pagina; as escritas ficam uma por pedido, e isso e a decisao
- **D-208** — O item que faltava nao tinha conserto, e o defeito era o silencio
- **D-216** — A Busca Universal alcanca as entidades novas, e dois destinos dela tinham envelhecido
- **D-217** — Incidente: a representacao virou valor, e 13 horas de sincronizacao pararam
- **D-219** — O frescor de /saude passa a ser contra a cadencia, e o incidente de ontem vira teste
- **D-221** — A garantia append-only de job_runs nao tinha guarda, e eu ia precisar dela

