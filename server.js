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

const DEFAULT_CONTEXT = `Você é um assistente dentro de um servidor de Minecraft (Java Edition 1.21.8).
Você recebe mensagens do chat e decide se deve agir.

Regras:
- Atenda pedidos razoáveis de itens (máximo 64 por pedido).
- Tarefas no mundo (minerar/coletar, ir a coordenadas, seguir alguém) são feitas com as ferramentas do Baritone.
- Se alguém fizer uma pergunta ou conversar com você, responda de forma curta e amigável.
- Para mensagens que não pedem nada de você, não faça nada.
- Nunca execute ações destrutivas contra jogadores.
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

// Ações disponíveis como ferramentas tipadas: o modelo escolhe uma (ou
// nenhuma) e o servidor traduz para a ação {type, value} que o mod executa
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'give',
      description: 'Dá um item a um jogador via /give do servidor',
      parameters: {
        type: 'object',
        properties: {
          player: { type: 'string', description: 'Nome do jogador (nunca @s/@p)' },
          item_id: {
            type: 'string',
            description:
              'ID oficial de ITEM do Java Edition 1.21.8: inglês, snake_case, sem prefixo minecraft: (ex: diamond, iron_pickaxe, golden_apple, oak_log)',
          },
          quantity: { type: 'integer', minimum: 1, maximum: 64, description: 'Quantidade (padrão 1)' },
        },
        required: ['player', 'item_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'baritone_mine',
      description: 'Minera/coleta blocos no mundo com o Baritone (pedidos como "pega madeira", "cava diamante")',
      parameters: {
        type: 'object',
        properties: {
          block_ids: {
            type: 'array',
            items: { type: 'string' },
            description:
              'IDs oficiais de BLOCO do Java Edition 1.21.8 em snake_case, completos (ex: madeira -> ["oak_log"], pedra -> ["stone"]). Para minérios inclua a variante deepslate (ex: ["diamond_ore", "deepslate_diamond_ore"])',
          },
        },
        required: ['block_ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'baritone_goto',
      description: 'Anda até coordenadas com o Baritone',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          z: { type: 'integer' },
        },
        required: ['x', 'y', 'z'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'baritone_follow',
      description: 'Segue um jogador com o Baritone (pedidos como "me segue", "vem comigo")',
      parameters: {
        type: 'object',
        properties: { player: { type: 'string', description: 'Nome do jogador a seguir' } },
        required: ['player'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'baritone_stop',
      description: 'Para a tarefa atual do Baritone (pedidos pra parar, cancelar, "esquece")',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'say',
      description: 'Envia uma mensagem curta (1 a 2 frases) no chat do jogo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
]

// Validação defensiva: os argumentos da LLM viram comando executado no servidor
const SAFE_MC_ID = /^[a-z0-9_]+$/
const SAFE_PLAYER = /^[A-Za-z0-9_]{1,16}$/

// Minérios que têm variante deepslate no 1.21.8
const DEEPSLATE_ORES = new Set([
  'coal_ore', 'copper_ore', 'diamond_ore', 'emerald_ore',
  'gold_ore', 'iron_ore', 'lapis_ore', 'redstone_ore',
])

// O modelo às vezes manda o ID com o prefixo minecraft:, às vezes sem
function stripNamespace(id) {
  return String(id ?? '').replace(/^minecraft:/, '')
}

function toolToAction(name, args) {
  switch (name) {
    case 'give': {
      const itemId = stripNamespace(args.item_id)
      if (!SAFE_PLAYER.test(args.player) || !SAFE_MC_ID.test(itemId)) break
      const quantity = Math.min(Math.max(1, Math.trunc(args.quantity ?? 1)), 64)
      return { type: 'command', value: `give ${args.player} ${itemId} ${quantity}` }
    }
    case 'baritone_mine': {
      const ids = (args.block_ids ?? []).map(stripNamespace).filter((id) => SAFE_MC_ID.test(id))
      // Garante a variante deepslate dos minérios mesmo se o modelo esquecer
      for (const id of [...ids]) {
        if (DEEPSLATE_ORES.has(id) && !ids.includes(`deepslate_${id}`)) ids.push(`deepslate_${id}`)
      }
      if (ids.length === 0) break
      return { type: 'chat', value: `#mine ${ids.map((id) => `minecraft:${id}`).join(' ')}` }
    }
    case 'baritone_goto':
      if (![args.x, args.y, args.z].every(Number.isInteger)) break
      return { type: 'chat', value: `#goto ${args.x} ${args.y} ${args.z}` }
    case 'baritone_follow':
      if (!SAFE_PLAYER.test(args.player)) break
      return { type: 'chat', value: `#follow player ${args.player}` }
    case 'baritone_stop':
      return { type: 'chat', value: '#stop' }
    case 'say':
      if (typeof args.text !== 'string' || !args.text.trim()) break
      return { type: 'chat', value: args.text.trim() }
  }
  console.warn(`Tool call inválida descartada: ${name} ${JSON.stringify(args)}`)
  return { type: 'none', value: '' }
}

const BASE_SYSTEM = `Você controla um bot em um servidor de Minecraft via API.
A cada mensagem do chat você decide: chamar UMA ferramenta (no máximo uma) ou nenhuma.
- Pedidos dirigidos diretamente ao bot devem ser atendidos com a ferramenta adequada.
- Não aja em mensagens que não pedem nada de você (conversa entre jogadores, mensagens de sistema).
- Comandos rodam pelo servidor: use sempre o nome do jogador, nunca @s/@p.
- Mensagens com senderName null são mensagens de sistema do jogo (type "game"), não de jogadores.
- Nunca invente IDs de item/bloco: se não tiver certeza, use say pra pedir confirmação.`

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
    // latência e max_tokens cobre thinking + tool call
    max_tokens: 2048,
    reasoning_budget: 1024,
    temperature: 0.2,
    top_p: 0.95,
    tools: TOOLS,
    tool_choice: 'auto',
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

  // Sem tool call = o modelo decidiu não agir
  const call = completion.choices[0]?.message?.tool_calls?.[0]
  if (!call) return { type: 'none', value: '' }
  return toolToAction(call.function.name, JSON.parse(call.function.arguments || '{}'))
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
        console.log('→ none')
        return { type: 'none', value: '' }
      }
      // O modelo às vezes inclui a barra inicial apesar da instrução
      if (action.type === 'command') action.value = action.value.replace(/^\//, '')
      console.log(`→ ${action.type}: ${action.value}`)
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
