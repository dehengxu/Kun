import { describe, expect, it } from 'vitest'
import {
  ArtifactHostActionRequestSchema,
  ArtifactHostActionResultSchema,
  GeneratedArtifactSchema,
  JobEventSchema,
  JobProgressSchema,
  JobSnapshotSchema,
  MediaMetadataSchema,
  MediaCapabilitiesSchema,
  MediaProbeResultSchema,
  MediaReadTextRequestSchema,
  MediaReadTextResultSchema,
  MediaResourceLeaseSchema,
  MediaStartFfmpegJobRequestSchema,
  PermissionSchema,
  ResultPreviewSourceSchema,
  ToolResultSchema,
  isExtensionViewSafeMethod
} from '../src/index.js'

const handleId = 'media_handle_000001'
const artifactId = 'artifact_ref_000001'
const jobId = 'job_0001'
const now = '2026-07-13T00:00:00.000Z'

const artifact = {
  schemaVersion: 1,
  artifactId,
  ownerExtensionId: 'acme.video-editor',
  ownerExtensionVersion: '1.1.0',
  workspaceId: 'workspace-1',
  mediaHandleId: handleId,
  displayName: 'export.mp4',
  mediaKind: 'video',
  mimeType: 'video/mp4',
  byteSize: 1024,
  completionIdentity: 'sha256:fake-completion-identity',
  provenance: { jobId, operation: 'media.ffmpeg' }
} as const

const snapshot = {
  schemaVersion: 1,
  id: jobId,
  kind: 'media.ffmpeg',
  kindSchemaVersion: 1,
  ownerExtensionId: 'acme.video-editor',
  ownerExtensionVersion: '1.1.0',
  workspaceId: 'workspace-1',
  initiatingOperation: 'media.startFfmpegJob',
  state: 'completed',
  executionAttempt: 1,
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  terminalAt: now,
  result: { schemaVersion: 1, generatedArtifacts: [artifact] },
  latestCursor: 'cursor_0001'
} as const

describe('Extension API v1.1 media schemas', () => {
  it('publishes the least-privilege media and job permissions', () => {
    for (const permission of ['media.read', 'media.process', 'media.export', 'jobs.manage']) {
      expect(PermissionSchema.parse(permission)).toBe(permission)
    }
  })

  it('accepts bounded opaque metadata and rejects path disclosure', () => {
    expect(MediaMetadataSchema.parse({
      handleId,
      mode: 'read',
      kind: 'video',
      displayName: 'interview.mp4',
      mimeType: 'video/mp4',
      byteSize: 2048,
      workspaceRelativeDisplayLocation: 'media/interview.mp4'
    })).toMatchObject({ handleId, revoked: false })
    expect(MediaMetadataSchema.safeParse({
      handleId: '/private/interview.mp4',
      mode: 'read',
      kind: 'video',
      displayName: 'interview.mp4'
    }).success).toBe(false)
    expect(MediaMetadataSchema.safeParse({
      handleId,
      mode: 'read',
      kind: 'video',
      displayName: 'interview.mp4',
      workspaceRelativeDisplayLocation: '/private/interview.mp4'
    }).success).toBe(false)
  })

  it('normalizes probe rationals and bounds resource leases', () => {
    expect(MediaProbeResultSchema.parse({
      schemaVersion: 1,
      handleId,
      container: { formatNames: ['mov', 'mp4'], durationMicros: 1_000_000 },
      streams: [{
        index: 0,
        kind: 'video',
        codecName: 'h264',
        frameRate: { numerator: 30_000, denominator: 1001 },
        width: 1920,
        height: 1080,
        disposition: { default: true }
      }]
    }).streams[0].frameRate).toEqual({ numerator: 30_000, denominator: 1001 })
    expect(MediaResourceLeaseSchema.parse({
      leaseId: 'media_lease_000001',
      handleId,
      url: 'kun-media://lease/media_lease_000001',
      mimeType: 'video/mp4',
      expiresAt: now
    }).url).toMatch(/^kun-media:/)
  })

  it('defines bounded UTF-8 text reads without exposing a path', () => {
    expect(MediaReadTextRequestSchema.parse({ handleId, maxBytes: 32 })).toEqual({
      handleId,
      maxBytes: 32
    })
    expect(MediaReadTextResultSchema.parse({
      handleId,
      displayName: 'captions.srt',
      mimeType: 'application/x-subrip',
      byteSize: 6,
      content: '你好'
    })).toMatchObject({ handleId, content: '你好' })
    expect(MediaReadTextResultSchema.safeParse({
      handleId,
      displayName: 'captions.srt',
      mimeType: 'application/x-subrip',
      byteSize: 2,
      content: '你好'
    }).success).toBe(false)
    expect(MediaReadTextRequestSchema.safeParse({
      handleId,
      maxBytes: 512 * 1024 + 1
    }).success).toBe(false)
  })

  it('publishes bounded media executable capabilities without paths', () => {
    const capabilities = MediaCapabilitiesSchema.parse({
      probedAt: now,
      ffprobe: { name: 'ffprobe', available: true, version: '8.0.1' },
      ffmpeg: {
        name: 'ffmpeg',
        available: true,
        version: '8.0.1',
        features: ['libx264-encoder', 'aac-encoder']
      }
    })
    expect(capabilities.ffprobe.features).toEqual([])
    expect(capabilities.ffmpeg.features).toEqual(['libx264-encoder', 'aac-encoder'])
    expect(JSON.stringify(capabilities)).not.toContain('/opt/')
  })

  it('requires handle maps for FFmpeg jobs rather than file paths', () => {
    expect(MediaStartFfmpegJobRequestSchema.parse({
      arguments: ['-i', '{{input:source}}', '{{output:export}}'],
      inputs: { source: handleId },
      outputs: { export: 'media_export_00001' },
      textOutputs: {
        captions: {
          handleId: 'media_subtitle_0001',
          mimeType: 'application/x-subrip',
          content: '1\n00:00:00,000 --> 00:00:01,000\nHello\n'
        }
      }
    })).toMatchObject({
      inputs: { source: handleId },
      textOutputs: { captions: { handleId: 'media_subtitle_0001' } }
    })
    expect(MediaStartFfmpegJobRequestSchema.safeParse({
      arguments: ['-i', '/private/interview.mp4'],
      inputs: { source: '/private/interview.mp4' },
      outputs: { export: 'media_export_00001' }
    }).success).toBe(false)
    expect(MediaStartFfmpegJobRequestSchema.safeParse({
      arguments: ['-i', '{{input:source}}', '{{output:export}}'],
      inputs: { source: handleId },
      outputs: { export: 'media_export_00001' },
      textOutputs: {
        captions: {
          handleId: '/private/captions.srt',
          mimeType: 'text/html',
          content: '<script>alert(1)</script>'
        }
      }
    }).success).toBe(false)
    expect(MediaStartFfmpegJobRequestSchema.safeParse({
      arguments: ['-i', '{{input:source}}', '{{output:export}}'],
      inputs: { source: handleId },
      outputs: { export: 'media_export_00001' },
      textOutputs: {
        captions: {
          handleId: 'media_subtitle_0001',
          mimeType: 'text/vtt',
          content: '😀'.repeat(50_000)
        }
      }
    }).success).toBe(false)
  })

  it('admits bounded text-only jobs without admitting an FFmpeg command shape', () => {
    const textOnly = {
      arguments: [],
      inputs: {},
      outputs: {},
      textOutputs: {
        captions: {
          handleId: 'media_subtitle_0001',
          mimeType: 'application/x-subrip' as const,
          content: '1\n00:00:00,000 --> 00:00:01,000\nHello\n'
        }
      }
    }
    expect(MediaStartFfmpegJobRequestSchema.parse(textOnly)).toEqual(textOnly)
    expect(MediaStartFfmpegJobRequestSchema.safeParse({
      ...textOnly,
      arguments: ['-version']
    }).success).toBe(false)
    expect(MediaStartFfmpegJobRequestSchema.safeParse({
      ...textOnly,
      inputs: { source: handleId }
    }).success).toBe(false)
    expect(MediaStartFfmpegJobRequestSchema.safeParse({
      arguments: [],
      inputs: {},
      outputs: {}
    }).success).toBe(false)
    expect(MediaStartFfmpegJobRequestSchema.safeParse({
      arguments: [],
      inputs: {},
      outputs: { export: 'media_export_00001' }
    }).success).toBe(false)
  })
})

describe('Extension API v1.1 jobs and artifacts', () => {
  it('enforces coherent bounded progress', () => {
    expect(JobProgressSchema.parse({ completed: 2, total: 4, percentage: 50, updatedAt: now }))
      .toMatchObject({ completed: 2, total: 4 })
    expect(JobProgressSchema.safeParse({ completed: 5, total: 4, updatedAt: now }).success).toBe(false)
  })

  it('validates durable snapshots, events, and top-level artifacts', () => {
    expect(JobSnapshotSchema.parse(snapshot)).toMatchObject({ id: jobId, state: 'completed' })
    expect(JobEventSchema.parse({
      schemaVersion: 1,
      jobId,
      kind: 'media.ffmpeg',
      type: 'completed',
      state: 'completed',
      timestamp: now,
      executionAttempt: 1,
      sequence: 3,
      cursor: 'cursor_0003',
      result: snapshot.result
    }).sequence).toBe(3)
    expect(GeneratedArtifactSchema.parse(artifact)).toMatchObject({
      artifactId,
      availability: 'available'
    })
    expect(ToolResultSchema.parse({ content: { ok: true }, generatedArtifacts: [artifact] }))
      .toMatchObject({ generatedArtifacts: [{ artifactId }] })
  })

  it('adds artifact and media handles to result previews without weakening v1.0 sources', () => {
    expect(ResultPreviewSourceSchema.parse({
      sourceId: 'tool-1:artifact-1',
      artifactId,
      mediaHandleId: handleId,
      availability: 'available',
      mimeType: 'video/mp4',
      name: 'export.mp4'
    })).toMatchObject({ artifactId, mediaHandleId: handleId })
    expect(ResultPreviewSourceSchema.parse({
      sourceId: 'tool-1:file-1',
      relativePath: 'exports/legacy.mp4',
      mimeType: 'video/mp4'
    })).toMatchObject({ relativePath: 'exports/legacy.mp4' })
  })

  it('defines path-free Host artifact actions', () => {
    expect(ArtifactHostActionRequestSchema.parse({
      artifactId,
      action: 'reveal'
    })).toEqual({ artifactId, action: 'reveal' })
    expect(ArtifactHostActionResultSchema.parse({ performed: true })).toEqual({ performed: true })
    expect(ArtifactHostActionRequestSchema.safeParse({
      artifactId,
      action: 'open',
      absolutePath: '/private/export.mp4'
    }).success).toBe(false)
    expect(ArtifactHostActionRequestSchema.safeParse({
      artifactId,
      action: 'open',
      ownerExtensionId: 'other.extension'
    }).success).toBe(false)
  })

  it('publishes media/jobs methods in the View-safe catalog but no generic job start', () => {
    expect(isExtensionViewSafeMethod('media.openViewResource')).toBe(true)
    expect(isExtensionViewSafeMethod('media.readText')).toBe(true)
    expect(isExtensionViewSafeMethod('media.getCapabilities')).toBe(true)
    expect(isExtensionViewSafeMethod('media.performArtifactAction')).toBe(true)
    expect(isExtensionViewSafeMethod('jobs.subscribe')).toBe(true)
    expect(isExtensionViewSafeMethod('jobs.start')).toBe(false)
  })
})
