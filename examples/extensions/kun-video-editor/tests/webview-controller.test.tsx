import type { ExtensionHostClient, HostMessage, JobEvent, JsonValue, Locale, Theme } from '@kun/extension-api'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactUsesPlayer, useEditorController, type EditorController } from '../src/webview/controller.js'
import { formatMessage, messagesFor } from '../src/webview/i18n.js'
import type { EditorNotice } from '../src/webview/model.js'
import { makeArtifact, makeJob, makeSubtitleArtifact, makeViewProject } from './webview-fixtures.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let renderer: ReactTestRenderer | undefined

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})

describe('video editor artifact controller integration', () => {
  it('keeps player media on leases and routes subtitle open/reveal through the trusted Host action', async () => {
    const openViewResource = vi.fn(async ({ handleId }: { handleId: string }) => ({
      leaseId: `lease_${handleId}`,
      handleId,
      url: `kun-media://lease/${handleId}`,
      mimeType: 'image/png',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
    const performArtifactAction = vi.fn(async () => ({ performed: true as const }))
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [] } }
      return { content: {} }
    })
    const { client } = fakeClient({ openViewResource, performArtifactAction, executeCommand })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const proof = makeArtifact('job_12345678')
    const subtitle = makeSubtitleArtifact('job_12345678')
    expect(artifactUsesPlayer(proof)).toBe(true)
    expect(artifactUsesPlayer(subtitle)).toBe(false)

    await act(async () => controller!.openArtifact(proof))
    expect(openViewResource).toHaveBeenCalledWith({
      handleId: proof.mediaHandleId
    })
    expect(performArtifactAction).not.toHaveBeenCalled()

    await act(async () => controller!.openArtifact(subtitle))
    await act(async () => controller!.revealArtifact(subtitle))
    expect(performArtifactAction).toHaveBeenNthCalledWith(1, {
      artifactId: subtitle.artifactId,
      action: 'open'
    })
    expect(performArtifactAction).toHaveBeenNthCalledWith(2, {
      artifactId: subtitle.artifactId,
      action: 'reveal'
    })
    expect(openViewResource).toHaveBeenCalledTimes(1)
    expect(executeCommand).not.toHaveBeenCalledWith('reveal-artifact', expect.anything())
  })

  it('keeps Kun theme and locale when project initialization fails', async () => {
    let resolveLocale!: (value: Locale) => void
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') {
        await Promise.resolve()
        throw new Error('Extension operation failed')
      }
      return { content: {} }
    })
    const { client } = fakeClient({
      executeCommand,
      getTheme: async () => lightTheme(),
      getLocale: () => new Promise<Locale>((resolve) => { resolveLocale = resolve })
    })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    expect(controller?.state.initialized).toBe(true)
    expect(controller?.state.connection).toBe('offline')
    expect(controller?.state.theme?.kind).toBe('light')
    expect(controller?.state.locale).toBeUndefined()
    expect(controller?.state.notices.at(-1)?.messageKey).toBe('editorInitializeFailed')

    await act(async () => {
      resolveLocale(zhLocale())
      await flushAsync()
    })

    expect(controller?.state.locale?.language).toBe('zh-CN')
    expect(localizedNotice(controller!.state.notices.at(-1)!, controller!.state.locale)).toBe('视频编辑器初始化失败。')
  })

  it('applies live Kun theme and language changes', async () => {
    const { client, emitTheme, emitLocale, emitMessage } = fakeClient()
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    expect(controller?.state.theme?.kind).toBe('dark')
    expect(controller?.state.locale?.language).toBe('en')

    await act(async () => {
      emitMessage({
        channel: 'kun-video-editor.command-progress',
        payload: { schemaVersion: 1, message: 'Submitting durable media job' }
      })
      await flushAsync()
    })

    expect(controller?.state.notices.at(-1)?.message).toBe('Submitting the media job…')

    await act(async () => {
      emitTheme(lightTheme())
      emitLocale(zhLocale())
      await flushAsync()
    })

    expect(controller?.state.theme?.kind).toBe('light')
    expect(controller?.state.locale?.language).toBe('zh-CN')
    expect(localizedNotice(controller!.state.notices.at(-1)!, controller!.state.locale)).toBe('正在提交媒体任务…')
  })

  it('does not let delayed initial values overwrite newer Kun events', async () => {
    let resolveTheme!: (value: Theme) => void
    let resolveLocale!: (value: Locale) => void
    const { client, emitTheme, emitLocale } = fakeClient({
      getTheme: () => new Promise<Theme>((resolve) => { resolveTheme = resolve }),
      getLocale: () => new Promise<Locale>((resolve) => { resolveLocale = resolve })
    })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client,
        capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      emitTheme(lightTheme())
      emitLocale(zhLocale())
      resolveTheme(darkTheme())
      resolveLocale(enLocale())
      await flushAsync()
    })

    expect(controller?.state.theme?.kind).toBe('light')
    expect(controller?.state.locale?.language).toBe('zh-CN')
  })

  it('imports a protected transcript as bounded UTF-8 and releases its source handle', async () => {
    const project = makeViewProject()
    const transcriptHandle = 'media_transcript_1234567890'
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'transcript.import') return { content: { outcome: 'transcribed', currentRevision: 1, details: { segmentCount: 1 } } }
      return { content: {} }
    })
    const pickFiles = vi.fn(async () => ({
      outcome: 'selected' as const,
      files: [{
        handleId: transcriptHandle, mode: 'read' as const, kind: 'subtitle' as const,
        displayName: 'interview.srt', mimeType: 'application/x-subrip', byteSize: 48
      }]
    }))
    const readText = vi.fn(async () => ({
      handleId: transcriptHandle,
      displayName: 'interview.srt',
      mimeType: 'application/x-subrip',
      content: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
      byteSize: 44
    }))
    const release = vi.fn(async () => ({ released: true }))
    const { client } = fakeClient({ executeCommand, pickFiles, readText, release })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      await controller!.importTranscript()
      await flushAsync()
    })

    expect(readText).toHaveBeenCalledWith({ handleId: transcriptHandle, maxBytes: 512 * 1024 })
    expect(executeCommand).toHaveBeenCalledWith('editor-request', {
      action: 'transcript.import',
      payload: expect.objectContaining({
        projectId: project.id,
        assetId: project.assets[0]!.id,
        format: 'srt',
        source: expect.stringContaining('Hello')
      })
    })
    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: transcriptHandle })
  })

  it('keeps the revision unchanged and releases selected handles when media import is unavailable', async () => {
    const project = makeViewProject()
    const mediaHandle = 'media_unavailable_1234567890'
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'media.import') {
        return { content: {
          outcome: 'unavailable',
          code: 'FFPROBE_UNAVAILABLE',
          currentRevision: project.currentRevision,
          changedIds: []
        } }
      }
      return { content: {} }
    })
    const pickFiles = vi.fn(async () => ({
      outcome: 'selected' as const,
      files: [{
        handleId: mediaHandle, mode: 'read' as const, kind: 'video' as const,
        displayName: 'interview.mp4', mimeType: 'video/mp4', byteSize: 1_024
      }]
    }))
    const release = vi.fn(async () => ({ released: true }))
    const { client } = fakeClient({ executeCommand, pickFiles, release })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    const projectReadsBeforeImport = executeCommand.mock.calls.filter(([, args]) =>
      isRecord(args) && args.action === 'project.get'
    ).length

    await act(async () => {
      await controller!.importMedia()
      await flushAsync()
    })

    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: mediaHandle })
    expect(controller?.state.project?.currentRevision).toBe(project.currentRevision)
    expect(controller?.state.notices.at(-1)).toMatchObject({
      severity: 'warning',
      messageKey: 'ffprobeUnavailable'
    })
    expect(executeCommand.mock.calls.filter(([, args]) =>
      isRecord(args) && args.action === 'project.get'
    )).toHaveLength(projectReadsBeforeImport + 1)
  })

  it('keeps completed imports and releases unbound handles after a later batch item fails', async () => {
    let project = makeViewProject()
    const firstHandle = 'media_batch_first_1234567890'
    const secondHandle = 'media_batch_second_123456789'
    let importCall = 0
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'media.import') {
        importCall += 1
        if (importCall === 2) throw new Error('The second media file could not be probed')
        project = {
          ...project,
          currentRevision: project.currentRevision + 1,
          assets: [...project.assets, {
            ...project.assets[0]!, id: 'batch-first', name: 'first.mp4', mediaHandleId: firstHandle
          }]
        }
        return { content: { outcome: 'imported', currentRevision: project.currentRevision } }
      }
      return { content: {} }
    })
    const pickFiles = vi.fn(async () => ({
      outcome: 'selected' as const,
      files: [firstHandle, secondHandle].map((handleId, index) => ({
        handleId, mode: 'read' as const, kind: 'video' as const,
        displayName: `${index + 1}.mp4`, mimeType: 'video/mp4', byteSize: 1_024
      }))
    }))
    const release = vi.fn(async () => ({ released: true }))
    const { client } = fakeClient({ executeCommand, pickFiles, release })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      await controller!.importMedia()
      await flushAsync()
    })

    expect(controller?.state.project?.currentRevision).toBe(1)
    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: secondHandle })
    expect(release).not.toHaveBeenCalledWith({ resource: 'handle', handleId: firstHandle })
    expect(controller?.state.notices).toContainEqual(expect.objectContaining({
      severity: 'warning',
      messageKey: 'mediaImportPartial',
      messageValues: { count: 1 }
    }))
  })

  it('refreshes timeline markdown against the committed revision after applying a range', async () => {
    let project = makeViewProject()
    const scriptReadRevisions: number[] = []
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      const payload = isRecord(request.payload) ? request.payload : {}
      if (action === 'project.list') {
        return { content: { projects: [{
          id: project.id,
          name: project.name,
          currentRevision: project.currentRevision,
          updatedAt: project.updatedAt,
          durationFrames: project.durationFrames
        }] } }
      }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'script.read') {
        const expectedRevision = Number(payload.expectedRevision)
        scriptReadRevisions.push(expectedRevision)
        if (expectedRevision !== project.currentRevision) throw new Error('REVISION_CONFLICT')
        return {
          content: {
            currentRevision: project.currentRevision,
            digest: `digest-r${project.currentRevision}`,
            timelineMarkdown: `# Timeline r${project.currentRevision}`
          }
        }
      }
      if (action === 'script.apply') {
        expect(payload.expectedRevision).toBe(project.currentRevision)
        project = { ...project, currentRevision: project.currentRevision + 1 }
        return { content: { currentRevision: project.currentRevision } }
      }
      return { content: {} }
    })
    const { client } = fakeClient({ executeCommand })
    let controller: EditorController | undefined

    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    const segment = project.transcripts[0]!.segments[1]!
    await act(async () => {
      await controller!.applyScript([{
        assetId: project.assets[0]!.id,
        startUs: segment.startUs,
        endUs: segment.endUs,
        reason: 'filler'
      }])
      await flushAsync()
    })

    expect(scriptReadRevisions).toEqual([0, 1])
    expect(controller?.state.project?.currentRevision).toBe(1)
    expect(controller?.state.script).toMatchObject({
      revision: 1,
      digest: 'digest-r1',
      markdown: '# Timeline r1'
    })
    expect(controller?.state.notices.filter(({ severity }) => severity === 'error')).toEqual([])
  })

  it('releases selected export handles when the Host reports a normal capability failure', async () => {
    const project = makeViewProject()
    const outputHandle = 'media_export_unavailable_1234'
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'render.start') {
        return { content: {
          outcome: 'unavailable',
          code: 'FFMPEG_UNAVAILABLE',
          currentRevision: project.currentRevision,
          changedIds: []
        } }
      }
      return { content: {} }
    })
    const pickSaveTarget = vi.fn(async () => ({
      outcome: 'selected' as const,
      target: {
        handleId: outputHandle, mode: 'write' as const, kind: 'video' as const,
        displayName: 'output.mp4', mimeType: 'video/mp4', byteSize: 0
      }
    }))
    const release = vi.fn(async () => ({ released: true }))
    const { client } = fakeClient({ executeCommand, pickSaveTarget, release })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      await controller!.startRender('h264-mp4', 'none')
      await flushAsync()
    })

    expect(release).toHaveBeenCalledWith({ resource: 'handle', handleId: outputHandle })
    expect(controller?.state.renderTickets).toEqual([])
    expect(controller?.state.notices.at(-1)).toMatchObject({
      severity: 'warning',
      messageKey: 'ffmpegUnavailable'
    })
  })

  it('reconciles a completed durable job when its live terminal event is missed', async () => {
    const project = makeViewProject()
    const runningJob = makeJob('running')
    const completedJob = {
      ...makeJob('completed'),
      updatedAt: '2026-01-01T00:02:00.000Z',
      terminalAt: '2026-01-01T00:02:00.000Z',
      latestCursor: 'cursor_2',
      result: { schemaVersion: 1 as const, generatedArtifacts: [] }
    }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'render.start') {
        return { content: {
          outcome: 'queued',
          jobId: runningJob.id,
          pinnedRevision: project.currentRevision,
          renderKind: 'h264-mp4'
        } }
      }
      return { content: {} }
    })
    const getJob = vi.fn()
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValue(completedJob)
    const subscribeJob = vi.fn(async () => ({
      snapshot: runningJob,
      replayGap: false,
      cursor: runningJob.latestCursor,
      complete: false,
      onEvent: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    }))
    const pickSaveTarget = vi.fn(async () => ({
      outcome: 'selected' as const,
      target: {
        handleId: 'media_export_reconcile_1234', mode: 'write' as const, kind: 'video' as const,
        displayName: 'output.mp4', mimeType: 'video/mp4', byteSize: 0
      }
    }))
    const { client } = fakeClient({ executeCommand, getJob, subscribeJob, pickSaveTarget })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    vi.useFakeTimers()
    await act(async () => {
      await controller!.startRender('h264-mp4', 'none')
      await flushAsync()
    })
    expect(controller?.state.jobs).toMatchObject([{ id: runningJob.id, state: 'running' }])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsync()
    })

    expect(subscribeJob).toHaveBeenCalledWith({
      jobId: runningJob.id,
      afterCursor: runningJob.latestCursor
    })
    expect(getJob).toHaveBeenCalledTimes(2)
    expect(controller?.state.jobs).toMatchObject([{ id: completedJob.id, state: 'completed' }])
  })

  it('registers replay delivery before reading the subscription snapshot', async () => {
    const project = makeViewProject()
    const runningJob = makeJob('running')
    const completedJob = {
      ...makeJob('completed'),
      updatedAt: '2026-01-01T00:02:00.000Z',
      terminalAt: '2026-01-01T00:02:00.000Z',
      latestCursor: 'cursor_2',
      result: { schemaVersion: 1 as const, generatedArtifacts: [] }
    }
    const terminalEvent: JobEvent = {
      schemaVersion: 1,
      jobId: runningJob.id,
      kind: runningJob.kind,
      type: 'completed',
      state: 'completed',
      timestamp: completedJob.updatedAt,
      executionAttempt: completedJob.executionAttempt,
      sequence: 2,
      cursor: completedJob.latestCursor,
      result: completedJob.result
    }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'render.start') {
        return { content: {
          outcome: 'queued', jobId: runningJob.id,
          pinnedRevision: project.currentRevision, renderKind: 'h264-mp4'
        } }
      }
      return { content: {} }
    })
    const accessOrder: string[] = []
    let replaySnapshot = runningJob
    const subscribeJob = vi.fn(async () => ({
      get snapshot() {
        accessOrder.push('snapshot')
        return replaySnapshot
      },
      replayGap: false,
      cursor: runningJob.latestCursor,
      complete: false,
      onEvent: (listener: (event: JobEvent) => void) => {
        accessOrder.push('onEvent')
        replaySnapshot = completedJob
        listener(terminalEvent)
        return { dispose: () => undefined }
      },
      dispose: () => undefined
    }))
    const pickSaveTarget = vi.fn(async () => ({
      outcome: 'selected' as const,
      target: {
        handleId: 'media_export_replay_123456', mode: 'write' as const, kind: 'video' as const,
        displayName: 'output.mp4', mimeType: 'video/mp4', byteSize: 0
      }
    }))
    const { client } = fakeClient({
      executeCommand,
      getJob: vi.fn(async () => runningJob),
      subscribeJob,
      pickSaveTarget
    })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      await controller!.startRender('h264-mp4', 'none')
      await flushAsync()
    })

    expect(accessOrder.slice(0, 2)).toEqual(['onEvent', 'snapshot'])
    expect(controller?.state.jobs).toMatchObject([{ id: completedJob.id, state: 'completed' }])
  })

  it('does not let a late status read regress a live terminal job event', async () => {
    const project = makeViewProject()
    const runningJob = makeJob('running')
    const staleRunningJob = {
      ...runningJob,
      updatedAt: '2026-01-01T00:03:00.000Z',
      latestCursor: 'cursor_stale'
    }
    const completedJob = {
      ...makeJob('completed'),
      updatedAt: '2026-01-01T00:02:00.000Z',
      terminalAt: '2026-01-01T00:02:00.000Z',
      latestCursor: 'cursor_terminal',
      result: { schemaVersion: 1 as const, generatedArtifacts: [] }
    }
    const terminalEvent: JobEvent = {
      schemaVersion: 1,
      jobId: runningJob.id,
      kind: runningJob.kind,
      type: 'completed',
      state: 'completed',
      timestamp: completedJob.updatedAt,
      executionAttempt: completedJob.executionAttempt,
      sequence: 2,
      cursor: completedJob.latestCursor,
      result: completedJob.result
    }
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const action = isRecord(args) ? args.action : undefined
      if (action === 'project.list') return { content: { projects: [{
        id: project.id, name: project.name, currentRevision: project.currentRevision,
        updatedAt: project.updatedAt, durationFrames: project.durationFrames
      }] } }
      if (action === 'project.active' || action === 'project.get') return { content: { project } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'render.start') {
        return { content: {
          outcome: 'queued', jobId: runningJob.id,
          pinnedRevision: project.currentRevision, renderKind: 'h264-mp4'
        } }
      }
      return { content: {} }
    })
    let resolveLateRead!: (snapshot: typeof staleRunningJob) => void
    const lateRead = new Promise<typeof staleRunningJob>((resolve) => { resolveLateRead = resolve })
    const getJob = vi.fn()
      .mockResolvedValueOnce(runningJob)
      .mockImplementationOnce(async () => await lateRead)
      .mockResolvedValue(completedJob)
    let deliverJobEvent: ((event: JobEvent) => void) | undefined
    const subscribeJob = vi.fn(async () => ({
      snapshot: runningJob,
      replayGap: false,
      cursor: runningJob.latestCursor,
      complete: false,
      onEvent: (listener: (event: JobEvent) => void) => {
        deliverJobEvent = listener
        return { dispose: () => undefined }
      },
      dispose: () => undefined
    }))
    const pickSaveTarget = vi.fn(async () => ({
      outcome: 'selected' as const,
      target: {
        handleId: 'media_export_interleave_1234', mode: 'write' as const, kind: 'video' as const,
        displayName: 'output.mp4', mimeType: 'video/mp4', byteSize: 0
      }
    }))
    const { client } = fakeClient({ executeCommand, getJob, subscribeJob, pickSaveTarget })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    vi.useFakeTimers()
    await act(async () => {
      await controller!.startRender('h264-mp4', 'none')
      await flushAsync()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsync()
    })
    expect(getJob).toHaveBeenCalledTimes(2)
    expect(deliverJobEvent).toBeTypeOf('function')

    await act(async () => {
      deliverJobEvent!(terminalEvent)
      resolveLateRead(staleRunningJob)
      await flushAsync()
    })

    expect(controller?.state.jobs).toMatchObject([{ id: completedJob.id, state: 'completed' }])
  })

  it('opens result-preview media from the Host message without loading the full project editor', async () => {
    const openViewResource = vi.fn(async ({ handleId }: { handleId: string }) => ({
      leaseId: `lease_${handleId}`,
      handleId,
      url: `kun-media://lease/${handleId}`,
      mimeType: 'video/mp4',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
    const { client, emitMessage } = fakeClient({ openViewResource })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      emitMessage({
        channel: 'kun.resultPreview.open',
        payload: {
          schemaVersion: 1, threadId: 'thread-1', turnId: 'turn-1',
          result: {
            sourceId: 'artifact-source', mimeType: 'video/mp4',
            mediaHandleId: 'media_preview_1234567890', availability: 'available'
          }
        }
      })
      await flushAsync()
    })
    expect(controller?.state.resultPreview?.result.sourceId).toBe('artifact-source')
    expect(openViewResource).toHaveBeenCalledWith({ handleId: 'media_preview_1234567890' })
    expect(controller?.state.activeMediaUrl).toContain('kun-media://lease/')
  })

  it('keeps the newest active project when an older project load resolves late', async () => {
    const first = { ...makeViewProject(), id: 'project-first', name: 'First' }
    const second = { ...makeViewProject(), id: 'project-second', name: 'Second' }
    let resolveFirst!: (value: { content: { project: typeof first } }) => void
    const firstLoad = new Promise<{ content: { project: typeof first } }>((resolve) => {
      resolveFirst = resolve
    })
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      const payload = isRecord(request.payload) ? request.payload : {}
      if (action === 'project.get' && payload.projectId === first.id) return await firstLoad
      if (action === 'project.get' && payload.projectId === second.id) return { content: { project: second } }
      if (action === 'project.list') return { content: { projects: [] } }
      return { content: {} }
    })
    const { client, emitMessage } = fakeClient({ executeCommand })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })
    await act(async () => {
      emitMessage(projectChangedMessage(first.id))
      await Promise.resolve()
      emitMessage(projectChangedMessage(second.id))
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(second.id)
    await act(async () => {
      resolveFirst({ content: { project: first } })
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(second.id)
  })

  it('does not let a delayed startup active-project query overwrite a newer active-project event', async () => {
    const startupProject = { ...makeViewProject(), id: 'project-startup', name: 'Startup project' }
    const eventProject = { ...makeViewProject(), id: 'project-event', name: 'Event project' }
    let resolveActive!: (value: { content: { project: typeof startupProject } }) => void
    const activeRequest = new Promise<{ content: { project: typeof startupProject } }>((resolve) => {
      resolveActive = resolve
    })
    const executeCommand = vi.fn(async (_id: string, args?: JsonValue) => {
      const request = isRecord(args) ? args : {}
      const action = request.action
      const payload = isRecord(request.payload) ? request.payload : {}
      if (action === 'project.list') return { content: { projects: [] } }
      if (action === 'render.list') return { content: { records: [] } }
      if (action === 'project.active') return await activeRequest
      if (action === 'project.get' && payload.projectId === eventProject.id) {
        return { content: { project: eventProject } }
      }
      if (action === 'project.get' && payload.projectId === startupProject.id) {
        return { content: { project: startupProject } }
      }
      return { content: {} }
    })
    const { client, emitMessage } = fakeClient({ executeCommand })
    let controller: EditorController | undefined
    await act(async () => {
      renderer = create(createElement(CaptureController, {
        client, capture: (value: EditorController) => { controller = value }
      }))
      await flushAsync()
    })

    await act(async () => {
      emitMessage(projectChangedMessage(eventProject.id))
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(eventProject.id)

    await act(async () => {
      resolveActive({ content: { project: startupProject } })
      await flushAsync()
    })
    expect(controller?.state.project?.id).toBe(eventProject.id)
    expect(executeCommand).not.toHaveBeenCalledWith('editor-request', {
      action: 'project.get',
      payload: { projectId: startupProject.id }
    })
  })
})

function CaptureController(props: {
  client: ExtensionHostClient
  capture(controller: EditorController): void
}): null {
  props.capture(useEditorController(props.client))
  return null
}

function fakeClient(input: {
  openViewResource?: ReturnType<typeof vi.fn>
  performArtifactAction?: ReturnType<typeof vi.fn>
  executeCommand?: ReturnType<typeof vi.fn>
  getTheme?: () => Promise<Theme>
  getLocale?: () => Promise<Locale>
  pickFiles?: ReturnType<typeof vi.fn>
  pickSaveTarget?: ReturnType<typeof vi.fn>
  readText?: ReturnType<typeof vi.fn>
  release?: ReturnType<typeof vi.fn>
  getJob?: ReturnType<typeof vi.fn>
  subscribeJob?: ReturnType<typeof vi.fn>
} = {}): {
  client: ExtensionHostClient
  emitTheme(value: Theme): void
  emitLocale(value: Locale): void
  emitMessage(value: HostMessage): void
} {
  const themeListeners = new Set<(value: Theme) => void>()
  const localeListeners = new Set<(value: Locale) => void>()
  const messageListeners = new Set<(value: HostMessage) => void>()
  const event = () => ({ dispose: () => undefined })
  const executeCommand = input.executeCommand ?? vi.fn(async (_id: string, args?: JsonValue) => {
    const action = isRecord(args) ? args.action : undefined
    return action === 'project.list' ? { content: { projects: [] } } : { content: {} }
  })
  const client = {
    commands: { executeCommand },
    media: {
      getCapabilities: vi.fn(async () => ({
        probedAt: '2026-01-01T00:00:00.000Z',
        ffmpeg: {
          name: 'ffmpeg', available: true,
          features: ['libx264-encoder', 'aac-encoder']
        },
        ffprobe: { name: 'ffprobe', available: true, features: [] }
      })),
      pickFiles: input.pickFiles ?? vi.fn(),
      pickSaveTarget: input.pickSaveTarget ?? vi.fn(),
      readText: input.readText ?? vi.fn(),
      openViewResource: input.openViewResource ?? vi.fn(),
      performArtifactAction: input.performArtifactAction ?? vi.fn(),
      release: input.release ?? vi.fn(async () => ({ released: true }))
    },
    jobs: {
      list: vi.fn(async () => ({ items: [] })),
      get: input.getJob ?? vi.fn(),
      subscribe: input.subscribeJob ?? vi.fn()
    },
    agent: {},
    ui: {
      getTheme: vi.fn(input.getTheme ?? (async () => darkTheme())),
      getLocale: vi.fn(input.getLocale ?? (async () => enLocale())),
      getViewState: vi.fn(async () => undefined),
      setViewState: vi.fn(async () => undefined),
      onDidChangeTheme: (listener: (value: Theme) => void) => {
        themeListeners.add(listener)
        return { dispose: () => themeListeners.delete(listener) }
      },
      onDidChangeLocale: (listener: (value: Locale) => void) => {
        localeListeners.add(listener)
        return { dispose: () => localeListeners.delete(listener) }
      },
      onDidReceiveMessage: (listener: (value: HostMessage) => void) => {
        messageListeners.add(listener)
        return { dispose: () => messageListeners.delete(listener) }
      }
    },
    onDidError: event
  } as unknown as ExtensionHostClient
  return {
    client,
    emitTheme: (value) => { for (const listener of themeListeners) listener(value) },
    emitLocale: (value) => { for (const listener of localeListeners) listener(value) },
    emitMessage: (value) => { for (const listener of messageListeners) listener(value) }
  }
}

function darkTheme(): Theme {
  return { kind: 'dark', tokens: {}, zoomFactor: 1, reducedMotion: false }
}

function lightTheme(): Theme {
  return { kind: 'light', tokens: {}, zoomFactor: 1, reducedMotion: false }
}

function enLocale(): Locale {
  return { language: 'en', direction: 'ltr', messages: {} }
}

function zhLocale(): Locale {
  return { language: 'zh-CN', direction: 'ltr', messages: {} }
}

function projectChangedMessage(projectId: string): HostMessage {
  return {
    channel: 'kun-video-editor.active-project-changed',
    payload: {
      schemaVersion: 1,
      projectId,
      revision: 0,
      reason: 'active-project-changed',
      changedIds: ['active-project']
    }
  }
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localizedNotice(notice: EditorNotice, locale: Locale | undefined): string {
  return notice.messageKey
    ? formatMessage(messagesFor(locale)[notice.messageKey], notice.messageValues)
    : notice.message
}
