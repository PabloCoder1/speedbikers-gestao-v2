# Eventos e notificações em tempo real

> Dono documental de: regra evento -> notificação, severidade, agrupamento, transporte e preferências.
> Catálogo de `event_type` em `docs/API.md`. Schema em `docs/DATABASE.md`.
> Status: **estratégia aprovada.** Implementação na Fase 7.

---

## 1. Cadeia

```text
mudança detectada pelo worker (diff, ledger, sync)
   -> domain_events            L2, append-only, dedup_key UNIQUE
   -> regra de severidade      @sb/domain/events, versionada
   -> regra de destinatário    permissão por conta + preferências
   -> notifications + notification_recipients
   -> Supabase Realtime
   -> toast (canto inferior direito) + Central de Notificações
```

**O evento é sempre persistido; a notificação é opcional.** Nem toda mudança merece interromper alguém, mas toda mudança merece ficar registrada — porque o evento também é evidência para o diagnóstico.

---

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

---

## 6. Preferências

`notification_preferences` entra no schema **desde a Fase 2**, mesmo que a interface só apareça na Fase 7. É coluna barata agora e migration chata depois.

Granularidade: por usuário, por `event_type`, por severidade mínima e por conta.

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
