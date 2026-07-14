import { describe, expect, it } from 'vitest'
import { ExtensionApiError } from '@kun/extension-api'
import { createExtensionTestHarness, createGeneratedArtifactFixture } from '../src/index.js'

const permissions = [
  'commands.register',
  'storage.global',
  'storage.workspace',
  'agent.run',
  'agent.threads.readOwn',
  'tools.register',
  'providers.register',
  'accounts.read',
  'workspace.read',
  'workspace.write',
  'ui.notifications',
  'network:api.example.com'
]

const mediaPermissions = [
  'media.read',
  'media.process',
  'media.export',
  'jobs.manage',
  'workspace.read',
  'workspace.write'
]

describe('ExtensionTestHarness', () => {
  it('runs commands, storage, Agent events, and tools deterministically', async () => {
    const harness = createExtensionTestHarness({ permissions })
    const command = await harness.client.commands.registerCommand('hello', async (args) => ({ args }))
    expect(await harness.client.commands.executeCommand('hello', 'world')).toEqual({ args: 'world' })

    await harness.client.storage.global.set('answer', 42)
    expect(await harness.client.storage.global.get('answer')).toBe(42)

    harness.webview.respondToNextNotification('retry')
    expect(await harness.client.ui.showNotification({
      id: 'provider-warning',
      title: 'Provider unavailable',
      message: 'Reconnect and retry.',
      actions: [{ id: 'retry', title: 'Retry' }]
    })).toBe('retry')
    expect(harness.webview.notifications).toEqual([expect.objectContaining({
      id: 'provider-warning',
      severity: 'info',
      actions: [{ id: 'retry', title: 'Retry' }]
    })])

    const { run } = await harness.client.agent.createRun({ input: 'hello' })
    const subscription = await harness.client.agent.subscribe({ runId: run.id })
    const events: string[] = []
    subscription.onEvent((event) => events.push(event.type))
    harness.agent.emit(run.id, 'progress', { message: 'working' })
    expect(events).toEqual(['state', 'progress'])

    const tool = await harness.client.tools.registerTool(
      { id: 'echo', description: 'Echo input', inputSchema: { type: 'object' }, sideEffects: 'none', idempotent: true },
      async (input) => ({ content: input })
    )
    expect(await harness.tools.invoke('tool-1', { value: 'ok' })).toEqual({ content: { value: 'ok' } })

    await tool.dispose()
    await subscription.dispose()
    await command.dispose()
    await harness.dispose()
  })

  it('returns the public permission error shape', async () => {
    const harness = createExtensionTestHarness({ permissions: [] })
    await expect(harness.client.network.fetch({ url: 'https://api.example.com' })).rejects.toMatchObject<
      Partial<ExtensionApiError>
    >({ code: 'PERMISSION_DENIED', operation: 'network.fetch' })
    await harness.dispose()
  })

  it('contains malformed Host notifications as public protocol errors', async () => {
    const harness = createExtensionTestHarness()
    const errors: ExtensionApiError[] = []
    harness.client.onDidError((error) => errors.push(error))
    harness.transport.emit('ui.themeChanged', { kind: 'invalid' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'PROTOCOL_ERROR', operation: 'ui.themeChanged' })
    await harness.dispose()
  })

  it('scripts accounts and normalized provider streams without credentials or model calls', async () => {
    const harness = createExtensionTestHarness({
      permissions: [
        'providers.register',
        'accounts.read',
        'accounts.secrets.read:fake-provider'
      ]
    })
    harness.accounts.addAccount(
      {
        id: 'account-1',
        providerId: 'fake-provider',
        label: 'Test account',
        authenticationType: 'api-key',
        status: 'connected',
        metadata: {}
      },
      'not-a-real-secret'
    )
    expect(await harness.client.authentication.listAccounts({ providerId: 'fake-provider' })).toHaveLength(1)
    expect(
      await harness.client.authentication.revealSecret({
        accountId: 'account-1',
        operation: 'test-signing'
      })
    ).toBe('not-a-real-secret')

    await harness.client.modelProviders.registerProvider(
      {
        id: 'fake-provider',
        displayName: 'Fake Provider',
        adapterApiVersion: '1.0.0',
        models: []
      },
      {
        async probe() {
          return { ok: true }
        },
        async listModels() {
          return [
            {
              id: 'fake-model',
              displayName: 'Fake Model',
              capabilities: {
                input: ['text'],
                output: ['text'],
                reasoning: false,
                tools: false,
                parallelTools: false,
                streaming: true
              }
            }
          ]
        },
        async *stream(request) {
          yield { requestId: request.requestId, sequence: 0, type: 'textDelta', delta: 'hello' }
          yield {
            requestId: request.requestId,
            sequence: 1,
            type: 'completed',
            finishReason: 'stop',
            usage: { outputTokens: 1 }
          }
        },
        async cancel() {}
      }
    )
    const binding = { providerId: 'fake-provider', accountId: 'account-1', modelId: 'fake-model' }
    expect(
      await harness.providers.invoke('provider-1', { operation: 'listModels', binding })
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fake-model' })]))
    await harness.providers.invoke('provider-1', {
      operation: 'stream',
      request: {
        apiVersion: '1.0.0',
        requestId: 'request-1',
        binding,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
      }
    })
    expect(harness.transport.sentNotifications).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ method: 'modelProviders.streamEvent' })])
    )
    expect(harness.transport.sentStreams).toEqual([
      expect.objectContaining({ requestId: 'fake_request_2', terminal: false }),
      expect.objectContaining({ requestId: 'fake_request_2', terminal: true })
    ])
    expect(harness.providers.takeStreamEvents('provider-1').map((event) => event.type)).toEqual([
      'textDelta',
      'completed'
    ])
    await harness.dispose()
  })

  it('fakes protected media selection, probe, leases, FFmpeg jobs, and artifacts', async () => {
    const harness = createExtensionTestHarness({ permissions: mediaPermissions })
    const inputHandle = 'fake_media_input_0001'
    const outputHandle = 'fake_media_output_0001'
    harness.media.queueFileSelection({
      handleId: inputHandle,
      mode: 'read',
      kind: 'video',
      displayName: 'interview.mp4',
      mimeType: 'video/mp4',
      byteSize: 2048
    })
    harness.media.queueSaveTarget({
      handleId: outputHandle,
      mode: 'export',
      kind: 'video',
      displayName: 'export.mp4',
      mimeType: 'video/mp4'
    })
    harness.media.setProbe(inputHandle, {
      schemaVersion: 1,
      handleId: inputHandle,
      container: { formatNames: ['mp4'], durationMicros: 1_000_000 },
      streams: [{
        index: 0,
        kind: 'video',
        codecName: 'h264',
        frameRate: { numerator: 30_000, denominator: 1001 },
        width: 1920,
        height: 1080,
        disposition: { default: true }
      }]
    })

    const selection = await harness.client.media.pickFiles()
    expect(selection).toMatchObject({ outcome: 'selected', files: [{ handleId: inputHandle }] })
    expect(await harness.client.media.probe({ handleId: inputHandle })).toMatchObject({
      handleId: inputHandle,
      streams: [{ codecName: 'h264' }]
    })
    expect(await harness.client.media.openViewResource({ handleId: inputHandle }))
      .toMatchObject({ handleId: inputHandle, mimeType: 'video/mp4' })
    expect(await harness.client.media.pickSaveTarget()).toMatchObject({
      outcome: 'selected',
      target: { handleId: outputHandle }
    })

    const started = await harness.client.media.startFfmpegJob({
      arguments: ['-i', '{{input:source}}', '{{output:export}}'],
      inputs: { source: inputHandle },
      outputs: { export: outputHandle }
    })
    const subscription = await harness.client.jobs.subscribe({ jobId: started.job.jobId })
    const states: string[] = []
    subscription.onEvent((event) => states.push(event.state))
    harness.jobs.start(started.job.jobId)
    harness.jobs.reportProgress(started.job.jobId, { completed: 1, total: 2, percentage: 50 })
    const artifact = createGeneratedArtifactFixture({
      ownerExtensionVersion: harness.identity.version,
      mediaHandleId: outputHandle,
      provenance: { jobId: started.job.jobId, operation: 'media.ffmpeg' }
    })
    harness.jobs.complete(started.job.jobId, { schemaVersion: 1, generatedArtifacts: [artifact] })
    expect(states).toEqual(['queued', 'running', 'running', 'completed'])
    expect(subscription.complete).toBe(true)
    expect(subscription.snapshot.result?.generatedArtifacts).toEqual([
      expect.objectContaining({ artifactId: artifact.artifactId })
    ])
    await subscription.dispose()
    await harness.dispose()
  })

  it('returns deterministic and configurable public media capabilities', async () => {
    const harness = createExtensionTestHarness({ permissions: mediaPermissions })
    expect(await harness.client.media.getCapabilities()).toMatchObject({
      ffprobe: { name: 'ffprobe', available: true },
      ffmpeg: {
        name: 'ffmpeg',
        available: true,
        features: expect.arrayContaining(['libx264-encoder', 'aac-encoder', 'drawtext-filter'])
      }
    })

    harness.media.setCapabilities({
      probedAt: '2026-01-02T00:00:00.000Z',
      ffprobe: { name: 'ffprobe', available: false, features: [] },
      ffmpeg: { name: 'ffmpeg', available: true, features: ['libx264-encoder'] }
    })
    expect(await harness.client.media.getCapabilities()).toEqual({
      probedAt: '2026-01-02T00:00:00.000Z',
      ffprobe: { name: 'ffprobe', available: false, features: [] },
      ffmpeg: { name: 'ffmpeg', available: true, features: ['libx264-encoder'] }
    })

    harness.media.executablesAvailable = false
    expect(await harness.client.media.getCapabilities()).toMatchObject({
      ffprobe: { available: false },
      ffmpeg: { available: false, features: [] }
    })
    await harness.dispose()
  })

  it('fakes permission denial, picker cancellation, executable absence, cancellation races, and restart', async () => {
    const denied = createExtensionTestHarness({ permissions: [] })
    await expect(denied.client.media.pickFiles()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      operation: 'media.pickFiles'
    })
    await denied.dispose()

    const harness = createExtensionTestHarness({ permissions: mediaPermissions })
    harness.media.queuePickerCancellation()
    expect(await harness.client.media.pickFiles()).toEqual({ outcome: 'cancelled', files: [] })
    harness.media.executablesAvailable = false
    harness.media.addHandle({
      handleId: 'fake_media_input_0002',
      mode: 'read',
      kind: 'video',
      displayName: 'missing-tool.mp4'
    })
    await expect(harness.client.media.probe({ handleId: 'fake_media_input_0002' })).rejects.toMatchObject({
      code: 'HOST_UNAVAILABLE',
      operation: 'media.probe'
    })

    const cancelling = harness.jobs.create('media.ffmpeg', 'media.startFfmpegJob')
    harness.jobs.start(cancelling.id)
    harness.jobs.cancellationMode = 'pending'
    const cancellation = await harness.client.jobs.cancel({ jobId: cancelling.id, reason: 'test' })
    expect(cancellation).toMatchObject({ accepted: true, snapshot: { state: 'running' } })
    expect(harness.jobs.complete(cancelling.id).state).toBe('running')
    expect(harness.jobs.settleCancellation(cancelling.id).state).toBe('cancelled')

    const interrupted = harness.jobs.create('media.ffmpeg', 'media.startFfmpegJob')
    harness.jobs.start(interrupted.id)
    harness.jobs.simulateRestart()
    expect((await harness.client.jobs.get(interrupted.id)).state).toBe('interrupted')
    expect((await harness.client.jobs.list({ filter: { states: ['interrupted'] } })).items)
      .toEqual([expect.objectContaining({ id: interrupted.id })])
    await harness.dispose()
  })
})
