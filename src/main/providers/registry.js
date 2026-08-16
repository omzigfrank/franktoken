// Provider registry. To add a provider, import it and push it here.
// Each must satisfy the contract in types.js.
import codex from './codex.js'
import claude from './claude.js'
import chatgpt from './chatgpt.js'

export const providers = [claude, codex, chatgpt]

export function detected() {
  return providers.filter((p) => {
    try {
      return p.detect()
    } catch {
      return false
    }
  })
}

/** Fetch every provider snapshot in parallel; never rejects. */
export async function fetchAll(range) {
  const results = await Promise.all(
    providers.map(async (p) => {
      try {
        return await p.fetch(range)
      } catch (err) {
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          available: false,
          error: String(err?.message || err),
          windows: [],
          tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
          cost: { today: 0, total: 0, currency: 'USD', estimated: true },
          series: { tokensByDay: [], costByDay: [] },
          sessions: [],
          meta: { lastActivity: null, sessions: 0, model: null }
        }
      }
    })
  )
  return results
}
