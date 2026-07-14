import type { AgentRunEvent, JobEvent, MediaResourceLease } from '@kun/extension-api'
import { describe, expect, it } from 'vitest'
import { classifyError } from '../src/webview/controller.js'
import {
  INITIAL_EDITOR_STATE,
  VIEW_LIMITS,
  activeCaptionAtFrame,
  activeTranscriptSegment,
  editorReducer,
  projectFrameFromSourceTime,
  proofIsStale,
  timelineSourceAtFrame,
  transcriptFrame,
  type RenderTicket
} from '../src/webview/model.js'
import { makeArtifact, makeJob, makeViewProject } from './webview-fixtures.js'

describe('video editor bounded View state', () => {
  it('bounds projections and retains revision-aware manual selection', () => {
    const project = makeViewProject()
    project.items = Array.from({ length: 620 }, (_, index) => ({
      ...project.items[0]!,
      id: `item-${index}`,
      timelineStartFrame: index * 100
    }))
    let state = editorReducer(INITIAL_EDITOR_STATE, { type: 'project', value: project })
    expect(state.project?.items).toHaveLength(VIEW_LIMITS.items)
    state = editorReducer(state, { type: 'selection', itemId: 'item-42' })
    expect(state.selectedItemId).toBe('item-42')
    state = editorReducer(state, { type: 'seek', frame: -10 })
    expect(state.playheadFrame).toBe(0)
  })

  it('keeps an ordered bounded Agent window and refreshes authoritative revisions', () => {
    let state = editorReducer(INITIAL_EDITOR_STATE, { type: 'project', value: makeViewProject() })
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      const event: AgentRunEvent = {
        runId: 'run-1',
        threadId: 'thread-1',
        sequence,
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'progress',
        message: `event ${sequence}`
      }
      state = editorReducer(state, { type: 'agent-event', value: event })
    }
    expect(state.agentEvents).toHaveLength(VIEW_LIMITS.agentEvents)
    expect(state.agentEvents[0]?.sequence).toBe(45)
    expect(state.agentEvents.at(-1)?.sequence).toBe(300)

    state = editorReducer(state, { type: 'conflict', expectedRevision: 0, currentRevision: 1 })
    expect(state.conflict).toEqual({ expectedRevision: 0, currentRevision: 1 })
    state = editorReducer(state, { type: 'project', value: { ...makeViewProject(), currentRevision: 1 } })
    expect(state.conflict).toBeUndefined()
    expect(state.project?.currentRevision).toBe(1)
  })

  it('revokes stale media leases without retaining reusable URLs', () => {
    const lease: MediaResourceLease = {
      leaseId: 'lease_1234567890abcdef',
      handleId: 'media_1234567890abcdef',
      url: 'kun-media://session/token1234567890',
      mimeType: 'video/mp4',
      expiresAt: '2026-01-01T00:10:00.000Z'
    }
    let state = editorReducer(INITIAL_EDITOR_STATE, { type: 'lease', value: lease })
    state = editorReducer(state, { type: 'active-media', handleId: lease.handleId, url: lease.url })
    state = editorReducer(state, { type: 'media-revoked', handleId: lease.handleId })
    expect(state.activeMediaUrl).toBeUndefined()
    expect(state.leases[lease.handleId]).toBeUndefined()
    expect(state.revokedHandles).toContain(lease.handleId)
  })

  it('reconciles durable job events and fences proof staleness by revision', () => {
    const snapshot = makeJob('running')
    let state = editorReducer(INITIAL_EDITOR_STATE, { type: 'jobs', value: [snapshot] })
    const event: JobEvent = {
      schemaVersion: 1,
      jobId: snapshot.id,
      kind: snapshot.kind,
      type: 'completed',
      state: 'completed',
      timestamp: '2026-01-01T00:02:00.000Z',
      executionAttempt: 1,
      sequence: 2,
      cursor: 'cursor_2',
      result: { schemaVersion: 1, generatedArtifacts: [makeArtifact(snapshot.id)] }
    }
    state = editorReducer(state, { type: 'job-event', value: event })
    expect(state.jobs[0]?.state).toBe('completed')
    expect(state.jobs[0]?.result?.generatedArtifacts).toHaveLength(1)

    const ticket: RenderTicket = {
      jobId: snapshot.id,
      projectId: 'demo-project',
      pinnedRevision: 0,
      renderKind: 'proof-frame',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    expect(proofIsStale(ticket, { ...makeViewProject(), currentRevision: 1 })).toBe(true)
    expect(proofIsStale(ticket, makeViewProject())).toBe(false)
  })

  it('classifies protected interaction and keeps transcript seek frame-native', () => {
    const notice = classifyError(
      { code: 'INTERACTION_REQUIRED', message: 'Desktop interaction required', retryable: true },
      'failed'
    )
    expect(notice.interactionRequired).toBe(true)
    expect(notice.severity).toBe('warning')
    expect(transcriptFrame(makeViewProject(), { startUs: 1_000_000 })).toBe(30)
    const shifted = makeViewProject()
    shifted.items[0] = {
      ...shifted.items[0]!,
      timelineStartFrame: 30,
      sourceStartUs: 1_000_000,
      sourceEndUs: 3_000_000,
      durationFrames: 60
    }
    expect(activeTranscriptSegment(shifted, 'asset-1', 30)?.id).toBe('segment-2')
  })

  it('maps the composed playhead through trims and speed to the source player and captions', () => {
    const project = makeViewProject()
    project.items = [{
      ...project.items[0]!,
      timelineStartFrame: 60,
      durationFrames: 30,
      sourceStartUs: 1_000_000,
      sourceEndUs: 3_000_000,
      speed: { numerator: 2, denominator: 1 }
    }]
    project.captions = [{
      id: 'caption-active',
      trackId: 'captions-1',
      startFrame: 70,
      endFrame: 80,
      text: 'Mapped caption',
      placement: 'bottom'
    }]

    const source = timelineSourceAtFrame(project, 75)
    expect(source).toMatchObject({
      sourceTimeUs: 2_000_000,
      playbackRate: 2,
      item: { timelineStartFrame: 60 }
    })
    expect(projectFrameFromSourceTime(project, source!, 2)).toBe(75)
    expect(activeCaptionAtFrame(project, 75)?.text).toBe('Mapped caption')
    expect(activeCaptionAtFrame(project, 80)).toBeUndefined()
  })

  it('clears media, jobs, selections, script and Agent state when switching projects', () => {
    const first = makeViewProject()
    const second = { ...makeViewProject(), id: 'second-project', name: 'Second' }
    let state = editorReducer(INITIAL_EDITOR_STATE, { type: 'project', value: first })
    state = {
      ...state,
      selectedItemId: first.items[0]?.id,
      selectedAssetId: first.assets[0]?.id,
      activeMediaHandleId: first.assets[0]?.mediaHandleId,
      activeMediaUrl: 'kun-media://lease/first',
      script: { revision: 0, digest: 'digest', markdown: '# first', dirty: false },
      jobs: [makeJob('running')],
      agentRun: {
        id: 'run-1', threadId: 'thread-1', ownerExtensionId: 'kun-examples.kun-video-editor',
        ownerExtensionVersion: '0.1.0', extensionVisibility: 'private', extensionBudget: {},
        toolCatalogEpoch: 'epoch', state: 'running', createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    }
    state = editorReducer(state, { type: 'project', value: second })
    expect(state).toMatchObject({
      project: { id: 'second-project' },
      playheadFrame: 0,
      playing: false,
      media: {},
      leases: {},
      jobs: [],
      agentEvents: []
    })
    expect(state.activeMediaUrl).toBeUndefined()
    expect(state.selectedItemId).toBeUndefined()
    expect(state.script).toBeUndefined()
    expect(state.agentRun).toBeUndefined()
  })
})
