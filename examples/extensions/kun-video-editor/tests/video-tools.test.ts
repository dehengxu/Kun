import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExtensionApiError,
  parseExtensionManifest,
  type ExtensionManifest,
  type JsonObject,
  type ToolResult
} from '@kun/extension-api'
import {
  createExtensionTestHarness,
  createGeneratedArtifactFixture,
  type ExtensionTestHarness
} from '@kun/extension-test'
import { afterEach, describe, expect, it } from 'vitest'
import { activate, VIDEO_TOOL_DECLARATIONS, VIDEO_TOOL_IDS } from '../src/host/extension.js'

const roots: string[] = []
const permissions = [
  'commands.register',
  'ui.views',
  'ui.actions',
  'webview',
  'agent.run',
  'tools.register',
  'storage.workspace',
  'workspace.read',
  'workspace.write',
  'media.read',
  'media.process',
  'media.export',
  'jobs.manage'
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('video editor manifest and Agent catalog', () => {
  it('declares one private profile, nine stable tools, complete activation, and least privilege', async () => {
    const manifest = await loadManifest()
    expect(manifest.apiVersion).toBe('1.1.0')
    expect(manifest.version).toBe('0.3.0')
    expect(manifest.contributes['views.rightSidebar']).toEqual([
      expect.objectContaining({
        id: 'editor',
        entry: 'dist/webview/index.html',
        icon: 'assets/video-editor.svg'
      })
    ])
    expect(manifest.contributes['views.fullPage']).toEqual([])
    expect(manifest.contributes['actions.composer']).toEqual([])
    expect(manifest.contributes.agentProfiles).toHaveLength(1)
    const profile = manifest.contributes.agentProfiles[0]!
    expect(profile).toMatchObject({ id: 'video-editor', visibility: 'private' })
    expect(profile.allowedTools).toEqual(VIDEO_TOOL_IDS)
    expect(profile.instructions).toContain('video-project with action active')
    expect(profile.instructions).toContain('video-project with action select')
    expect(profile.instructions).toContain('video-render-cancel')
    expect(profile.instructions).toContain('not arbitrary visual-scene understanding')
    expect(profile.instructions).toContain('interaction-required')
    expect(manifest.contributes.tools).toEqual(VIDEO_TOOL_DECLARATIONS)
    expect(manifest.activationEvents).toEqual(expect.arrayContaining([
      'onView:editor',
      'onView:render-preview',
      'onCommand:editor-request',
      'onAgentProfile:video-editor',
      ...VIDEO_TOOL_IDS.map((id) => `onTool:${id}`)
    ]))
    expect(new Set(manifest.permissions)).toEqual(new Set(permissions))
    expect(manifest.permissions.some((permission) => permission.startsWith('network:'))).toBe(false)
  })

  it('keeps read/write/destructive approval classes truthful and cache-stable', () => {
    expect(Object.fromEntries(VIDEO_TOOL_DECLARATIONS.map((tool) => [tool.id, tool.sideEffects])))
      .toEqual({
        'video-project': 'write',
        'video-probe': 'write',
        'video-transcribe': 'write',
        'video-read-script': 'read',
        'video-apply-script': 'destructive',
        'video-update-timeline': 'write',
        'video-render': 'write',
        'video-render-status': 'read',
        'video-render-cancel': 'destructive'
      })
    const fingerprint = JSON.stringify(VIDEO_TOOL_DECLARATIONS)
    expect(JSON.stringify(VIDEO_TOOL_DECLARATIONS)).toBe(fingerprint)
    expect(VIDEO_TOOL_DECLARATIONS).toHaveLength(9)
  })

  it('keeps the manifest and Host command catalog aligned without artifact shell commands', async () => {
    const manifest = await loadManifest()
    const harness = await activatedHarness()
    const declared = manifest.contributes.commands.map(({ id }) => id).sort()
    const registered = harness.transport.requests
      .filter(({ method }) => method === 'commands.register')
      .map(({ params }) => String((params as JsonObject).id))
      .sort()
    expect(declared).toEqual(['editor-request'])
    expect(registered).toEqual(declared)
    expect(registered).not.toContain('reveal-artifact')
    await harness.dispose()
  })
})

describe('video editor Agent tools', () => {
  it('creates and reads bounded projects, imports media, and publishes derived-media jobs', async () => {
    const harness = await activatedHarness()
    const created = await invoke(harness, 'video-project', {
      action: 'create', projectId: 'agent-demo', name: 'Agent Demo'
    })
    expect(created.content).toMatchObject({
      outcome: 'created',
      project: {
        id: 'agent-demo',
        currentRevision: 0,
        canUndo: false,
        canRedo: false
      },
      truncated: false
    })
    const active = await invoke(harness, 'video-project', { action: 'active' })
    expect(active.content).toMatchObject({
      outcome: 'active',
      project: { id: 'agent-demo', currentRevision: 0 }
    })

    const sourceHandle = 'fake_media_source_0001'
    const thumbnailHandle = 'fake_media_thumb_0001'
    const waveformHandle = 'fake_media_wave_00001'
    harness.media.queueFileSelection(mediaHandle(sourceHandle, 'read', 'interview.mp4', 'video'))
    harness.media.addHandle(mediaHandle(thumbnailHandle, 'export', 'thumb.png', 'image'))
    harness.media.addHandle(mediaHandle(waveformHandle, 'export', 'wave.png', 'image'))
    harness.media.setProbe(sourceHandle, videoProbe(sourceHandle))
    const imported = await invoke(harness, 'video-probe', {
      projectId: 'agent-demo',
      expectedRevision: 0,
      assetId: 'interview',
      thumbnailOutputHandleId: thumbnailHandle,
      waveformOutputHandleId: waveformHandle
    })
    expect(imported.content).toMatchObject({
      outcome: 'imported',
      projectId: 'agent-demo',
      currentRevision: 1,
      asset: { id: 'interview', mediaHandleId: sourceHandle },
      jobs: [{ purpose: 'thumbnail' }, { purpose: 'waveform' }]
    })
    expect(JSON.stringify(imported)).not.toContain(harness.context.workspaceContext!.root)

    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo', expectedRevision: 1
    })
    expect(loaded.content).toMatchObject({
      outcome: 'loaded',
      project: { counts: { assets: 1, items: 1 }, currentRevision: 1 }
    })
    await harness.dispose()
  })

  it('returns an actionable ffprobe-unavailable outcome before selecting media or mutating a project', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'agent-demo', name: 'Agent Demo'
    })
    harness.media.setCapabilities({
      probedAt: new Date().toISOString(),
      ffprobe: { name: 'ffprobe', available: false, features: [] },
      ffmpeg: {
        name: 'ffmpeg',
        available: true,
        features: ['libx264-encoder', 'aac-encoder', 'drawtext-filter']
      }
    })

    const unavailable = await invoke(harness, 'video-probe', {
      projectId: 'agent-demo', expectedRevision: 0
    })
    expect(unavailable.content).toMatchObject({
      outcome: 'unavailable',
      code: 'FFPROBE_UNAVAILABLE',
      projectId: 'agent-demo',
      currentRevision: 0,
      changedIds: [],
      retryable: true
    })
    expect(String(contentObject(unavailable).message)).toContain('Install or configure ffprobe')
    expect(JSON.stringify(unavailable)).not.toContain(harness.context.workspaceContext!.root)

    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(loaded.content).toMatchObject({
      project: { currentRevision: 0, counts: { assets: 0, items: 0 } }
    })
    const mediaRequests = harness.transport.requests.map(({ method }) => method)
    expect(mediaRequests.filter((method) => method === 'media.getCapabilities')).toHaveLength(1)
    expect(mediaRequests).not.toContain('media.pickFiles')
    expect(mediaRequests).not.toContain('media.probe')
    await harness.dispose()
  })

  it('keeps project.get pure and makes create/select the explicit active-project transitions', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'project-one', name: 'Project One'
    })
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'project-two', name: 'Project Two'
    })

    const beforeRead = await invoke(harness, 'video-project', { action: 'active' })
    expect(beforeRead.content).toMatchObject({ project: { id: 'project-two' } })
    const read = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'project-one'
    })
    expect(read.content).toMatchObject({ outcome: 'loaded', project: { id: 'project-one' } })
    const afterRead = await invoke(harness, 'video-project', { action: 'active' })
    expect(afterRead.content).toMatchObject({ project: { id: 'project-two' } })

    const selected = await invoke(harness, 'video-project', {
      action: 'select', projectId: 'project-one', expectedRevision: 0
    })
    expect(selected.content).toMatchObject({ outcome: 'selected', project: { id: 'project-one' } })
    const afterSelect = await invoke(harness, 'video-project', { action: 'active' })
    expect(afterSelect.content).toMatchObject({ project: { id: 'project-one' } })
    expect(harness.webview.messages).toContainEqual({
      channel: 'kun-video-editor.project-changed',
      payload: expect.objectContaining({
        projectId: 'project-one',
        activeProjectId: 'project-one',
        previousProjectId: 'project-two',
        revision: 0,
        reason: 'active-project-changed',
        transition: 'selected',
        source: 'agent'
      })
    })
    const manuallySelected = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.select',
      payload: { projectId: 'project-two' }
    })
    expect(manuallySelected.content).toMatchObject({
      outcome: 'selected', project: { id: 'project-two' }
    })
    expect(harness.webview.messages).toContainEqual({
      channel: 'kun-video-editor.project-changed',
      payload: expect.objectContaining({
        projectId: 'project-two',
        previousProjectId: 'project-one',
        reason: 'active-project-changed',
        transition: 'selected',
        source: 'manual'
      })
    })
    await harness.dispose()
  })

  it('returns explicit empty and stale active-project outcomes without guessing', async () => {
    const harness = await activatedHarness()
    const empty = await invoke(harness, 'video-project', { action: 'active' })
    expect(empty.content).toMatchObject({ outcome: 'no-active-project' })

    harness.storage.workspace.set('active-project', {
      schemaVersion: 1,
      projectId: 'missing-project'
    })
    const stale = await invoke(harness, 'video-project', { action: 'active' })
    expect(stale.content).toMatchObject({
      outcome: 'stale-active-project',
      projectId: 'missing-project'
    })
    expect(harness.storage.workspace.has('active-project')).toBe(false)
    await harness.dispose()
  })

  it('imports timed transcripts, exposes a revision-bound script, and rejects stale script edits', async () => {
    const harness = await projectWithMedia()
    const transcript = await invoke(harness, 'video-transcribe', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      assetId: 'interview',
      transcriptId: 'transcript-main',
      mode: 'import',
      language: 'en',
      segments: [
        { id: 'hello', startUs: 0, endUs: 1_000_000, text: 'Hello' },
        { id: 'filler', startUs: 1_000_000, endUs: 1_400_000, text: 'um' },
        { id: 'world', startUs: 1_400_000, endUs: 3_000_000, text: 'world' }
      ]
    })
    expect(transcript.content).toMatchObject({
      outcome: 'transcribed', currentRevision: 2, changedIds: ['interview', 'transcript-main']
    })
    expect(JSON.stringify(transcript.content)).toContain('without network access')

    const script = await invoke(harness, 'video-read-script', {
      projectId: 'agent-demo', expectedRevision: 2
    })
    expect(script.content).toMatchObject({ outcome: 'script', currentRevision: 2, truncated: false })
    const markdown = String(contentObject(script).timelineMarkdown)
    expect(markdown).toContain('| `filler` |')

    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }]
    })
    await expect(invoke(harness, 'video-apply-script', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      timelineMarkdown: markdown,
      ranges: [{ assetId: 'interview', startUs: 1_000_000, endUs: 1_400_000, reason: 'filler' }]
    })).rejects.toMatchObject({ code: 'CONFLICT', details: { engineCode: 'revision_conflict' } })
    await harness.dispose()
  })

  it('serializes manual/Agent races and never overwrites a stale expected revision', async () => {
    const harness = await projectWithMedia()
    const first = invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }],
      summary: 'Portrait cut'
    })
    const second = invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{ type: 'set-canvas', preset: '1:1', fit: 'crop' }],
      summary: 'Square cut'
    })
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(({ status }) => status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'CONFLICT', details: { engineCode: 'revision_conflict' } }
    })
    const loaded = await invoke(harness, 'video-project', { action: 'get', projectId: 'agent-demo' })
    expect(loaded.content).toMatchObject({ project: { currentRevision: 2 } })
    await harness.dispose()
  })

  it('offers one bounded View RPC and records manual provenance with shared undo history', async () => {
    const harness = await projectWithMedia()
    const updated = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.update',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 1,
        operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }],
        summary: 'Manual portrait edit'
      }
    })
    expect(updated.content).toMatchObject({ outcome: 'updated', currentRevision: 2 })
    const projectAfterUpdate = JSON.parse(await readFile(join(
      harness.context.workspaceContext!.root,
      '.kun-video/projects/agent-demo/project.json'
    ), 'utf8'))
    expect(projectAfterUpdate.revisions.at(-1)).toMatchObject({
      author: 'manual', sourceOperation: 'video-update-timeline'
    })

    const undone = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.undo',
      payload: { projectId: 'agent-demo', expectedRevision: 2 }
    })
    expect(undone.content).toMatchObject({ outcome: 'undone', currentRevision: 3 })
    const projectAfterUndo = JSON.parse(await readFile(join(
      harness.context.workspaceContext!.root,
      '.kun-video/projects/agent-demo/project.json'
    ), 'utf8'))
    expect(projectAfterUndo).toMatchObject({ canvas: { preset: '16:9' }, currentRevision: 3 })
    expect(projectAfterUndo.revisions.at(-1)).toMatchObject({ author: 'manual', sourceOperation: 'history.undo' })
    await harness.dispose()
  })

  it('reauthorizes a revoked asset without changing timeline or transcript identity', async () => {
    const harness = await projectWithMedia()
    const replacementHandle = 'fake_media_replacement_001'
    harness.media.addHandle(mediaHandle(replacementHandle, 'read', 'replacement.mp4', 'video'))
    harness.media.setProbe(replacementHandle, videoProbe(replacementHandle))

    const result = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'media.reauthorize',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 1,
        assetId: 'interview',
        mediaHandleId: replacementHandle
      }
    })
    expect(result.content).toMatchObject({
      outcome: 'reauthorized',
      currentRevision: 2,
      asset: { id: 'interview', mediaHandleId: replacementHandle }
    })
    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(loaded.content).toMatchObject({
      project: {
        assets: [{ id: 'interview', mediaHandleId: replacementHandle }],
        items: [{ assetId: 'interview' }]
      }
    })
    await harness.dispose()
  })

  it('projects authoritative undo and redo availability instead of inferring it from revision', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'history-flags', name: 'History Flags'
    })
    await invoke(harness, 'video-update-timeline', {
      projectId: 'history-flags',
      expectedRevision: 0,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad' }]
    })
    const changed = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'history-flags'
    })
    expect(changed.content).toMatchObject({
      project: { currentRevision: 1, canUndo: true, canRedo: false }
    })

    const undone = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.undo',
      payload: { projectId: 'history-flags', expectedRevision: 1 }
    })
    expect(undone.content).toMatchObject({
      details: { project: { currentRevision: 2, canUndo: false, canRedo: true } }
    })
    const redone = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'project.redo',
      payload: { projectId: 'history-flags', expectedRevision: 2 }
    })
    expect(redone.content).toMatchObject({
      details: { project: { currentRevision: 3, canUndo: true, canRedo: false } }
    })
    await harness.dispose()
  })

  it('clears a damaged active project and still lists healthy projects with diagnostics', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'healthy-project', name: 'Healthy'
    })
    const projectsRoot = join(harness.context.workspaceContext!.root, '.kun-video/projects')
    await mkdir(join(projectsRoot, 'damaged-project'), { recursive: true })
    await writeFile(join(projectsRoot, 'damaged-project/project.json'), '{broken json', 'utf8')
    harness.storage.workspace.set('active-project', {
      schemaVersion: 1, projectId: 'damaged-project'
    })

    const active = await invoke(harness, 'video-project', { action: 'active' })
    expect(active.content).toMatchObject({
      outcome: 'stale-active-project',
      projectId: 'damaged-project',
      diagnosticCode: 'invalid_project'
    })
    expect(harness.storage.workspace.get('active-project')).toBeUndefined()
    const listed = await invoke(harness, 'video-project', { action: 'list' })
    expect(listed.content).toMatchObject({
      projects: [expect.objectContaining({ id: 'healthy-project' })],
      diagnostics: [{ id: 'damaged-project', code: 'invalid_project' }]
    })
    await harness.dispose()
  })

  it('returns structured interaction-required in headless mode and rejects path-shaped inputs', async () => {
    const harness = await activatedHarness()
    await invoke(harness, 'video-project', {
      action: 'create', projectId: 'agent-demo', name: 'Agent Demo'
    })
    harness.transport.handle('media.pickFiles', () => {
      throw new ExtensionApiError({
        code: 'INTERACTION_REQUIRED',
        message: 'No protected desktop picker is attached.',
        operation: 'media.pickFiles',
        retryable: true
      })
    })
    const gated = await invoke(harness, 'video-probe', {
      projectId: 'agent-demo', expectedRevision: 0
    })
    expect(gated.content).toEqual(expect.objectContaining({
      outcome: 'interaction-required',
      code: 'MEDIA_INTERACTION_REQUIRED'
    }))
    await expect(invoke(harness, 'video-probe', {
      projectId: 'agent-demo',
      expectedRevision: 0,
      mediaHandleId: '/tmp/raw-video.mp4'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 0,
      kind: 'h264-mp4',
      outputHandleId: '../output.mp4'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 0,
      operations: [{ type: 'set-canvas', preset: '9:16', fit: 'pad', command: 'rm -rf .' }]
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await harness.dispose()
  })

  it('returns actionable unavailable results before picker or job admission when render capabilities are missing', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-capability-check',
          trackId: 'captions-1',
          startFrame: 0,
          endFrame: 45,
          text: 'Capability preflight',
          placement: 'bottom'
        }
      }]
    })

    const cases = [
      {
        code: 'FFPROBE_UNAVAILABLE',
        name: 'ffprobe executable',
        kind: 'proof-frame' as const,
        captionMode: 'none' as const,
        ffprobeAvailable: false,
        ffmpegAvailable: true,
        features: ['libx264-encoder', 'aac-encoder', 'drawtext-filter']
      },
      {
        code: 'FFMPEG_UNAVAILABLE',
        name: 'FFmpeg executable',
        kind: 'proof-frame' as const,
        captionMode: 'none' as const,
        ffprobeAvailable: true,
        ffmpegAvailable: false,
        features: []
      },
      {
        code: 'LIBX264_ENCODER_UNAVAILABLE',
        name: 'libx264 encoder',
        kind: 'preview' as const,
        captionMode: 'none' as const,
        ffprobeAvailable: true,
        ffmpegAvailable: true,
        features: ['aac-encoder', 'drawtext-filter']
      },
      {
        code: 'AAC_ENCODER_UNAVAILABLE',
        name: 'AAC encoder',
        kind: 'audio-aac' as const,
        captionMode: 'none' as const,
        ffprobeAvailable: true,
        ffmpegAvailable: true,
        features: ['libx264-encoder', 'drawtext-filter']
      },
      {
        code: 'DRAWTEXT_FILTER_UNAVAILABLE',
        name: 'drawtext filter',
        kind: 'h264-mp4' as const,
        captionMode: 'burned' as const,
        ffprobeAvailable: true,
        ffmpegAvailable: true,
        features: ['libx264-encoder', 'aac-encoder']
      }
    ]
    const capabilityRequestsBefore = harness.transport.requests
      .filter(({ method }) => method === 'media.getCapabilities').length

    for (const testCase of cases) {
      harness.media.setCapabilities({
        probedAt: new Date().toISOString(),
        ffprobe: {
          name: 'ffprobe',
          available: testCase.ffprobeAvailable,
          features: []
        },
        ffmpeg: {
          name: 'ffmpeg',
          available: testCase.ffmpegAvailable,
          features: testCase.features
        }
      })
      const unavailable = await invoke(harness, 'video-render', {
        projectId: 'agent-demo',
        expectedRevision: 2,
        kind: testCase.kind,
        captionMode: testCase.captionMode
      })
      expect(unavailable.content).toMatchObject({
        outcome: 'unavailable',
        code: testCase.code,
        projectId: 'agent-demo',
        currentRevision: 2,
        changedIds: [],
        retryable: true,
        renderKind: testCase.kind,
        captionMode: testCase.captionMode
      })
      expect(String(contentObject(unavailable).message)).toContain(testCase.name)
      expect(String(contentObject(unavailable).message)).toContain('No output target was selected')
      expect(String(contentObject(unavailable).message)).toContain('no render job was started')
    }

    const requests = harness.transport.requests.map(({ method }) => method)
    expect(requests.filter((method) => method === 'media.getCapabilities'))
      .toHaveLength(capabilityRequestsBefore + cases.length)
    expect(requests).not.toContain('media.pickSaveTarget')
    expect(requests).not.toContain('media.startFfmpegJob')
    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(loaded.content).toMatchObject({ project: { currentRevision: 2 } })
    await harness.dispose()
  })

  it('returns a bounded unavailable result when render capability inspection itself fails', async () => {
    const harness = await projectWithMedia()
    harness.transport.handle('media.getCapabilities', () => {
      throw new Error('simulated capability inspection failure')
    })

    const unavailable = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4'
    })
    expect(unavailable.content).toMatchObject({
      outcome: 'unavailable',
      code: 'MEDIA_CAPABILITIES_UNAVAILABLE',
      projectId: 'agent-demo',
      currentRevision: 1,
      changedIds: [],
      retryable: true,
      renderKind: 'h264-mp4',
      captionMode: 'none',
      missingCapabilities: ['capability-inspection']
    })
    expect(String(contentObject(unavailable).message)).toContain('No output target was selected')
    const requests = harness.transport.requests.map(({ method }) => method)
    expect(requests).not.toContain('media.pickSaveTarget')
    expect(requests).not.toContain('media.startFfmpegJob')
    const loaded = await invoke(harness, 'video-project', {
      action: 'get', projectId: 'agent-demo'
    })
    expect(loaded.content).toMatchObject({ project: { currentRevision: 1 } })
    await harness.dispose()
  })

  it('cancels durable renders and fences late completion without publishing artifacts', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_cancel_0001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'cancelled.mp4', 'video'))
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4',
      outputHandleId: outputHandle,
      idempotencyKey: 'cancel-test'
    })
    const jobId = String(contentObject(render).jobId)
    harness.jobs.start(jobId)
    const cancelled = await invoke(harness, 'video-render-cancel', {
      jobId, projectId: 'agent-demo', reason: 'User requested cancellation'
    })
    expect(cancelled.content).toMatchObject({ outcome: 'cancelled', technicallyValidated: false })
    expect(cancelled.generatedArtifacts).toBeUndefined()
    const artifact = artifactFor(harness, jobId, outputHandle, 'cancelled.mp4')
    expect(harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] }).state)
      .toBe('cancelled')
    const after = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(after.generatedArtifacts).toBeUndefined()
    await harness.dispose()
  })

  it('keeps status read-only and refuses project-mismatched or untracked cancellation', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_scope_guard_001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'scope-guard.mp4', 'video'))
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4',
      outputHandleId: outputHandle
    })
    const jobId = String(contentObject(render).jobId)
    harness.jobs.start(jobId)

    await expect(invoke(harness, 'video-render-status', {
      jobId,
      action: 'cancel'
    } as unknown as JsonObject)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-render-status', {
      jobId,
      projectId: 'another-project'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(invoke(harness, 'video-render-cancel', {
      jobId,
      projectId: 'another-project'
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(harness.jobs.get(jobId).state).toBe('running')

    harness.storage.workspace.set(`render-job:${jobId}`, {
      schemaVersion: 1,
      jobId,
      projectId: '../outside-workspace',
      pinnedRevision: 1,
      renderKind: 'h264-mp4',
      captionMode: 'none',
      subtitleFormat: 'srt',
      canvasPreset: '16:9',
      expectedArtifacts: [{ mediaKind: 'video', mimeType: 'video/mp4' }],
      createdAt: new Date().toISOString()
    })
    const untracked = await invoke(harness, 'video-render-status', { jobId })
    expect(untracked.content).toMatchObject({
      outcome: 'running',
      state: 'running',
      tracked: false,
      artifacts: []
    })
    expect(untracked.content).not.toHaveProperty('projectId')
    await expect(invoke(harness, 'video-render-cancel', { jobId }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(harness.jobs.get(jobId).state).toBe('running')
    await harness.dispose()
  })

  it('cancels an admitted render when its extension tracking record cannot be persisted', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_tracking_fail_01'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'tracking-failed.mp4', 'video'))
    harness.transport.handle('storage.set', () => {
      throw new Error('simulated extension storage failure')
    })

    const failure = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4',
      outputHandleId: outputHandle
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
      details: {
        state: 'cancelled',
        cancellationAttempted: true,
        cancellationAccepted: true,
        trackingPersisted: false
      }
    })
    const details = (failure as { details: JsonObject }).details
    const jobId = String(details.jobId)
    expect((failure as Error).message).toContain(jobId)
    expect(harness.jobs.get(jobId).state).toBe('cancelled')
    expect(harness.storage.workspace.has(`render-job:${jobId}`)).toBe(false)

    const status = await invoke(harness, 'video-render-status', { jobId })
    expect(status.content).toMatchObject({ outcome: 'cancelled', jobId, technicallyValidated: false })
    await harness.dispose()
  })

  it('confirms a tracking write after an ambiguous Host acknowledgement without cancelling the job', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_tracking_ack_001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'tracking-confirmed.mp4', 'video'))
    harness.transport.handle('storage.set', (params) => {
      const request = params as JsonObject
      harness.storage.workspace.set(String(request.key), request.value!)
      throw new Error('simulated lost storage acknowledgement')
    })

    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      kind: 'h264-mp4',
      outputHandleId: outputHandle
    })
    const jobId = String(contentObject(render).jobId)
    expect(render.content).toMatchObject({ outcome: 'queued', jobId })
    expect(harness.jobs.get(jobId).state).toBe('queued')
    expect(harness.jobs.get(jobId)).not.toHaveProperty('cancelRequestedAt')
    expect(harness.storage.workspace.get(`render-job:${jobId}`)).toMatchObject({ jobId })
    await harness.dispose()
  })

  it('recovers missing extension tracking from core artifact provenance without claiming visual review', async () => {
    const harness = await projectWithMedia()
    const outputHandle = 'fake_render_output_0001'
    harness.media.addHandle({
      ...mediaHandle(outputHandle, 'export', 'output.mp4', 'video'),
      byteSize: 8192,
      completionIdentity: 'render-complete-0001'
    })
    harness.media.setProbe(outputHandle, videoProbe(outputHandle))
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo', expectedRevision: 1, kind: 'h264-mp4', outputHandleId: outputHandle
    })
    const jobId = String(contentObject(render).jobId)
    harness.jobs.start(jobId)
    const artifact = artifactFor(harness, jobId, outputHandle, 'output.mp4')
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })
    harness.storage.workspace.delete(`render-job:${jobId}`)
    const status = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(status.content).toMatchObject({
      outcome: 'completed',
      tracked: true,
      projectId: 'agent-demo',
      technicallyValidated: true,
      proofStale: false,
      artifacts: [{ artifactId: artifact.artifactId }]
    })
    expect(status.generatedArtifacts).toEqual([artifact])
    expect(status.metadata).toEqual({
      machineValidatedOnly: true,
      visuallyInspected: false,
      proofStale: false
    })
    expect(status.summary).toContain('No visual inspection is implied')
    expect(harness.storage.workspace.get(`render-job:${jobId}`)).toMatchObject({
      jobId,
      projectId: 'agent-demo',
      pinnedRevision: 1,
      renderKind: 'h264-mp4'
    })

    const replay = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(replay.generatedArtifacts).toEqual(status.generatedArtifacts)
    expect(replay.content).toEqual(status.content)

    const recoveredRecord = harness.storage.workspace.get(`render-job:${jobId}`) as JsonObject
    harness.storage.workspace.set(`render-job:${jobId}`, {
      ...recoveredRecord,
      projectId: 'wrong-project'
    })
    const corrected = await invoke(harness, 'video-render-status', {
      jobId,
      projectId: 'agent-demo'
    })
    expect(corrected.content).toMatchObject({
      outcome: 'completed', tracked: true, projectId: 'agent-demo', technicallyValidated: true
    })
    expect(harness.storage.workspace.get(`render-job:${jobId}`)).toMatchObject({
      projectId: 'agent-demo'
    })
    await harness.dispose()
  })

  it('submits burned captions as a bounded drawtext filter without generated file inputs', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-main',
          trackId: 'captions-1',
          startFrame: 5,
          endFrame: 60,
          text: "Crime d'Amour: [x], y; \\ %",
          placement: 'bottom',
          style: { fontSize: 42, color: '#F0F0F0', background: '#101010' }
        }
      }]
    })
    const outputHandle = 'fake_render_burned_0001'
    harness.media.addHandle(mediaHandle(outputHandle, 'export', 'burned.mp4', 'video'))

    await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      kind: 'h264-mp4',
      outputHandleId: outputHandle,
      captionMode: 'burned'
    })

    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)
    expect(request?.params).toMatchObject({
      inputs: { 'clip-0': 'fake_media_source_0001' },
      outputs: { video: outputHandle },
      metadata: { pinnedRevision: 2, captionMode: 'burned' }
    })
    const argumentsValue = (request?.params as JsonObject | undefined)?.arguments
    expect(Array.isArray(argumentsValue)).toBe(true)
    const filterGraph = (argumentsValue as unknown[])[
      (argumentsValue as unknown[]).indexOf('-filter_complex') + 1
    ]
    expect(filterGraph).toEqual(expect.stringContaining('drawtext='))
    expect(filterGraph).toEqual(expect.stringContaining('expansion=none'))
    expect(filterGraph).not.toEqual(expect.stringContaining('fontfile='))
    expect(filterGraph).not.toEqual(expect.stringContaining('textfile='))
    expect(JSON.stringify(request?.params)).not.toContain('generated-text')

    const proofOutput = 'fake_render_burned_proof_01'
    harness.media.addHandle(mediaHandle(proofOutput, 'export', 'burned-proof.png', 'image'))
    await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      kind: 'proof-frame',
      outputHandleId: proofOutput,
      captionMode: 'burned'
    })
    const proofRequest = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    expect(proofRequest.metadata).toMatchObject({
      pinnedRevision: 2,
      renderKind: 'proof-frame',
      captionMode: 'burned',
      proofFrame: 0
    })
    expect(JSON.stringify(proofRequest.arguments)).toContain('drawtext=')
    expect(JSON.stringify(proofRequest.arguments)).toContain('trim=start_frame=0:end_frame=1')
    await harness.dispose()
  })

  it('publishes burned video and deterministic SRT sidecar artifacts from one durable job', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-sidecar',
          trackId: 'captions-1',
          startFrame: 0,
          endFrame: 45,
          text: 'A deterministic caption',
          placement: 'bottom'
        }
      }]
    })
    const videoTarget = 'fake_render_both_video_0001'
    const subtitleTarget = 'fake_render_both_sub_00001'
    harness.media.addHandle(mediaHandle(videoTarget, 'export', 'both.mp4', 'video'))
    harness.media.addHandle(mediaHandle(subtitleTarget, 'export', 'both.srt', 'subtitle'))

    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      kind: 'h264-mp4',
      outputHandleId: videoTarget,
      captionMode: 'both',
      subtitleOutputHandleId: subtitleTarget,
      subtitleFormat: 'srt'
    })
    const jobId = String(contentObject(render).jobId)
    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    expect(request.textOutputs).toMatchObject({
      'sidecar-captions': {
        handleId: subtitleTarget,
        mimeType: 'application/x-subrip'
      }
    })
    expect(JSON.stringify(request.textOutputs)).toContain('00:00:00,000 --> 00:00:01,500')

    const generatedVideo = 'fake_generated_video_00001'
    const generatedSubtitle = 'fake_generated_subtitle_001'
    harness.media.addHandle({
      ...mediaHandle(generatedVideo, 'read', 'both.mp4', 'video'),
      byteSize: 16_384,
      completionIdentity: 'both-video-complete'
    })
    harness.media.addHandle({
      ...mediaHandle(generatedSubtitle, 'read', 'both.srt', 'subtitle'),
      byteSize: 96,
      completionIdentity: 'both-subtitle-complete'
    })
    harness.media.setProbe(generatedVideo, videoProbe(generatedVideo))
    harness.media.setProbe(generatedSubtitle, subtitleProbe(generatedSubtitle))
    harness.jobs.start(jobId)
    const videoArtifact = createGeneratedArtifactFixture({
      artifactId: `artifact_${createSafeSuffix(jobId)}_video`,
      ownerExtensionId: harness.identity.id,
      ownerExtensionVersion: harness.identity.version,
      workspaceId: harness.context.workspaceContext!.id,
      mediaHandleId: generatedVideo,
      displayName: 'both.mp4',
      mediaKind: 'video',
      mimeType: 'video/mp4',
      byteSize: 16_384,
      completionIdentity: 'both-video-complete',
      provenance: {
        jobId,
        operation: 'media.startFfmpegJob',
        metadata: renderProvenance(2, 'both', 'srt')
      }
    })
    const subtitleArtifact = createGeneratedArtifactFixture({
      artifactId: `artifact_${createSafeSuffix(jobId)}_subtitle`,
      ownerExtensionId: harness.identity.id,
      ownerExtensionVersion: harness.identity.version,
      workspaceId: harness.context.workspaceContext!.id,
      mediaHandleId: generatedSubtitle,
      displayName: 'both.srt',
      mediaKind: 'subtitle',
      mimeType: 'application/x-subrip',
      byteSize: 96,
      completionIdentity: 'both-subtitle-complete',
      provenance: {
        jobId,
        operation: 'media.startFfmpegJob',
        metadata: renderProvenance(2, 'both', 'srt')
      }
    })
    harness.jobs.complete(jobId, {
      schemaVersion: 1,
      generatedArtifacts: [videoArtifact, subtitleArtifact]
    })
    harness.storage.workspace.delete(`render-job:${jobId}`)

    const status = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(status.content).toMatchObject({
      outcome: 'completed',
      tracked: true,
      projectId: 'agent-demo',
      technicallyValidated: true,
      artifacts: [
        { artifactId: videoArtifact.artifactId },
        { artifactId: subtitleArtifact.artifactId }
      ]
    })
    expect(status.generatedArtifacts).toHaveLength(2)
    expect(harness.storage.workspace.get(`render-job:${jobId}`)).toMatchObject({
      expectedArtifacts: [
        { mediaKind: 'subtitle', mimeType: 'application/x-subrip' },
        { mediaKind: 'video', mimeType: 'video/mp4' }
      ]
    })
    await harness.dispose()
  })

  it('releases a Host-selected primary export handle when sidecar target selection is cancelled', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-cancel-sidecar',
          trackId: 'captions-1',
          startFrame: 0,
          endFrame: 30,
          text: 'Keep the first target bounded',
          placement: 'bottom'
        }
      }]
    })
    const primaryTarget = 'fake_render_cancel_sidecar_001'
    harness.media.queueSaveTarget(mediaHandle(primaryTarget, 'export', 'cancelled-sidecar.mp4', 'video'))
    harness.media.queueSaveTarget()

    const response = await harness.client.commands.executeCommand<ToolResult>('editor-request', {
      action: 'render.start',
      payload: {
        projectId: 'agent-demo',
        expectedRevision: 2,
        kind: 'h264-mp4',
        captionMode: 'sidecar',
        subtitleFormat: 'srt'
      }
    })

    expect(contentObject(response)).toMatchObject({ outcome: 'cancelled', code: 'MEDIA_CANCELLED' })
    expect(harness.media.handles.get(primaryTarget)?.revoked).toBe(true)
    expect(harness.transport.requests.map(({ method }) => method)).not.toContain('media.startFfmpegJob')
    await harness.dispose()
  })

  it('exports standalone WebVTT through a text-only durable job and validates its artifact', async () => {
    const harness = await projectWithMedia()
    await invoke(harness, 'video-update-timeline', {
      projectId: 'agent-demo',
      expectedRevision: 1,
      operations: [{
        type: 'add-caption',
        caption: {
          id: 'caption-standalone',
          trackId: 'captions-1',
          startFrame: 0,
          endFrame: 45,
          text: 'Standalone caption',
          placement: 'bottom'
        }
      }]
    })
    const target = 'fake_standalone_vtt_00001'
    harness.media.addHandle({
      ...mediaHandle(target, 'export', 'captions.vtt', 'subtitle'),
      mimeType: 'text/vtt'
    })
    const capabilityRequestsBefore = harness.transport.requests
      .filter(({ method }) => method === 'media.getCapabilities').length
    harness.media.executablesAvailable = false
    const render = await invoke(harness, 'video-render', {
      projectId: 'agent-demo',
      expectedRevision: 2,
      kind: 'subtitles',
      outputHandleId: target,
      subtitleFormat: 'vtt'
    })
    const jobId = String(contentObject(render).jobId)
    const request = harness.transport.requests
      .filter(({ method }) => method === 'media.startFfmpegJob')
      .at(-1)?.params as JsonObject
    expect(request).toMatchObject({
      arguments: [],
      inputs: {},
      outputs: {},
      metadata: {
        projectId: 'agent-demo',
        pinnedRevision: 2,
        renderKind: 'subtitles',
        captionMode: 'none',
        subtitleFormat: 'vtt'
      },
      textOutputs: {
        subtitles: { handleId: target, mimeType: 'text/vtt' }
      }
    })
    expect(JSON.stringify(request.textOutputs)).toContain('WEBVTT')
    expect(harness.transport.requests.filter(({ method }) => method === 'media.getCapabilities'))
      .toHaveLength(capabilityRequestsBefore)
    harness.media.executablesAvailable = true

    const generated = 'fake_generated_vtt_000001'
    harness.media.addHandle({
      ...mediaHandle(generated, 'read', 'captions.vtt', 'subtitle'),
      mimeType: 'text/vtt',
      byteSize: 96,
      completionIdentity: 'standalone-vtt-complete'
    })
    harness.media.setProbe(generated, subtitleProbe(generated))
    harness.jobs.start(jobId)
    const artifact = createGeneratedArtifactFixture({
      artifactId: `artifact_${createSafeSuffix(jobId)}_vtt`,
      ownerExtensionId: harness.identity.id,
      ownerExtensionVersion: harness.identity.version,
      workspaceId: harness.context.workspaceContext!.id,
      mediaHandleId: generated,
      displayName: 'captions.vtt',
      mediaKind: 'subtitle',
      mimeType: 'text/vtt',
      byteSize: 96,
      completionIdentity: 'standalone-vtt-complete',
      provenance: {
        jobId,
        operation: 'media.startFfmpegJob',
        metadata: {
          projectId: 'agent-demo', pinnedRevision: 2, renderKind: 'subtitles',
          captionMode: 'none', subtitleFormat: 'vtt', canvasPreset: '16:9', proofFrame: null
        }
      }
    })
    harness.jobs.complete(jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })
    const status = await invoke(harness, 'video-render-status', { jobId, projectId: 'agent-demo' })
    expect(status.content).toMatchObject({
      outcome: 'completed', renderKind: 'subtitles', technicallyValidated: true
    })
    expect(status.generatedArtifacts).toEqual([expect.objectContaining({ artifactId: artifact.artifactId })])
    await harness.dispose()
  })
})

async function activatedHarness(): Promise<ExtensionTestHarness> {
  const root = await mkdtemp(join(tmpdir(), 'kun-video-tools-'))
  roots.push(root)
  const harness = createExtensionTestHarness({
    identity: {
      id: 'kun-examples.kun-video-editor',
      publisher: 'kun-examples',
      name: 'kun-video-editor',
      version: '0.1.0'
    },
    permissions,
    workspace: { id: 'video-workspace', name: 'Video Workspace', root, trusted: true, active: true }
  })
  await harness.activate(activate)
  return harness
}

async function projectWithMedia(): Promise<ExtensionTestHarness> {
  const harness = await activatedHarness()
  await invoke(harness, 'video-project', {
    action: 'create', projectId: 'agent-demo', name: 'Agent Demo'
  })
  const sourceHandle = 'fake_media_source_0001'
  harness.media.addHandle(mediaHandle(sourceHandle, 'read', 'interview.mp4', 'video'))
  harness.media.setProbe(sourceHandle, videoProbe(sourceHandle))
  await invoke(harness, 'video-probe', {
    projectId: 'agent-demo',
    expectedRevision: 0,
    mediaHandleId: sourceHandle,
    assetId: 'interview'
  })
  return harness
}

async function invoke(
  harness: ExtensionTestHarness,
  id: (typeof VIDEO_TOOL_IDS)[number],
  input: JsonObject
): Promise<ToolResult> {
  const registration = [...harness.tools.registrations]
    .find(([, declaration]) => declaration.id === id)?.[0]
  if (!registration) throw new Error(`Tool ${id} was not registered`)
  return await harness.tools.invoke(registration, input) as ToolResult
}

function contentObject(result: ToolResult): JsonObject {
  if (result.content === null || typeof result.content !== 'object' || Array.isArray(result.content)) {
    throw new Error('Expected a tool result object')
  }
  return result.content
}

function mediaHandle(
  handleId: string,
  mode: 'read' | 'export',
  displayName: string,
  kind: 'video' | 'audio' | 'image' | 'subtitle'
): JsonObject {
  return {
    handleId,
    mode,
    kind,
    displayName,
    mimeType: kind === 'video'
      ? 'video/mp4'
      : kind === 'audio'
        ? 'audio/mp4'
        : kind === 'subtitle'
          ? 'application/x-subrip'
          : 'image/png',
    byteSize: mode === 'read' ? 4096 : 0
  }
}

function subtitleProbe(handleId: string): JsonObject {
  return {
    schemaVersion: 1,
    handleId,
    container: { formatNames: ['srt'], durationMicros: 1_500_000 },
    streams: [{
      index: 0,
      kind: 'subtitle',
      codecName: 'subrip',
      durationMicros: 1_500_000,
      disposition: { default: true }
    }]
  }
}

function videoProbe(handleId: string): JsonObject {
  return {
    schemaVersion: 1,
    handleId,
    container: { formatNames: ['mp4'], durationMicros: 3_000_000 },
    streams: [
      {
        index: 0,
        kind: 'video',
        codecName: 'h264',
        durationMicros: 3_000_000,
        frameRate: { numerator: 30, denominator: 1 },
        width: 1920,
        height: 1080,
        disposition: { default: true }
      },
      {
        index: 1,
        kind: 'audio',
        codecName: 'aac',
        durationMicros: 3_000_000,
        sampleRate: 48_000,
        channelCount: 2,
        disposition: { default: true }
      }
    ]
  }
}

function artifactFor(
  harness: ExtensionTestHarness,
  jobId: string,
  mediaHandleId: string,
  displayName: string
) {
  return createGeneratedArtifactFixture({
    artifactId: `artifact_${createSafeSuffix(jobId)}_0001`,
    ownerExtensionId: harness.identity.id,
    ownerExtensionVersion: harness.identity.version,
    workspaceId: harness.context.workspaceContext!.id,
    mediaHandleId,
    displayName,
    byteSize: 8192,
    completionIdentity: 'render-complete-0001',
    provenance: {
      jobId,
      operation: 'media.startFfmpegJob',
      metadata: renderProvenance(1, 'none', 'srt')
    }
  })
}

function renderProvenance(
  pinnedRevision: number,
  captionMode: 'none' | 'burned' | 'sidecar' | 'both',
  subtitleFormat: 'srt' | 'vtt'
): JsonObject {
  return {
    projectId: 'agent-demo',
    pinnedRevision,
    renderKind: 'h264-mp4',
    captionMode,
    subtitleFormat,
    canvasPreset: '16:9',
    proofFrame: null
  }
}

function createSafeSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_')
}

async function loadManifest(): Promise<ExtensionManifest> {
  const path = join(import.meta.dirname, '..', 'kun-extension.json')
  return parseExtensionManifest(JSON.parse(await readFile(path, 'utf8')))
}
