# Fixtures de Perguntas

Payloads sem PII sensível, derivados dos exemplos públicos da documentação
oficial "Perguntas e Respostas" do Mercado Livre, consultada em 2026-08-25.

- `unanswered.json`: exemplo público de pergunta `UNANSWERED` por item.
- `answered.json`: exemplo público de pergunta `ANSWERED` com resposta `ACTIVE`.
- `banned-question.json`: exemplo público de pergunta `BANNED`, cujo texto vem vazio.
- `banned-answer.json`: exemplo público de resposta `BANNED`, cujo texto vem vazio.
- `under-review.json`: combinação mínima dos campos e do status `UNDER_REVIEW`
  documentados; a página lista o estado, mas não publica um payload completo
  específico para ele.

Os IDs e textos são dados de exemplo já publicados pelo próprio portal; nenhum
payload foi capturado de uma conta real da Speed Bikers.
