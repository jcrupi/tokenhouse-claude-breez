import type { Grape } from './registry.js'

export interface GrapeEvent {
  grape: string
  event: string
  [key: string]: unknown
}

// Parse the grape's SSE wire format into typed events
async function* parseGrapeSSE(
  response: Response,
  grapeName: string,
  signal: AbortSignal,
): AsyncGenerator<GrapeEvent> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // SSE frames are delimited by double newline
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''

      for (const frame of frames) {
        const trimmed = frame.trim()
        if (!trimmed || trimmed.startsWith(':')) continue  // heartbeat / comment

        let eventType = ''
        let dataLine = ''

        for (const line of trimmed.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim()
          else if (line.startsWith('data: ')) dataLine = line.slice(6).trim()
        }

        if (!dataLine || !eventType) continue

        try {
          const payload = JSON.parse(dataLine) as Record<string, unknown>
          yield { grape: grapeName, event: eventType, ...payload }
        } catch {}
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

async function* fetchGrapeStream(
  grape: Grape,
  message: string,
  sessionId: string,
  model: string,
  signal: AbortSignal,
): AsyncGenerator<GrapeEvent> {
  const url = new URL('/api/chat/stream', grape.url)
  url.searchParams.set('message', message)
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('model', grape.model ?? model)

  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers: { 'X-Grape-Service-Token': grape.token },
      signal,
    })
  } catch (e) {
    if (signal.aborted) return
    yield { grape: grape.name, event: 'error', message: String(e) }
    return
  }

  if (!response.ok) {
    yield { grape: grape.name, event: 'error', message: `HTTP ${response.status} from ${grape.name}` }
    return
  }

  yield* parseGrapeSSE(response, grape.name, signal)
}

// Fan out a task to N grapes concurrently, merging all events into one stream
export async function* fanOut(
  grapes: Grape[],
  message: string,
  sessionId: string,
  model: string,
  signal: AbortSignal,
): AsyncGenerator<GrapeEvent> {
  const queue: GrapeEvent[] = []
  let pending = grapes.length
  let notify: (() => void) | null = null

  const push = () => { notify?.(); notify = null }

  async function drain(grape: Grape) {
    try {
      for await (const evt of fetchGrapeStream(grape, message, sessionId, model, signal)) {
        queue.push(evt)
        push()
      }
    } catch (e) {
      queue.push({ grape: grape.name, event: 'error', message: String(e) })
      push()
    } finally {
      pending--
      push()
    }
  }

  // Kick off all grapes concurrently
  for (const grape of grapes) drain(grape)

  // Yield events as they arrive
  while (pending > 0 || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!
    if (pending > 0) await new Promise<void>(r => { notify = r })
  }
}
