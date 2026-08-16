import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeOtlp } from './otlp.js'
import { EventStore, normalizeOtlp } from './store.js'
import { startCloudPolling } from './cloud.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.FRANKTOKEN_PORT) || 4319
const host = process.env.FRANKTOKEN_HOST || '127.0.0.1'
const ingestToken = process.env.FRANKTOKEN_INGEST_TOKEN || ''
const shareToken = process.env.FRANKTOKEN_SHARE_TOKEN || ''
const dataFile = process.env.FRANKTOKEN_DATA_FILE || path.join(rootDir, 'data', 'events.jsonl')
const rendererDir = path.join(rootDir, 'out', 'renderer')
const store = new EventStore(dataFile)
const clients = new Set()

function bearer(request) {
  return String(request.headers.authorization || '').replace(/^Bearer\s+/i, '')
}

function authorized(request, url, expected) {
  if (!expected) return true
  return bearer(request) === expected || url.searchParams.get('token') === expected
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  })
  response.end(JSON.stringify(body))
}

function readBody(request, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    request.on('data', (chunk) => {
      length += chunk.length
      if (length > limit) return reject(new Error('payload-too-large'))
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function payload(url) {
  const now = Date.now()
  const from = Number(url.searchParams.get('from')) || now - 30 * 86_400_000
  const to = Number(url.searchParams.get('to')) || now
  const granularity = url.searchParams.get('granularity') || 'auto'
  const preset = url.searchParams.get('preset') || 'custom'
  return {
    snapshots: store.snapshots({ from, to, granularity }), at: now,
    range: { spec: { preset, from: preset === 'custom' ? from : null, to: preset === 'custom' ? to : null, granularity }, resolved: { from, to, granularity } },
    hub: { transport: 'otlp/http', live: true }
  }
}

function broadcast() {
  for (const response of clients) response.write(`event: update\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)
}

startCloudPolling(store, broadcast)

function serveFile(response, file) {
  if (!fs.existsSync(file)) return false
  const ext = path.extname(file)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }
  response.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN'
  })
  fs.createReadStream(file).pipe(response)
  return true
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
  try {
    if (url.pathname === '/health') return json(response, 200, { ok: true, events: store.events.size, now: Date.now() })

    if (url.pathname === '/api/snapshot' && request.method === 'GET') {
      if (!authorized(request, url, shareToken)) return json(response, 401, { error: 'invalid share token' })
      return json(response, 200, payload(url))
    }
    if (url.pathname === '/api/stream' && request.method === 'GET') {
      if (!authorized(request, url, shareToken)) return json(response, 401, { error: 'invalid share token' })
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)
      clients.add(response)
      request.on('close', () => clients.delete(response))
      return
    }

    if (url.pathname === '/api/ingest' && request.method === 'POST') {
      if (!authorized(request, url, ingestToken)) return json(response, 401, { error: 'invalid ingest token' })
      const body = JSON.parse((await readBody(request)).toString('utf8'))
      const events = Array.isArray(body) ? body : body.events || [body]
      const accepted = store.ingest(events)
      if (accepted) broadcast()
      return json(response, 202, { accepted })
    }

    const otlp = url.pathname.match(/^\/v1\/(traces|logs|metrics)$/)
    if (otlp && request.method === 'POST') {
      if (!authorized(request, url, ingestToken)) return json(response, 401, { error: 'invalid ingest token' })
      const items = decodeOtlp(await readBody(request), otlp[1], request.headers)
      const accepted = store.ingest(normalizeOtlp(items))
      if (accepted) broadcast()
      response.writeHead(200, { 'Content-Type': 'application/json' })
      return response.end('{}')
    }

    if (request.method === 'GET') {
      const relative = url.pathname === '/' || url.pathname.startsWith('/share') ? 'index.html' : url.pathname.replace(/^\//, '')
      const resolved = path.resolve(rendererDir, relative)
      if (resolved.startsWith(rendererDir) && serveFile(response, resolved)) return
      if (serveFile(response, path.join(rendererDir, 'index.html'))) return
    }
    json(response, 404, { error: 'not found' })
  } catch (error) {
    json(response, error?.message === 'payload-too-large' ? 413 : 400, { error: String(error?.message || error) })
  }
})

server.listen(port, host, () => {
  console.log(`FrankToken Hub listening on http://${host}:${port}`)
  console.log(`OTLP: /v1/traces · /v1/logs · /v1/metrics`)
  if (!ingestToken) console.warn('Warning: ingestion is unauthenticated; set FRANKTOKEN_INGEST_TOKEN before exposing the Hub.')
  if (!shareToken) console.warn('Warning: the report is unauthenticated; set FRANKTOKEN_SHARE_TOKEN before exposing the Hub.')
})
