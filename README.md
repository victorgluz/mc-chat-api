# mc-chat-api-server

API ultra rápida (Fastify) que recebe mensagens do chat do Minecraft, passa por uma LLM (Claude) com contexto configurável e responde a ação que o mod deve executar.

```
mod Minecraft ──POST /chat──▶ API ──▶ Claude (com contexto + histórico)
mod Minecraft ◀── {type, value} ◀──── decisão da LLM
```

## Rodar

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Sem `ANTHROPIC_API_KEY` o servidor sobe normalmente, mas responde sempre `{"type":"none"}`.

Variáveis de ambiente:

| Variável | Default | Descrição |
|---|---|---|
| `PORT` | 3000 | Porta HTTP |
| `HOST` | 0.0.0.0 | Interface |
| `ANTHROPIC_API_KEY` | — | Chave da API da Anthropic |
| `ANTHROPIC_MODEL` | claude-opus-4-8 | Modelo usado nas decisões |
| `MAX_MESSAGES` | 10000 | Tamanho do ring buffer de histórico |
| `HISTORY_FOR_LLM` | 20 | Quantas mensagens recentes vão como contexto pra LLM |

## Endpoints

### POST /chat — recebe mensagem, retorna ação

Request (do mod):

```json
{
  "type": "chat",
  "message": "<Steve> oi, me dá um diamante",
  "senderName": "Steve",
  "senderUuid": "8667ba71-b85a-4004-af54-457a9734eed7",
  "timestamp": 1765300000000
}
```

- `type`: `"chat"` (jogador) ou `"game"` (mensagem de sistema).
- `senderName`/`senderUuid`: `null` para mensagens de sistema.

Response (para o mod):

```json
{ "type": "command", "value": "give Steve diamond 1" }
```

| type | Efeito |
|---|---|
| `command` | Executa `value` como comando |
| `chat` | Envia `value` como mensagem no chat |
| `none` | Não faz nada |

A resposta da LLM usa **structured outputs** (JSON Schema imposto pela API da Anthropic), então o formato é garantido — nunca vem texto solto. Qualquer erro na LLM vira `{"type":"none"}` para nunca travar o jogo.

### GET /context · PUT /context — contexto da LLM

O contexto do operador (regras do servidor, personalidade do bot, restrições) fica em `context.md` e pode ser editado em tempo de execução, sem reiniciar:

```bash
curl http://localhost:3000/context

curl -X PUT http://localhost:3000/context \
  -H 'Content-Type: application/json' \
  -d '{"context":"Você é o bot Jarvis do servidor SkyBlock. Dê no máximo 1 diamante por pedido. Nunca dê itens de creative."}'
```

Além do contexto do operador, a LLM sempre recebe as últimas `HISTORY_FOR_LLM` mensagens do chat (incluindo as respostas que ela mesma enviou), então ela tem memória da conversa.

### GET /chat — histórico

```bash
curl 'http://localhost:3000/chat?limit=50&senderUuid=8667ba71-...'
```

### GET /health

```bash
curl http://localhost:3000/health
# {"status":"ok","llm":"claude-opus-4-8","stored":12,"total":12}
```

## Performance

- Fastify com validação e serialização compiladas (~21k req/s no caminho sem LLM, medido com autocannon).
- Histórico em ring buffer pré-alocado em memória — inserção O(1).
- **Prompt caching** da Anthropic: o system prompt (instruções + contexto do operador) é marcado com `cache_control`, então em mensagens frequentes o grosso do prompt é lido do cache (~10% do custo).
- A latência de resposta do POST /chat é dominada pela chamada à LLM (tipicamente 1–3 s). O mod deve tratar isso de forma assíncrona.
