# Eventos e notificações em tempo real

> Dono documental de: regra evento -> notificação, severidade, agrupamento, transporte e preferências.
> Catálogo de `event_type` em `docs/API.md`. Schema em `docs/DATABASE.md`.
> Status: **estratégia aprovada e completa (Fase 7, notificações)**. Persistência + regra de destinatário (D-073), Central de Notificações (D-074), Realtime + toasts (D-075), preferências por usuário (D-076) — todos implementados em 2026-08-24. **Correção D-076 importante**: `notification_preferences` NÃO filtra mais `notification_recipients` (bug de D-073, corrigido antes de qualquer preferência real existir) — a Central de Notificações sempre mostra tudo, a preferência só controla o toast em tempo real, exatamente como a secao 1 abaixo sempre descreveu.

---

## 1. Cadeia

```text
mudança detectada pelo worker (diff, ledger, sync)
   -> domain_events            L2, append-only, dedup_key UNIQUE
   -> regra de severidade      @sb/domain/events, versionada, gravada na própria linha
   -> regra de destinatário    permissão por conta + preferências     [implementado, D-073]
   -> notifications + notification_recipients                        [implementado, D-073]
   -> Supabase Realtime                                               [implementado, D-075]
   -> toast (canto inferior direito)                                  [implementado, D-075]
   -> Central de Notificações (lista + lido/não lido)                 [implementado, D-074]
```

**O evento é sempre persistido.** Todo `domain_event` catalogado (já tem severidade atribuída por natureza) gera exatamente uma `notification`, com fan-out para quem tem acesso — "nem toda mudança precisa interromper alguém" acontece via `notification_preferences` (por usuário), não por deixar de criar a notificação: o registro na Central de Notificações continua existindo para consulta, só o alerta em tempo real é que respeita a preferência de cada um.

---

## 1.1 Pré-requisito — detectar a mudança antes de notificar

A camada de notificações NÃO é responsável por descobrir que um anúncio mudou.

Ela consome `domain_events` já confiáveis.

Para alterações de anúncio, o pipeline obrigatório é:

```text
snapshot/estado anterior confiável
   -> captura do estado atual
   -> diff determinístico
   -> domain_event durável
   -> regra de notificação
   -> notification / recipients
   -> entrega em tempo real
```

## 2. Severidade

Três níveis: **informativo**, **importante**, **crítico**.

A severidade é calculada por **regra versionada em `@sb/domain/events`**, nunca fixada na interface. Isso permite testar a regra e alterá-la sem tocar em componente visual.

A severidade padrão por tipo de evento está no catálogo de `docs/API.md`. A regra pode elevá-la conforme contexto — por exemplo, variação de preço acima de um limiar, ou ruptura em SKU de curva A.

---

## 3. Agrupamento — requisito, não enfeite

**Implementado em 2026-08-24 (D-075)** — `apps/web/components/notification-toasts.tsx`. Janela de agrupamento por `(event_type, ml_account_id)`, 5 minutos (`WINDOW_MS`, mesmo número deste exemplo).

Trinta alterações de preço da mesma conta em cinco minutos viram **um** toast com contador, não trinta popups.

**Sem agrupamento, o primeiro backfill vira uma avalanche e o usuário desliga a feature no primeiro dia.** É o modo mais provável de a funcionalidade nascer morta.

O toast é **resumo com ação**, exemplo real (rótulo de evento + diff, mesma leitura de `before`/`after` da Central de Notificações — `lib/event-format.ts`):

```text
Preço do anúncio alterado
OffRacer — Anúncio MLB123456789
R$ 399,90 → R$ 379,90
```

Com link direto pra entidade afetada quando a rota existe hoje (`sku` -> `/skus/[skuId]`; sem link morto pra `listing`/`order`, que ainda não têm tela própria — mesma regra de `docs/HANDOFF.md`, item 4). O histórico completo fica na Central de Notificações — todo toast agrupado (`count > 1`) linka pra lá em vez de uma entidade específica, já que representa vários eventos.

O contador é da JANELA inteira (5 min desde o primeiro evento do grupo), não só do que está visível: o toast individual some sozinho 8s depois do último evento (`DISMISS_MS`), mas reaparece atualizado se outro evento do mesmo grupo chegar depois — o contador nunca "esquece" um evento só porque o card sumiu da tela.

**Fora de escopo desta primeira versão, registrado para quando houver necessidade real**: dismiss diferenciado por severidade (crítico não expirar sozinho, por exemplo) — não implementado por não ser pedido explícito nem ter comportamento correto óbvio sem medir uso real primeiro.

---

## 4. Transporte

**Implementado em 2026-08-24 (D-075)** — **Supabase Realtime**, `postgres_changes` filtrado por `user_id` sobre `notification_recipients` (migration `20260824200000_enable_realtime_notification_recipients.sql`).

| Opção | Vantagem | Desvantagem |
|---|---|---|
| `postgres_changes` filtrado por usuário **(escolhida)** | Respeita RLS nativamente, zero infraestrutura nova, funciona no primeiro dia | Escala pior com muitos assinantes — irrelevante com um punhado de usuários internos |
| `broadcast` disparado por trigger | Mais eficiente em volume alto | Exige gerenciar canal e autorização manualmente |

**Migrar para `broadcast` somente se medir necessidade** — a documentação oficial da Supabase recomenda `broadcast` só acima de ~3000 assinantes concorrentes na mesma mudança, muito acima da realidade deste produto.

**Pendência resolvida (D-075)**: pesquisa confirmada ao vivo contra `docs.supabase.com/guides/realtime/postgres-changes` antes de implementar, não assumida de memória. `postgres_changes` autoriza CADA evento contra a RLS da tabela de origem, por assinante — a mesma `notification_recipients_select_own` (D-073) já usada na Central, sem policy nova em `realtime.messages` (isso é só pra Broadcast/Presence, que este projeto não usa). Único passo de infraestrutura: a tabela entrar na publication `supabase_realtime`.

---

## 5. Permissões

- Notificação respeita **permissão por conta**. Um usuário sem acesso à conta X nunca recebe evento da conta X.
- A garantia é de **RLS**, não da interface: `notification_recipients` tem policy por `user_id`, com teste negativo obrigatório.
- O filtro acontece na geração do destinatário **e** na leitura. Defesa em profundidade, porque notificação vazada é vazamento de dado comercial.

**Implementado em 2026-08-24 (D-073):** o fan-out (trigger `AFTER INSERT` em `domain_events`, `private.fan_out_notification`) já aplica esta regra na GERAÇÃO — evento organizacional alcança todo membro da organização, evento de conta alcança ADMIN (sempre) mais quem tiver `user_account_permissions` para aquela conta, mesma regra já usada para leitura de `domain_events` (D-054). A policy de leitura de `notifications` amarra a existir uma linha em `notification_recipients` — a defesa em profundidade descrita acima. Teste negativo em `packages/db/src/rls.integration.test.ts`.

Esta é a única regra que ainda filtra a CRIAÇÃO do `notification_recipients` — `notification_preferences` (secao 6) NÃO filtra mais desde D-076, só a permissão por conta acima.

---

## 6. Preferências

`notification_preferences` entra no schema **desde a Fase 2**, mesmo que a interface só apareça na Fase 7. É coluna barata agora e migration chata depois. **Schema criado em 2026-08-24 (D-073)**, **UI implementada em 2026-08-24 (D-076)** — `apps/web/app/notificacoes/preferencias`.

Granularidade: por usuário, por `event_type`, por severidade mínima e por conta — as quatro dimensões existem em `notification_preferences` (`event_type`/`ml_account_id` nuláveis como curinga, linha mais específica vence). Identidade da regra (evento + conta) é fixa depois de criada; severidade mínima e estado ativo/desativado são editáveis, o resto é apagar e recriar.

**Controla só o alerta em tempo real (toast) — nunca a Central de Notificações.** Correção importante feita em D-076: até então a trigger de fan-out (D-073) filtrava a criação de `notification_recipients` pela preferência, o que também apagava o item da Central pra quem desativou aquele tipo de evento — contradizia este mesmo parágrafo desde que foi escrito na Fase 0. Como a tabela nascia vazia (sem UI), o bug nunca teve efeito real; corrigido antes da primeira preferência de verdade existir. A avaliação da preferência mora inteiramente no cliente hoje (`apps/web/lib/notification-preferences.ts`, `shouldNotify`, consumida por `notification-toasts.tsx`) — sem nenhuma regra, tudo vira toast por padrão. Cada usuário gerencia a própria preferência direto sob RLS (`notification_preferences_all_own`), sem RPC.

---

## 7. Central de Notificações

**Lista + estado lido/não lido implementados em 2026-08-24 (D-074)** — `apps/web/app/notificacoes`, últimas 100 notificações do usuário, ordenadas por mais recente. "Marcar como lida" (por item) e "marcar todas como lidas" escrevem direto em `notification_recipients` sob RLS (`docs/ARCHITECTURE.md` secao 4 cita este caso nominalmente), sem RPC. Emblema de não lidas no cabeçalho (`Shell`).

- Histórico completo, com estado lido / não lido por usuário. **Feito.**
- Link para a entidade afetada **quando a rota existe** — hoje só `entity_type = "sku"` (`/skus/[skuId]`); `listing`/`order` ainda não têm tela de detalhe própria, aparecem como texto.
- Diff legível (`antes → depois`) só para os quatro tipos de evento com formato de `before`/`after` já documentado (`listing.price/title/available_quantity.changed`, `listing.status.paused`/`.reactivated`) — os demais mostram só o rótulo do evento.
- **Pendente:** filtro por severidade, conta e período (a lista de hoje é só cronológica); agrupamento por janela (item 5, é concern de toast/exibição em tempo real, não da lista histórica).
- Distinção entre alteração automática e manual **quando a origem puder ser identificada** — o campo `source` de `domain_events` carrega isso, ainda não exibido na lista (não pedido em D-074, cabe numa iteração de filtro).

---

## 8. Escopo excluído

Sem e-mail, sem push de navegador, sem WhatsApp, sem SMS. **In-app apenas.**

Notificação por canal externo traz um universo próprio de problemas — bounce, opt-out, rate limit de provedor, conformidade — e não está nos requisitos.

---

## 9. Relação com a Central de Ações

Notificação e ação são coisas diferentes e não devem se confundir:

- **Notificação** avisa que algo aconteceu. É efêmera na atenção, permanente no histórico.
- **Ação** é algo que alguém precisa decidir, com impacto estimado, responsável e resultado medido depois.

Um evento crítico pode gerar as duas. A maioria dos eventos gera apenas notificação, e muitos não geram nem isso.

*Motivo:* a V2 chegou a 5.243 alertas abertos. Cinco mil alertas não são cinco mil problemas — são uma tela que ninguém abre.

---

## 10. Central de Atendimento / SAC (Fase 7B, conceitual)

Registrado em 2026-08-24 (D-071), com fronteira fechada em D-084 e núcleo read-only de banco criado em D-085. A cadeia desta seção 1 não muda: eventos de atendimento selecionados (`support.question.received`, `support.claim.opened`, etc. — catálogo proposto em `docs/API.md` secao 9) são só mais `event_type` passando pela MESMA regra de severidade, permissão por conta e agrupamento já descritas acima. Nenhum produtor `support.*` foi implementado ainda.

`support_case_events` é auditoria detalhada e **não** alimenta notificações diretamente. Só uma transição de negócio promovida explicitamente a `domain_events support.*`, com `dedup_key`, entra no fan-out. Essa fronteira impede que refresh de status, leitura ou prazo técnico gere avalanche de toasts. Mediação/devolução preservam o mesmo `support_case_id` do claim; o link da notificação abre esse case único. Detalhe em `docs/DATABASE.md` e `docs/PRODUCT_REQUIREMENTS.md`.
