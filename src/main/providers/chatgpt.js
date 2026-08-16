// ChatGPT / ChatGPT Work provider.
//
// OpenAI exposes no public usage API for ChatGPT and the apps keep no local
// transcript files, so live metering is impossible. The only official data
// source is the account export (ChatGPT → Settings → Data controls → Export
// data), which contains conversations.json with every message + timestamp +
// model slug. Drop that file into:
//   ~/.franktoken/imports/chatgpt/        (personal ChatGPT)
//   ~/.franktoken/imports/chatgpt-work/   (ChatGPT Work / business account)
// and this provider turns it into per-conversation sessions with ESTIMATED
// token counts (chars/4 — exports carry text, not token counts).
import fs from 'node:fs'
import path from 'node:path'
import { HOME, exists, estimateCost, summarize, normalizeRange, buildSessionSummary, selectSessions } from './util.js'

export const IMPORT_ROOT = path.join(HOME, '.franktoken', 'imports')
const SOURCES = [
  { dir: path.join(IMPORT_ROOT, 'chatgpt'), surface: 'ChatGPT' },
  { dir: path.join(IMPORT_ROOT, 'chatgpt-work'), surface: 'ChatGPT Work' }
]

/** Rough token estimate for exported text (exports carry no token counts). */
export function estimateTextTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}

function messageText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  const parts = content.parts || []
  return parts.filter((p) => typeof p === 'string').join('\n')
}

/**
 * Convert one exported conversation (conversations.json entry) into granular
 * usage events. User/system/tool text counts as input, assistant as output.
 */
export function chatgptConversationEvents(convo) {
  const events = []
  const mapping = convo?.mapping || {}
  for (const node of Object.values(mapping)) {
    const msg = node?.message
    if (!msg?.author?.role) continue
    const text = messageText(msg.content)
    const tokens = estimateTextTokens(text)
    if (tokens === 0) continue
    const ts = Math.round((msg.create_time || convo.create_time || 0) * 1000)
    if (!ts) continue
    const model = msg.metadata?.model_slug || msg.metadata?.default_model_slug || null
    const isAssistant = msg.author.role === 'assistant'
    const event = {
      ts,
      input: isAssistant ? 0 : tokens,
      cachedInput: 0,
      cacheWrite: 0,
      output: isAssistant ? tokens : 0,
      reasoning: 0,
      total: tokens,
      model
    }
    event.usd = estimateCost(
      { input: event.input, output: event.output, cacheWrite: 0, cacheRead: 0 },
      model || 'gpt-5'
    )
    events.push(event)
  }
  return events.sort((a, b) => a.ts - b.ts)
}

function readConversations(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      const list = Array.isArray(parsed) ? parsed : parsed?.conversations
      if (Array.isArray(list)) out.push(...list)
    } catch {
      /* ignore unreadable/partial file */
    }
  }
  // Multiple export drops can carry the same conversation; keep the freshest.
  const byId = new Map()
  for (const convo of out) {
    const id = convo?.conversation_id || convo?.id || convo?.title
    if (!id) continue
    const prev = byId.get(id)
    if (!prev || (convo.update_time || 0) > (prev.update_time || 0)) byId.set(id, convo)
  }
  return [...byId.values()]
}

export default {
  id: 'chatgpt',
  name: 'ChatGPT',
  color: '#9080e8', // CVD-validated with claude/codex series colors

  detect() {
    // Always on: even without an import yet, users should see how to add one.
    return true
  },

  async fetch(range) {
    const r = normalizeRange(range)
    const base = {
      id: this.id,
      name: this.name,
      color: this.color,
      available: true,
      error: null,
      windows: [],
      windowsUnknown: true,
      tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
      cost: { today: 0, total: 0, currency: 'USD', estimated: true },
      series: { tokensByDay: [], costByDay: [] },
      sessions: [],
      meta: {
        lastActivity: null,
        sessions: 0,
        model: null,
        coverage: 'Import-based · OpenAI exposes no usage API for ChatGPT',
        importDirs: SOURCES.map((s) => s.dir)
      }
    }

    const events = []
    const sessions = []
    const modelTokens = new Map()
    let convoCount = 0

    for (const { dir, surface } of SOURCES) {
      if (!exists(dir)) continue
      for (const convo of readConversations(dir)) {
        const convoEvents = chatgptConversationEvents(convo)
        if (convoEvents.length === 0) continue
        convoCount++
        events.push(...convoEvents)
        const summary = buildSessionSummary(convoEvents, {
          id: convo.conversation_id || convo.id || `${surface}:${convo.title}`,
          title: convo.title || 'Untitled conversation',
          surface,
          estimated: true
        })
        if (summary) {
          summary.provider = this.id
          summary.providerName = this.name
          summary.color = this.color
          sessions.push(summary)
        }
      }
    }

    if (convoCount === 0) {
      base.error =
        'No ChatGPT export imported yet. ChatGPT has no usage API — export your data (Settings → Data controls → Export data) and drop conversations.json into ~/.franktoken/imports/chatgpt (or chatgpt-work).'
      return base
    }

    for (const e of events) {
      if (e.ts >= r.from && e.ts <= r.to && e.model) {
        modelTokens.set(e.model, (modelTokens.get(e.model) || 0) + e.total)
      }
    }
    const models = [...modelTokens.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
    base.meta.models = models
    base.meta.model = models[0] || null
    base.meta.lastActivity = events.reduce((m, e) => Math.max(m, e.ts), 0) || null
    base.sessions = selectSessions(sessions, r)
    base.meta.sessions = base.sessions.length
    base.meta.totalSessions = sessions.length
    base.tokensEstimated = true

    const sum = summarize(events, r, { costEstimated: true })
    base.tokens = sum.tokens
    base.cost = sum.cost
    base.series = sum.series
    base.range = sum.range

    base.byModel = {}
    for (const mName of models) {
      const ms = summarize(events.filter((e) => e.model === mName), r, { costEstimated: true })
      if (ms.tokens.total > 0) base.byModel[mName] = { tokens: ms.tokens, cost: ms.cost, series: ms.series }
    }
    base.meta.models = models.filter((m) => base.byModel[m])
    base.meta.model = base.meta.models[0] || null

    return base
  }
}
