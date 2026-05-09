import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface Grape {
  name: string     // e.g. "habitaware-ai"
  url: string      // e.g. "https://grape-habitaware-ai.fly.dev"
  token: string    // GRAPE_SERVICE_TOKEN set on that grape's Fly instance
  model?: string   // default model — falls back to claude-sonnet-4-6
  repo?: string    // informational
  branch?: string  // informational
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = join(__dirname, '..', 'grapes.json')

export function loadRegistry(): Grape[] {
  if (!existsSync(REGISTRY_PATH)) {
    console.warn('[tokenhouse] grapes.json not found — no grapes registered')
    return []
  }
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as Grape[]
  } catch (e) {
    console.error('[tokenhouse] Failed to parse grapes.json:', e)
    return []
  }
}
