import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { loadRegistry } from './registry.js'
import { fanOut } from './orchestrator.js'

const PORT = parseInt(process.env.ORCHESTRATOR_PORT ?? '3001')

const enc = (s: string) => new TextEncoder().encode(s)
const sseData = (data: unknown) => enc(`data: ${JSON.stringify(data)}\n\n`)
const heartbeat = enc(': heartbeat\n\n')

const SSE_HEADERS = {
  'Content-Type':      'text/event-stream',
  'Cache-Control':     'no-cache',
  'Connection':        'keep-alive',
  'X-Accel-Buffering': 'no',
}

new Elysia()
  .use(cors())

  // List registered grapes (tokens omitted)
  .get('/api/grapes', () => {
    return loadRegistry().map(({ name, url, model, repo, branch }) => ({
      name, url, model, repo, branch,
    }))
  })

  // Fan-out task to N grapes, returns SSE stream
  // Query: message, sessionId?, model?, grapes? (comma-separated names)
  .get('/api/task/stream', ({ query, request }) => {
    const message    = (query.message    as string | undefined) ?? ''
    const sessionId  = (query.sessionId  as string | undefined) ?? crypto.randomUUID()
    const model      = (query.model      as string | undefined) ?? 'claude-sonnet-4-6'
    const grapeNames = (query.grapes     as string | undefined) ?? ''

    if (!message) {
      return new Response(
        sseData({ event: 'error', message: 'message query param is required' }),
        { status: 200, headers: SSE_HEADERS },
      )
    }

    const registry = loadRegistry()
    const targeted  = grapeNames ? grapeNames.split(',').map(s => s.trim()).filter(Boolean) : null
    const grapes    = targeted ? registry.filter(g => targeted.includes(g.name)) : registry

    if (grapes.length === 0) {
      return new Response(
        sseData({ event: 'error', message: targeted ? `No grapes matched: ${targeted.join(', ')}` : 'No grapes registered — add entries to grapes.json' }),
        { status: 200, headers: SSE_HEADERS },
      )
    }

    const ac = new AbortController()

    // Abort fan-out when client disconnects
    request.signal.addEventListener('abort', () => ac.abort())

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(heartbeat)
        controller.enqueue(sseData({ event: 'roster', grapes: grapes.map(g => g.name) }))

        const hb = setInterval(() => { try { controller.enqueue(heartbeat) } catch {} }, 15_000)
        const close = () => { clearInterval(hb); try { controller.close() } catch {} }

        try {
          for await (const evt of fanOut(grapes, message, sessionId, model, ac.signal)) {
            if (ac.signal.aborted) break
            controller.enqueue(sseData(evt))
          }
          controller.enqueue(sseData({ event: 'all_done', grapes: grapes.map(g => g.name) }))
        } catch (e) {
          if (!ac.signal.aborted) {
            controller.enqueue(sseData({ event: 'error', message: String(e) }))
          }
        } finally {
          close()
        }
      },
    })

    return new Response(stream, { headers: SSE_HEADERS })
  })

  .listen(PORT, () => {
    const grapes = loadRegistry()
    console.log(`\n🏠 TokenHouse Orchestrator → http://localhost:${PORT}`)
    console.log(`   Grapes (${grapes.length}): ${
      grapes.length === 0
        ? '(none — add entries to grapes.json)'
        : grapes.map(g => g.name).join(', ')
    }`)
    console.log()
  })
