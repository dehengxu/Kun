import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const CURSOR_SDK_PACKAGE = '@cursor/sdk'
const FRAME_MARKER = '<<<KUN_CURSOR_SDK>>>'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_STDOUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MAX_MODEL_ID_LENGTH = 512
const MAX_ACCOUNT_FIELD_LENGTH = 512

export type CursorSubscriptionAccount = {
  apiKeyName: string
  userEmail?: string
  userFirstName?: string
  userLastName?: string
}

export type CursorSubscriptionDiscovery = {
  account: CursorSubscriptionAccount
  models: string[]
}

type CursorDiscoveryFrame =
  | { ok: true; account: unknown; models: unknown }
  | { ok: false; code?: unknown; message?: unknown }

export type CursorSubscriptionDiscoveryOptions = {
  apiKey: string
  kunRoots: readonly string[]
  nodePath?: string
  spawnFn?: typeof spawn
  timeoutMs?: number
}

export function resolveCursorSdkKunDir(kunRoots: readonly string[]): string | undefined {
  return kunRoots.find((root) =>
    existsSync(join(root, 'node_modules', '@cursor', 'sdk', 'package.json'))
  )
}

export async function discoverCursorSubscription(
  options: CursorSubscriptionDiscoveryOptions
): Promise<CursorSubscriptionDiscovery> {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('Enter a Cursor API key before connecting.')
  const kunDir = resolveCursorSdkKunDir(options.kunRoots)
  if (!kunDir) {
    throw new Error('Cursor SDK is unavailable in the Kun runtime. Reinstall or update Kun.')
  }

  const spawnFn = options.spawnFn ?? spawn
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const nodePath = options.nodePath ?? process.execPath
  const script = cursorDiscoveryScript()

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (
      result?: CursorSubscriptionDiscovery,
      error?: unknown
    ): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        // Best effort: the process may have already exited.
      }
      if (error) reject(new Error(sanitizeCursorError(error, apiKey)))
      else if (result) resolve(result)
      else reject(new Error('Cursor SDK discovery failed.'))
    }

    try {
      child = spawnFn(nodePath, ['--input-type=module', '-e', script], {
        cwd: kunDir,
        env: cursorDiscoveryEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      })
    } catch (error) {
      finish(undefined, error)
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      try {
        child?.kill()
      } catch {
        // Best effort.
      }
      finish(undefined, `Cursor SDK discovery timed out after ${timeoutMs}ms.`)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
      if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
        finish(undefined, 'Cursor SDK discovery response exceeded the output limit.')
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_BYTES)
    })
    child.on('error', (error) => finish(undefined, error))
    child.on('exit', (code) => {
      if (settled || timedOut) return
      try {
        finish(parseCursorDiscoveryOutput(stdout, apiKey))
      } catch (error) {
        const detail = stderr.trim()
        finish(undefined, detail || error || `Cursor SDK discovery exited with code ${code ?? 'unknown'}.`)
      }
    })

    try {
      child.stdin?.end(apiKey)
    } catch (error) {
      finish(undefined, error)
    }
  })
}

export function cursorDiscoveryEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, ELECTRON_RUN_AS_NODE: '1' }
  delete env.CURSOR_API_KEY
  return env
}

export function cursorDiscoveryScript(): string {
  return [
    `import { readFileSync } from 'node:fs';`,
    `import { Cursor } from ${JSON.stringify(CURSOR_SDK_PACKAGE)};`,
    `const marker = ${JSON.stringify(FRAME_MARKER)};`,
    `const apiKey = readFileSync(0, 'utf8').trim();`,
    `const redact = (value) => String(value ?? '').split(apiKey).join('[REDACTED]');`,
    `try {`,
    `  if (!apiKey) throw new Error('Cursor API key is required.');`,
    `  const [account, models] = await Promise.all([`,
    `    Cursor.me({ apiKey }),`,
    `    Cursor.models.list({ apiKey })`,
    `  ]);`,
    `  process.stdout.write(marker + JSON.stringify({ ok: true, account, models }) + marker);`,
    `} catch (error) {`,
    `  process.stdout.write(marker + JSON.stringify({`,
    `    ok: false,`,
    `    code: typeof error?.code === 'string' ? error.code : error?.name,`,
    `    message: redact(error?.message || error)`,
    `  }) + marker);`,
    `}`,
    `process.exit(0);`
  ].join('\n')
}

export function parseCursorDiscoveryOutput(
  stdout: string,
  apiKey: string
): CursorSubscriptionDiscovery {
  const start = stdout.indexOf(FRAME_MARKER)
  const end = start < 0 ? -1 : stdout.indexOf(FRAME_MARKER, start + FRAME_MARKER.length)
  if (start < 0 || end <= start) throw new Error('Cursor SDK returned an invalid response.')

  let frame: CursorDiscoveryFrame
  try {
    frame = JSON.parse(stdout.slice(start + FRAME_MARKER.length, end)) as CursorDiscoveryFrame
  } catch {
    throw new Error('Cursor SDK returned malformed JSON.')
  }
  if (!frame || typeof frame !== 'object') throw new Error('Cursor SDK returned an invalid response.')
  if (frame.ok !== true) {
    const code = boundedString(frame.code, 128)
    const message = boundedString(frame.message, 2_000) || 'Cursor rejected the API key.'
    throw new Error(sanitizeCursorError(code ? `${code}: ${message}` : message, apiKey))
  }

  const models = normalizeCursorModels(frame.models)
  if (models.length === 0) {
    throw new Error('Cursor connected successfully but returned no available models.')
  }
  return {
    account: normalizeCursorAccount(frame.account),
    models
  }
}

export function sanitizeCursorError(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const secret = apiKey.trim()
  const redacted = secret ? message.split(secret).join('[REDACTED]') : message
  return redacted.slice(0, 2_000) || 'Cursor SDK request failed.'
}

function normalizeCursorModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return ''
      return boundedString((entry as { id?: unknown }).id, MAX_MODEL_ID_LENGTH)
    })
    .filter((id) => id.length > 0 && !/[\u0000-\u001f\u007f]/u.test(id))
  return [...new Set(ids)]
}

function normalizeCursorAccount(value: unknown): CursorSubscriptionAccount {
  const account = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  const apiKeyName = boundedString(account.apiKeyName, MAX_ACCOUNT_FIELD_LENGTH) || 'Cursor API key'
  const userEmail = boundedString(account.userEmail, MAX_ACCOUNT_FIELD_LENGTH)
  const userFirstName = boundedString(account.userFirstName, MAX_ACCOUNT_FIELD_LENGTH)
  const userLastName = boundedString(account.userLastName, MAX_ACCOUNT_FIELD_LENGTH)
  return {
    apiKeyName,
    ...(userEmail ? { userEmail } : {}),
    ...(userFirstName ? { userFirstName } : {}),
    ...(userLastName ? { userLastName } : {})
  }
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}
