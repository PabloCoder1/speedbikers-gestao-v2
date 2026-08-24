# Eventos e notificações em tempo real

> Dono documental de: regra evento -> notificação, severidade, agrupamento, transporte e preferências.
> Catálogo de `event_type` em `docs/API.md`. Schema em `docs/DATABASE.md`.
> Status: **estratégia aprovada. Persistência + regra de destinatário implementadas em 2026-08-24 (D-073)** — `notifications`/`notification_recipients`/`notification_preferences`, migration `20260824190000_create_notifications.sql`. Realtime, toasts, Central de Notificações (UI) e a interface de preferências continuam pendentes (`docs/HANDOFF.md`, itens 4/5/6).

---

## 1. Cadeia

```text
mudança detectada pelo worker (diff, ledger, sync)
   -> domain_events            L2, append-only, dedup_key UNIQUE
   -> regra de severidade      @sb/domain/events, versionada, gravada na própria linha
   -> regra de destinatário    permissão por conta + preferências     [implementado, D-073]
   -> notifications + notification_recipients                        [implementado, D-073]
   -> Supabase Realtime                                               [pendente]
   -> toast (canto inferior direito) + Central de Notificações        [pendente]
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

Janela de agrupamento por `(event_type, ml_account_id)`.

Trinta alterações de preço da mesma conta em cinco minutos viram **um** toast com contador, não trinta popups.

**Sem agrupamento, o primeiro backfill vira uma avalanche e o usuário desliga a feature no primeiro dia.** É o modo mais provável de a funcionalidade nascer morta.

O toast é **resumo com ação**, exemplo:

```text
OffRacer alterou o preço do SKU 5821 de R$ 399,90 para R$ 379,90.
```

Com link direto para o produto ou anúncio afetado. O histórico completo fica na Central de Notificações.

---

## 4. Transporte

**Supabase Realtime**, começando com `postgres_changes` filtrado por `user_id` sobre `notification_recipients`.

| Opção | Vantagem | Desvantagem |
|---|---|---|
| `postgres_changes` filtrado por usuário **(escolhida)** | Respeita RLS nativamente, zero infraestrutura nova, funciona no primeiro dia | Escala pior com muitos assinantes — irrelevante com um punhado de usuários internos |
| `broadcast` disparado por trigger | Mais eficiente em volume alto | Exige gerenciar canal e autorização manualmente |

**Migrar para `broadcast` somente se medir necessidade.**

> **Pendência:** confirmar a recomendação atual da Supabase para Realtime antes de implementar. A API mudou em ciclos recentes e não será assumida de memória.

---

## 5. Permissões

- Notificação respeita **permissão por conta**. Um usuário sem acesso à conta X nunca recebe evento da conta X.
- A garantia é de **RLS**, não da interface: `notification_recipients` tem policy por `user_id`, com teste negativo obrigatório.
- O filtro acontece na geração do destinatário **e** na leitura. Defesa em profundidade, porque notificação vazada é vazamento de dado comercial.

**Implementado em 2026-08-24 (D-073):** o fan-out (trigger `AFTER INSERT` em `domain_events`, `private.fan_out_notification`) já aplica esta regra na GERAÇÃO — evento organizacional alcança todo membro da organização, evento de conta alcança ADMIN (sempre) mais quem tiver `user_account_permissions` para aquela conta, mesma regra já usada para leitura de `domain_events` (D-054). A policy de leitura de `notifications` amarra a existir uma linha em `notification_recipients` — a defesa em profundidade descrita acima. Teste negativo em `packages/db/src/rls.integration.test.ts`.

---

## 6. Preferências

`notification_preferences` entra no schema **desde a Fase 2**, mesmo que a interface só apareça na Fase 7. É coluna barata agora e migration chata depois. **Schema criado em 2026-08-24 (D-073)** — atrasado da Fase 2 até agora, corrigido junto com a persistência de `notifications`.

Granularidade: por usuário, por `event_type`, por severidade mínima e por conta — as quatro dimensões já existem em `notification_preferences` (`event_type`/`ml_account_id` nuláveis como curinga, linha mais específica vence).

**Sem UI ainda** (Fase 7, item 6, `docs/HANDOFF.md`) — a tabela nasce vazia, e o fan-out trata "sem preferência" como "notificar" por padrão. Quando a UI existir, cada usuário gerencia a própria preferência direto sob RLS (`notification_preferences_all_own`), sem RPC.

---

## 7. Central de Notificações

- Histórico completo, com estado lido / não lido por usuário.
- Filtro por severidade, conta e período.
- Link para a entidade afetada.
- Distinção entre alteração automática e manual **quando a origem puder ser identificada** — o campo `source` de `domain_events` carrega isso.

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

Registrado em 2026-08-24 (D-071). A cadeia desta seção 1 não muda: os eventos de atendimento (`support.question.received`, `support.claim.opened`, etc. — catálogo proposto em `docs/API.md` secao 9) são só mais `event_type` passando pela MESMA regra de severidade, permissão por conta e agrupamento já descritas acima. Nenhuma arquitetura nova. Detalhe do requisito em `docs/PRODUCT_REQUIREMENTS.md`.
