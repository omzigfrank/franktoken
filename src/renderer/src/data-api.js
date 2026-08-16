const electronApi = window.api

function queryToken() {
  return new URLSearchParams(window.location.search).get('token') || ''
}

function browserApi() {
  let range = { preset: '30d', from: null, to: null, granularity: 'auto' }
  const resolved = () => {
    const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[range.preset]
    const now = Date.now()
    return days
      ? { from: now - days * 86_400_000, to: now, granularity: range.granularity || 'auto' }
      : { from: range.from, to: range.to, granularity: range.granularity || 'auto' }
  }
  const url = () => {
    const value = resolved()
    const params = new URLSearchParams({
      from: String(value.from), to: String(value.to), granularity: value.granularity,
      preset: range.preset || 'custom'
    })
    if (queryToken()) params.set('token', queryToken())
    return `/api/snapshot?${params}`
  }
  const get = async () => {
    const response = await fetch(url())
    if (!response.ok) throw new Error(`Hub returned ${response.status}`)
    return response.json()
  }
  return {
    getSnapshot: get,
    refresh: get,
    setRange: async (spec) => {
      range = { ...range, ...spec }
      return get()
    },
    getSettings: async () => ({ pollSeconds: 5, launchAtLogin: false, browserReport: true }),
    setSettings: async (patch) => patch,
    onUpdate: (callback) => {
      const params = new URLSearchParams()
      if (queryToken()) params.set('token', queryToken())
      const events = new EventSource(`/api/stream?${params}`)
      events.addEventListener('update', () => get().then(callback).catch(() => {}))
      return () => events.close()
    },
    hide: () => {}, minimize: () => {}, quit: () => {},
    openExternal: (url) => window.open(url, '_blank', 'noopener')
  }
}

export const dataApi = electronApi || browserApi()
export const isDesktop = !!electronApi
