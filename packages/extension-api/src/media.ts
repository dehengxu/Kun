import { z } from 'zod'
import { JsonObjectSchema, RelativePathSchema } from './common.js'
import { JobReferenceSchema } from './jobs.js'

const OpaqueMediaReferenceSchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected an opaque media reference')

export const MediaHandleIdSchema = OpaqueMediaReferenceSchema
export type MediaHandleId = z.infer<typeof MediaHandleIdSchema>

export const MediaLeaseIdSchema = OpaqueMediaReferenceSchema
export type MediaLeaseId = z.infer<typeof MediaLeaseIdSchema>

export const MediaKindSchema = z.enum(['video', 'audio', 'image', 'subtitle', 'data', 'unknown'])
export type MediaKind = z.infer<typeof MediaKindSchema>

export const MediaHandleModeSchema = z.enum(['read', 'export'])
export type MediaHandleMode = z.infer<typeof MediaHandleModeSchema>

export const MediaMetadataSchema = z.strictObject({
  handleId: MediaHandleIdSchema,
  mode: MediaHandleModeSchema,
  kind: MediaKindSchema,
  displayName: z.string().min(1).max(256),
  mimeType: z
    .string()
    .min(3)
    .max(128)
    .regex(new RegExp('^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'))
    .optional(),
  byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  modifiedAt: z.string().datetime().optional(),
  completionIdentity: z.string().min(1).max(512).optional(),
  workspaceRelativeDisplayLocation: RelativePathSchema.optional(),
  revoked: z.boolean().default(false)
})
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>

export const MediaPickerFilterSchema = z.strictObject({
  name: z.string().min(1).max(128),
  extensions: z
    .array(z.string().min(1).max(32).regex(/^[A-Za-z0-9]+$/))
    .min(1)
    .max(64),
  mimeTypes: z
    .array(
      z.string().min(3).max(128).regex(new RegExp('^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+*-]+$'))
    )
    .max(64)
    .default([])
})
export type MediaPickerFilter = z.input<typeof MediaPickerFilterSchema>

export const MediaPickFilesRequestSchema = z.strictObject({
  filters: z.array(MediaPickerFilterSchema).max(32).default([]),
  multiple: z.boolean().default(false),
  maxFiles: z.number().int().min(1).max(128).default(1)
})
export type MediaPickFilesRequest = z.input<typeof MediaPickFilesRequestSchema>

export const MediaPickFilesResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('selected'), files: z.array(MediaMetadataSchema).min(1).max(128) }),
  z.strictObject({ outcome: z.literal('cancelled'), files: z.tuple([]) })
])
export type MediaPickFilesResult = z.infer<typeof MediaPickFilesResultSchema>

export const MediaPickSaveTargetRequestSchema = z.strictObject({
  suggestedName: z.string().min(1).max(256).optional(),
  filters: z.array(MediaPickerFilterSchema).max(32).default([])
})
export type MediaPickSaveTargetRequest = z.input<typeof MediaPickSaveTargetRequestSchema>

export const MediaPickSaveTargetResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('selected'), target: MediaMetadataSchema }),
  z.strictObject({ outcome: z.literal('cancelled') })
])
export type MediaPickSaveTargetResult = z.infer<typeof MediaPickSaveTargetResultSchema>

export const MediaStatRequestSchema = z.strictObject({ handleId: MediaHandleIdSchema })
export type MediaStatRequest = z.infer<typeof MediaStatRequestSchema>

export const MAX_MEDIA_TEXT_BYTES = 512 * 1024

export const MediaReadTextRequestSchema = z.strictObject({
  handleId: MediaHandleIdSchema,
  maxBytes: z.number().int().min(1).max(MAX_MEDIA_TEXT_BYTES).default(MAX_MEDIA_TEXT_BYTES)
})
export type MediaReadTextRequest = z.input<typeof MediaReadTextRequestSchema>

export const MediaReadTextResultSchema = z.strictObject({
  handleId: MediaHandleIdSchema,
  displayName: z.string().min(1).max(256),
  mimeType: z.string().min(3).max(128),
  byteSize: z.number().int().nonnegative().max(MAX_MEDIA_TEXT_BYTES),
  content: z.string().max(MAX_MEDIA_TEXT_BYTES)
}).superRefine((value, context) => {
  if (new TextEncoder().encode(value.content).byteLength !== value.byteSize) {
    context.addIssue({
      code: 'custom',
      message: 'Media text byteSize must match its UTF-8 content'
    })
  }
})
export type MediaReadTextResult = z.infer<typeof MediaReadTextResultSchema>

export const MediaReleaseRequestSchema = z.discriminatedUnion('resource', [
  z.strictObject({ resource: z.literal('handle'), handleId: MediaHandleIdSchema }),
  z.strictObject({ resource: z.literal('lease'), leaseId: MediaLeaseIdSchema })
])
export type MediaReleaseRequest = z.infer<typeof MediaReleaseRequestSchema>

export const MediaReleaseResultSchema = z.strictObject({ released: z.boolean() })
export type MediaReleaseResult = z.infer<typeof MediaReleaseResultSchema>

export const MediaOpenViewResourceRequestSchema = z.strictObject({
  handleId: MediaHandleIdSchema,
  contributionId: z.string().min(1).max(256).optional()
})
export type MediaOpenViewResourceRequest = z.infer<typeof MediaOpenViewResourceRequestSchema>

export const MediaResourceLeaseSchema = z.strictObject({
  leaseId: MediaLeaseIdSchema,
  handleId: MediaHandleIdSchema,
  url: z.string().min(24).max(2048).regex(new RegExp('^kun-media://')),
  mimeType: z.string().min(3).max(128),
  expiresAt: z.string().datetime()
})
export type MediaResourceLease = z.infer<typeof MediaResourceLeaseSchema>

export const RationalSchema = z.strictObject({
  numerator: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  denominator: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
})
export type Rational = z.infer<typeof RationalSchema>

export const MediaStreamDispositionSchema = z.strictObject({
  default: z.boolean().default(false),
  forced: z.boolean().default(false),
  attachedPicture: z.boolean().default(false)
})
export type MediaStreamDisposition = z.infer<typeof MediaStreamDispositionSchema>

export const MediaProbeStreamSchema = z.strictObject({
  index: z.number().int().nonnegative().max(65_535),
  kind: z.enum(['video', 'audio', 'subtitle', 'data', 'attachment', 'unknown']),
  codecName: z.string().min(1).max(128).optional(),
  codecLongName: z.string().min(1).max(256).optional(),
  durationMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  timeBase: RationalSchema.optional(),
  frameRate: RationalSchema.optional(),
  width: z.number().int().positive().max(1_000_000).optional(),
  height: z.number().int().positive().max(1_000_000).optional(),
  rotationDegrees: z.number().int().min(-359).max(359).optional(),
  sampleRate: z.number().int().positive().max(10_000_000).optional(),
  channelCount: z.number().int().positive().max(1024).optional(),
  channelLayout: z.string().min(1).max(128).optional(),
  language: z.string().min(1).max(64).optional(),
  disposition: MediaStreamDispositionSchema
})
export type MediaProbeStream = z.infer<typeof MediaProbeStreamSchema>

export const MediaProbeRequestSchema = z.strictObject({ handleId: MediaHandleIdSchema })
export type MediaProbeRequest = z.infer<typeof MediaProbeRequestSchema>

export const MediaProbeResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  handleId: MediaHandleIdSchema,
  container: z.strictObject({
    formatNames: z.array(z.string().min(1).max(128)).max(32),
    formatLongName: z.string().min(1).max(256).optional(),
    durationMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    startTimeMicros: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
    bitRate: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    tags: z.record(z.string().min(1).max(128), z.string().max(4096)).optional()
  }),
  streams: z.array(MediaProbeStreamSchema).max(256)
})
export type MediaProbeResult = z.infer<typeof MediaProbeResultSchema>

export const MediaCapabilityFeatureSchema = z.enum([
  'libx264-encoder',
  'aac-encoder',
  'drawtext-filter',
  'subtitles-filter'
])
export type MediaCapabilityFeature = z.infer<typeof MediaCapabilityFeatureSchema>

export const MediaExecutableCapabilitySchema = z.strictObject({
  name: z.enum(['ffprobe', 'ffmpeg']),
  available: z.boolean(),
  version: z.string().min(1).max(512).optional(),
  features: z.array(MediaCapabilityFeatureSchema).max(16).default([])
})
export type MediaExecutableCapability = z.infer<typeof MediaExecutableCapabilitySchema>

export const MediaCapabilitiesSchema = z.strictObject({
  probedAt: z.string().datetime(),
  ffprobe: MediaExecutableCapabilitySchema,
  ffmpeg: MediaExecutableCapabilitySchema
})
export type MediaCapabilities = z.infer<typeof MediaCapabilitiesSchema>

const FfmpegBindingNameSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/)

export const MediaTextOutputMimeTypeSchema = z.enum([
  'application/x-subrip',
  'text/vtt'
])
export type MediaTextOutputMimeType = z.infer<typeof MediaTextOutputMimeTypeSchema>

export const MediaTextOutputSchema = z.strictObject({
  handleId: MediaHandleIdSchema,
  mimeType: MediaTextOutputMimeTypeSchema,
  content: z.string().min(1).max(192 * 1024)
})
export type MediaTextOutput = z.infer<typeof MediaTextOutputSchema>

const MediaTextOutputsSchema = z
  .record(FfmpegBindingNameSchema, MediaTextOutputSchema)
  .superRefine((outputs, context) => {
    if (Object.keys(outputs).length > 8) {
      context.addIssue({
        code: 'custom',
        message: 'A media job may contain at most 8 bounded text outputs'
      })
    }
    const encoder = new TextEncoder()
    const totalBytes = Object.values(outputs).reduce(
      (total, output) => total + encoder.encode(output.content).byteLength,
      0
    )
    if (totalBytes > 192 * 1024) {
      context.addIssue({
        code: 'custom',
        message: 'Media text outputs may contain at most 192 KiB of UTF-8 content in total'
      })
    }
  })

export const MediaStartFfmpegJobRequestSchema = z.strictObject({
  arguments: z.array(z.string().min(1).max(8192)).max(1024),
  inputs: z.record(FfmpegBindingNameSchema, MediaHandleIdSchema),
  outputs: z.record(FfmpegBindingNameSchema, MediaHandleIdSchema),
  textOutputs: MediaTextOutputsSchema.optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
  metadata: JsonObjectSchema.optional()
}).superRefine((request, context) => {
  const inputCount = Object.keys(request.inputs).length
  const outputCount = Object.keys(request.outputs).length
  const textOutputCount = Object.keys(request.textOutputs ?? {}).length
  const textOnly = outputCount === 0

  if (textOnly) {
    if (textOutputCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['textOutputs'],
        message: 'A text-only media job requires at least one text output'
      })
    }
    if (inputCount !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['inputs'],
        message: 'A text-only media job cannot declare FFmpeg inputs'
      })
    }
    if (request.arguments.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['arguments'],
        message: 'A text-only media job cannot declare FFmpeg arguments'
      })
    }
    return
  }

  if (inputCount === 0) {
    context.addIssue({
      code: 'custom',
      path: ['inputs'],
      message: 'An FFmpeg media job requires at least one input'
    })
  }
  if (request.arguments.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['arguments'],
      message: 'An FFmpeg media job requires at least one argument'
    })
  }
})
export type MediaStartFfmpegJobRequest = z.infer<typeof MediaStartFfmpegJobRequestSchema>

export const MediaStartFfmpegJobResultSchema = z.strictObject({ job: JobReferenceSchema })
export type MediaStartFfmpegJobResult = z.infer<typeof MediaStartFfmpegJobResultSchema>

export const MEDIA_ERROR_CODES = [
  'MEDIA_CANCELLED',
  'MEDIA_INTERACTION_REQUIRED',
  'MEDIA_PERMISSION_DENIED',
  'MEDIA_SCOPE_DENIED',
  'MEDIA_NOT_FOUND',
  'MEDIA_HANDLE_REVOKED',
  'MEDIA_EXECUTABLE_UNAVAILABLE',
  'MEDIA_INVALID_ARGUMENT',
  'MEDIA_INVALID_OUTPUT',
  'MEDIA_LIMIT_EXCEEDED',
  'MEDIA_TIMEOUT'
] as const

export const MediaErrorCodeSchema = z.enum(MEDIA_ERROR_CODES)
export type MediaErrorCode = z.infer<typeof MediaErrorCodeSchema>

export const MediaErrorSchema = z.strictObject({
  code: MediaErrorCodeSchema,
  message: z.string().min(1).max(4096),
  operation: z.string().min(1).max(128),
  retryable: z.boolean(),
  limitCategory: z.string().min(1).max(128).optional(),
  details: JsonObjectSchema.optional()
})
export type MediaError = z.infer<typeof MediaErrorSchema>
