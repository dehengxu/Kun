import { z } from 'zod'
import { UsageSnapshotSchema } from './usage.js'

export const MODEL_REQUEST_TRACE_SCHEMA_VERSION = 1 as const
export const MODEL_REQUEST_TRACE_REDACTED_VALUE = '[REDACTED]' as const

export const ModelRequestTraceBodySchema = z.object({
  text: z.string(),
  capturedBytes: z.number().int().nonnegative(),
  originalBytes: z.number().int().nonnegative(),
  truncated: z.boolean()
})
export type ModelRequestTraceBody = z.infer<typeof ModelRequestTraceBodySchema>

export const ModelRequestTraceHeadersSchema = z.object({
  values: z.record(z.string(), z.string()),
  redactedNames: z.array(z.string())
})
export type ModelRequestTraceHeaders = z.infer<typeof ModelRequestTraceHeadersSchema>

export const ModelRequestTraceRequestSchema = z.object({
  method: z.literal('POST'),
  url: z.string(),
  urlRedacted: z.boolean(),
  headers: ModelRequestTraceHeadersSchema,
  body: ModelRequestTraceBodySchema
})
export type ModelRequestTraceRequest = z.infer<typeof ModelRequestTraceRequestSchema>

export const ModelRequestTraceResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  statusText: z.string(),
  headers: ModelRequestTraceHeadersSchema,
  body: ModelRequestTraceBodySchema.optional(),
  captureError: z.string().optional()
})
export type ModelRequestTraceResponse = z.infer<typeof ModelRequestTraceResponseSchema>

export const ModelRequestTraceToolCallSchema = z.object({
  callId: z.string(),
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown())
})

export const ModelRequestTraceDecodedSchema = z.object({
  text: z.string(),
  reasoning: z.string(),
  toolCalls: z.array(ModelRequestTraceToolCallSchema),
  usage: UsageSnapshotSchema.optional(),
  stopReason: z.string().optional(),
  error: z.string().optional(),
  truncated: z.record(z.string(), z.boolean()).optional()
})
export type ModelRequestTraceDecoded = z.infer<typeof ModelRequestTraceDecodedSchema>

export const ModelRequestTraceRecordSchema = z.object({
  schemaVersion: z.literal(MODEL_REQUEST_TRACE_SCHEMA_VERSION),
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  provider: z.string(),
  model: z.string(),
  endpointFormat: z.string(),
  attempt: z.number().int().positive(),
  attemptReason: z.enum(['initial', 'transport_retry', 'stream_options_fallback']),
  status: z.enum(['pending', 'completed', 'transport_error', 'capture_error']),
  startedAt: z.string(),
  responseStartedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  timeToHeadersMs: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  request: ModelRequestTraceRequestSchema,
  response: ModelRequestTraceResponseSchema.optional(),
  decoded: ModelRequestTraceDecodedSchema.optional(),
  error: z.string().optional(),
  captureWarnings: z.array(z.string()).optional()
})
export type ModelRequestTraceRecord = z.infer<typeof ModelRequestTraceRecordSchema>

export type ModelRequestTraceLimits = {
  maxRequestBodyBytes: number
  maxResponseBodyBytes: number
  maxPageSize: number
}

export type ModelRequestTracePage = {
  schemaVersion: typeof MODEL_REQUEST_TRACE_SCHEMA_VERSION
  records: ModelRequestTraceRecord[]
  nextCursor?: string
  activeCount: number
  limits: ModelRequestTraceLimits
  warnings: string[]
}
