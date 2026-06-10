'use strict'

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const fastify = require('fastify')({ logger: false })
const OpenAI = require('openai')

const PORT = Number(process.env.PORT) || 8080
const HOST = process.env.HOST || 'localhost'
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES) || 10000
const HISTORY_FOR_LLM = Number(process.env.HISTORY_FOR_LLM) || 20
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
const CONTEXT_FILE = path.join(__dirname, 'context.md')

const DEFAULT_CONTEXT = `Você é um assistente dentro de um servidor de Minecraft.
Você recebe mensagens do chat e decide se deve agir.

Regras:
- Se um jogador pedir um item de forma razoável, dê o item com /give.
- Se alguém fizer uma pergunta ou conversar com você, responda pelo chat de forma curta e amigável.
- Para mensagens que não pedem nada de você, não faça nada.
- Nunca execute comandos destrutivos (/op, /ban, /stop, /kill em outros jogadores, etc).
`

let context = DEFAULT_CONTEXT
try {
  context = fs.readFileSync(CONTEXT_FILE, 'utf8')
} catch {
  fs.writeFileSync(CONTEXT_FILE, DEFAULT_CONTEXT)
}

const openai = process.env.NVIDIA_API_KEY
  ? new OpenAI({ apiKey: process.env.NVIDIA_API_KEY, baseURL: 'https://integrate.api.nvidia.com/v1' })
  : null
if (!openai) {
  console.warn('AVISO: NVIDIA_API_KEY não definida — todas as mensagens retornarão {type: "none"}')
}

// Documentação da API: Swagger UI em /docs (spec em /docs/json)
fastify.register(require('@fastify/swagger'), {
  openapi: {
    info: {
      title: 'mc-chat-api-server',
      description: 'Recebe mensagens do chat do Minecraft e decide ações (command/chat/none) via LLM',
      version: '1.0.0',
    },
  },
})
fastify.register(require('@fastify/swagger-ui'), { routePrefix: '/docs' })

// Schema que a LLM é obrigada a seguir (structured outputs)
const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['command', 'chat', 'none'],
      description:
        'command = executa value como comando do Minecraft; chat = envia value como mensagem no chat; none = não faz nada',
    },
    value: {
      type: 'string',
      description:
        'O comando (sem / inicial) ou a mensagem de chat. String vazia quando type é none.',
    },
  },
  required: ['type', 'value'],
  additionalProperties: false,
}

const BASE_SYSTEM = `Você controla um bot em um servidor de Minecraft via API.
A cada mensagem do chat você decide UMA ação:
- "command": executar um comando do servidor (ex: give Steve diamond 1). Use o nome do jogador, não @s, pois o comando roda pelo servidor/mod.
- "chat": enviar uma mensagem de texto no chat do jogo.
- "none": não fazer nada.

Mensagens com senderName null são mensagens de sistema do jogo (type "game"), não de jogadores.
Seja conservador: na dúvida, use "none". Mensagens de chat devem ser curtas (1 a 2 frases).`

// Ring buffer em memória: O(1) para inserir, sem realocação
const buffer = new Array(MAX_MESSAGES)
let head = 0
let total = 0

function pushMessage(msg) {
  const id = total++
  buffer[head] = { id, receivedAt: Date.now(), ...msg }
  head = (head + 1) % MAX_MESSAGES
  return id
}

function recentMessages(limit) {
  const stored = Math.min(total, MAX_MESSAGES)
  const out = []
  for (let i = 1; i <= stored && out.length < limit; i++) {
    out.push(buffer[(head - i + MAX_MESSAGES) % MAX_MESSAGES])
  }
  return out.reverse()
}

async function decideAction(incoming) {
  if (!openai) return { type: 'none', value: '' }

  const history = recentMessages(HISTORY_FOR_LLM)
    .map((m) => `[${m.type}] ${m.senderName ?? 'SISTEMA'}: ${m.message}`)
    .join('\n')

  const completion = await openai.chat.completions.create({
    model: MODEL,
    // O modelo é de reasoning (thinking não desliga): budget baixo segura a
    // latência e max_tokens cobre thinking + JSON final
    max_tokens: 2048,
    reasoning_budget: 1024,
    temperature: 0.2,
    top_p: 0.95,
    // Saída validada contra o schema (structured output OpenAI-compatible)
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'action', schema: ACTION_SCHEMA, strict: true },
    },
    messages: [
      {
        role: 'system',
        content: `${BASE_SYSTEM}\n\n## Contexto do servidor (configurado pelo operador)\n${context}`,
      },
      {
        role: 'user',
        content: `Histórico recente do chat:\n${history}\n\nNova mensagem (decida a ação para ela):\n[${incoming.type}] ${incoming.senderName ?? 'SISTEMA'}: ${incoming.message}`,
      },
    ],
  })

  const text = completion.choices[0]?.message?.content
  if (!text) return { type: 'none', value: '' }
  return JSON.parse(text)
}

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

const chatMessageSchema = {
  type: 'object',
  required: ['type', 'message', 'timestamp'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['chat', 'game'] },
    message: { type: 'string', minLength: 1, maxLength: 1024 },
    senderName: { type: ['string', 'null'], maxLength: 64 },
    senderUuid: { type: ['string', 'null'], pattern: UUID_PATTERN },
    timestamp: { type: 'integer', minimum: 0 },
  },
}

const actionResponseSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    value: { type: 'string' },
  },
}

const messageResponseItem = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    receivedAt: { type: 'integer' },
    type: { type: 'string' },
    message: { type: 'string' },
    senderName: { type: ['string', 'null'] },
    senderUuid: { type: ['string', 'null'] },
    timestamp: { type: 'integer' },
  },
}

// Rotas num plugin registrado DEPOIS do swagger: garante que o swagger já
// carregou e captura os schemas de todas as rotas na documentação
fastify.register(async function routes(fastify) {
  fastify.post('/chat', {
    schema: {
      summary: 'Recebe uma mensagem do chat e decide a ação',
      description: 'A LLM decide entre command (comando do servidor), chat (mensagem no chat) ou none.',
      tags: ['chat'],
      body: chatMessageSchema,
      response: { 200: actionResponseSchema },
    },
  }, async (request, reply) => {
    const body = request.body
    console.log(`[${body.type}] ${body.senderName ?? 'SISTEMA'}: ${body.message}`)
    pushMessage(body)

    try {
      const action = await decideAction(body)
      if (action.type !== 'command' && action.type !== 'chat') {
        return { type: 'none', value: '' }
      }
      // O modelo às vezes inclui a barra inicial apesar da instrução
      if (action.type === 'command') action.value = action.value.replace(/^\//, '')
      // Registra a própria ação no histórico para a LLM ter memória do que fez
      if (action.type === 'chat') {
        pushMessage({ type: 'chat', message: action.value, senderName: 'BOT', senderUuid: null, timestamp: Date.now() })
      }
      return action
    } catch (err) {
      // Nunca derruba o fluxo do jogo: erro na LLM vira "none"
      console.error('Erro ao decidir ação:', err.message)
      return { type: 'none', value: '' }
    }
  })

  fastify.get('/chat', {
    schema: {
      summary: 'Lista as mensagens mais recentes',
      tags: ['chat'],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
          senderUuid: { type: 'string', pattern: UUID_PATTERN },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            count: { type: 'integer' },
            messages: { type: 'array', items: messageResponseItem },
          },
        },
      },
    },
  }, (request, reply) => {
    const { limit, senderUuid } = request.query
    const stored = Math.min(total, MAX_MESSAGES)
    const messages = []
    for (let i = 1; i <= stored && messages.length < limit; i++) {
      const msg = buffer[(head - i + MAX_MESSAGES) % MAX_MESSAGES]
      if (!senderUuid || msg.senderUuid === senderUuid) messages.push(msg)
    }
    reply.send({ total, count: messages.length, messages })
  })

  // Contexto da LLM: consultar e atualizar em tempo de execução
  fastify.get('/context', {
    schema: {
      summary: 'Retorna o contexto atual da LLM (texto puro)',
      tags: ['contexto'],
    },
  }, (request, reply) => {
    reply.type('text/plain').send(context)
  })

  fastify.put('/context', {
    schema: {
      summary: 'Substitui o contexto da LLM',
      tags: ['contexto'],
      body: {
        type: 'object',
        required: ['context'],
        properties: { context: { type: 'string', minLength: 1, maxLength: 100000 } },
      },
    },
  }, async (request, reply) => {
    context = request.body.context
    await fs.promises.writeFile(CONTEXT_FILE, context)
    return { ok: true }
  })

  fastify.get('/health', {
    schema: {
      summary: 'Status do servidor e da LLM',
      tags: ['sistema'],
    },
  }, (request, reply) => {
    reply.send({
      status: 'ok',
      llm: openai ? MODEL : 'desabilitada (sem NVIDIA_API_KEY)',
      stored: Math.min(total, MAX_MESSAGES),
      total,
    })
  })
})

fastify.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log(`mc-chat-api-server ouvindo em ${address}`)
})
