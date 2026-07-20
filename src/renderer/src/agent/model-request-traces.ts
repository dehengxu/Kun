import { kunThreadModelRequestsPath } from '@shared/kun-endpoints'
import { parseRuntimeErrorBody, runtimeErrorToError } from '@shared/runtime-error'
import { rendererRuntimeClient } from './runtime-client'

const TRACE_SCHEMA_VERSION = 1
const MAX_TRACE_PAGE_RECORDS = 200
const MAX_TRACE_PAGE_BODY_CHARS = 64 * 1024 * 1024
const MAX_TRACE_TEXT_CHARS = 8 * 1024 * 1024
const MAX_TRACE_HEADERS = 256
const MAX_TRACE_HEADER_CHARS = 64 * 1024

export type ModelRequestTraceBody = {
  text: string
  capturedBytes: number
  originalBytes: number
  truncated: boolean
}

export type ModelRequestTraceHeaders = {
  values: Record<string, string>
  redactedNames: string[]
}

export type ModelRequestTraceRecord = {
  schemaVersion: 1
  id: string
  sequence: number
  threadId: string
  turnId: string
  provider: string
  model: string
  endpointFormat: string
  attempt: number
  attemptReason: 'initial' | 'transport_retry' | 'stream_options_fallback'
  status: 'pending' | 'completed' | 'transport_error' | 'capture_error'
  startedAt: string
  responseStartedAt?: string
  finishedAt?: string
  timeToHeadersMs?: number
  durationMs?: number
  request: {
    method: 'POST'
    url: string
    urlRedacted: boolean
    headers: ModelRequestTraceHeaders
    body: ModelRequestTraceBody
  }
  response?: {
    status: number
    statusText: string
    headers: ModelRequestTraceHeaders
    body?: ModelRequestTraceBody
    captureError?: string
  }
  decoded?: {
    text: string
    reasoning: string
    toolCalls: Array<{ callId: string; toolName: string; arguments: Record<string, unknown> }>
    usage?: Record<string, unknown>
    stopReason?: string
    error?: string
    truncated?: Record<string, boolean>
  }
  error?: string
  captureWarnings?: string[]
}

export type ModelRequestTracePage = {
  schemaVersion: 1
  records: ModelRequestTraceRecord[]
  nextCursor?: string
  activeCount: number
  limits: {
    maxRequestBodyBytes: number
    maxResponseBodyBytes: number
    maxPageSize: number
  }
  warnings: string[]
}

export function parseModelRequestTracePageJson(body: string): ModelRequestTracePage {
  if (body.length > MAX_TRACE_PAGE_BODY_CHARS) throw new Error('model request trace response is too large')
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error('runtime returned invalid model request trace JSON')
  }
  return parseModelRequestTracePage(value)
}

export function parseModelRequestTracePage(value: unknown): ModelRequestTracePage {
  const root = object(value, 'trace page')
  if (root.schemaVersion !== TRACE_SCHEMA_VERSION) throw new Error('unsupported model request trace schema')
  const rawRecords = array(root.records, 'records', MAX_TRACE_PAGE_RECORDS)
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    records: rawRecords.map((record, index) => parseRecord(record, `records[${index}]`)),
    ...(root.nextCursor === undefined ? {} : { nextCursor: text(root.nextCursor, 'nextCursor', 2_048) }),
    activeCount: integer(root.activeCount, 'activeCount', 0),
    limits: parseLimits(root.limits),
    warnings: stringArray(root.warnings, 'warnings', 8, 512)
  }
}

export async function fetchModelRequestTracePage(
  threadId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<ModelRequestTracePage> {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.cursor) query.set('cursor', options.cursor)
  const suffix = query.size ? `?${query.toString()}` : ''
  const response = await rendererRuntimeClient.runtimeRequest(
    `${kunThreadModelRequestsPath(threadId)}${suffix}`,
    'GET'
  )
  if (!response.ok) {
    throw runtimeErrorToError(parseRuntimeErrorBody(response.body, 'failed to load model request traces'))
  }
  return parseModelRequestTracePageJson(response.body)
}

function parseRecord(value: unknown, label: string): ModelRequestTraceRecord {
  const input = object(value, label)
  if (input.schemaVersion !== TRACE_SCHEMA_VERSION) throw new Error(`${label}.schemaVersion is invalid`)
  const attemptReason = oneOf(input.attemptReason, `${label}.attemptReason`, [
    'initial', 'transport_retry', 'stream_options_fallback'
  ] as const)
  const status = oneOf(input.status, `${label}.status`, [
    'pending', 'completed', 'transport_error', 'capture_error'
  ] as const)
  const request = object(input.request, `${label}.request`)
  if (request.method !== 'POST') throw new Error(`${label}.request.method is invalid`)
  const parsed: ModelRequestTraceRecord = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    id: text(input.id, `${label}.id`, 256),
    sequence: integer(input.sequence, `${label}.sequence`, 1),
    threadId: text(input.threadId, `${label}.threadId`, 512),
    turnId: text(input.turnId, `${label}.turnId`, 512),
    provider: text(input.provider, `${label}.provider`, 512),
    model: text(input.model, `${label}.model`, 1_024),
    endpointFormat: text(input.endpointFormat, `${label}.endpointFormat`, 128),
    attempt: integer(input.attempt, `${label}.attempt`, 1),
    attemptReason,
    status,
    startedAt: text(input.startedAt, `${label}.startedAt`, 128),
    request: {
      method: 'POST',
      url: text(request.url, `${label}.request.url`, 16_384),
      urlRedacted: bool(request.urlRedacted, `${label}.request.urlRedacted`),
      headers: parseHeaders(request.headers, `${label}.request.headers`),
      body: parseBody(request.body, `${label}.request.body`)
    }
  }
  if (input.responseStartedAt !== undefined) parsed.responseStartedAt = text(input.responseStartedAt, `${label}.responseStartedAt`, 128)
  if (input.finishedAt !== undefined) parsed.finishedAt = text(input.finishedAt, `${label}.finishedAt`, 128)
  if (input.error !== undefined) parsed.error = text(input.error, `${label}.error`, 4_096)
  if (input.timeToHeadersMs !== undefined) parsed.timeToHeadersMs = finiteNumber(input.timeToHeadersMs, `${label}.timeToHeadersMs`)
  if (input.durationMs !== undefined) parsed.durationMs = finiteNumber(input.durationMs, `${label}.durationMs`)
  if (input.captureWarnings !== undefined) {
    parsed.captureWarnings = stringArray(input.captureWarnings, `${label}.captureWarnings`, 16, 1_024)
  }
  if (input.response !== undefined) parsed.response = parseResponse(input.response, `${label}.response`)
  if (input.decoded !== undefined) parsed.decoded = parseDecoded(input.decoded, `${label}.decoded`)
  return parsed
}

function parseResponse(value: unknown, label: string): NonNullable<ModelRequestTraceRecord['response']> {
  const input = object(value, label)
  const response: NonNullable<ModelRequestTraceRecord['response']> = {
    status: integer(input.status, `${label}.status`, 100, 599),
    statusText: text(input.statusText, `${label}.statusText`, 1_024),
    headers: parseHeaders(input.headers, `${label}.headers`)
  }
  if (input.body !== undefined) response.body = parseBody(input.body, `${label}.body`)
  if (input.captureError !== undefined) response.captureError = text(input.captureError, `${label}.captureError`, 4_096)
  return response
}

function parseDecoded(value: unknown, label: string): NonNullable<ModelRequestTraceRecord['decoded']> {
  const input = object(value, label)
  const toolCalls = array(input.toolCalls, `${label}.toolCalls`, 512).map((value, index) => {
    const call = object(value, `${label}.toolCalls[${index}]`)
    return {
      callId: text(call.callId, `${label}.toolCalls[${index}].callId`, 512),
      toolName: text(call.toolName, `${label}.toolCalls[${index}].toolName`, 512),
      arguments: object(call.arguments, `${label}.toolCalls[${index}].arguments`)
    }
  })
  const decoded: NonNullable<ModelRequestTraceRecord['decoded']> = {
    text: text(input.text, `${label}.text`, MAX_TRACE_TEXT_CHARS),
    reasoning: text(input.reasoning, `${label}.reasoning`, MAX_TRACE_TEXT_CHARS),
    toolCalls
  }
  if (input.usage !== undefined) decoded.usage = object(input.usage, `${label}.usage`)
  for (const key of ['stopReason', 'error'] as const) {
    if (input[key] !== undefined) decoded[key] = text(input[key], `${label}.${key}`, 4_096)
  }
  if (input.truncated !== undefined) {
    const raw = object(input.truncated, `${label}.truncated`)
    decoded.truncated = Object.fromEntries(Object.entries(raw).map(([key, value]) => [
      key,
      bool(value, `${label}.truncated.${key}`)
    ]))
  }
  return decoded
}

function parseHeaders(value: unknown, label: string): ModelRequestTraceHeaders {
  const input = object(value, label)
  const values = object(input.values, `${label}.values`)
  const entries = Object.entries(values)
  if (entries.length > MAX_TRACE_HEADERS) throw new Error(`${label}.values has too many entries`)
  return {
    values: Object.fromEntries(entries.map(([key, value]) => [
      text(key, `${label}.name`, 1_024),
      text(value, `${label}.${key}`, MAX_TRACE_HEADER_CHARS)
    ])),
    redactedNames: stringArray(input.redactedNames, `${label}.redactedNames`, MAX_TRACE_HEADERS, 1_024)
  }
}

function parseBody(value: unknown, label: string): ModelRequestTraceBody {
  const input = object(value, label)
  return {
    text: text(input.text, `${label}.text`, MAX_TRACE_TEXT_CHARS),
    capturedBytes: integer(input.capturedBytes, `${label}.capturedBytes`, 0),
    originalBytes: integer(input.originalBytes, `${label}.originalBytes`, 0),
    truncated: bool(input.truncated, `${label}.truncated`)
  }
}

function parseLimits(value: unknown): ModelRequestTracePage['limits'] {
  const input = object(value, 'limits')
  return {
    maxRequestBodyBytes: integer(input.maxRequestBodyBytes, 'limits.maxRequestBodyBytes', 1),
    maxResponseBodyBytes: integer(input.maxResponseBodyBytes, 'limits.maxResponseBodyBytes', 1),
    maxPageSize: integer(input.maxPageSize, 'limits.maxPageSize', 1, MAX_TRACE_PAGE_RECORDS)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`)
  return value
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be a bounded string`)
  return value
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function integer(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be a bounded integer`)
  }
  return value as number
}

function oneOf<const T extends readonly string[]>(value: unknown, label: string, values: T): T[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw new Error(`${label} is invalid`)
  return value as T[number]
}

function stringArray(value: unknown, label: string, max: number, maxText: number): string[] {
  return array(value, label, max).map((entry, index) => text(entry, `${label}[${index}]`, maxText))
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`)
  return value
}
