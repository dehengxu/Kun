import { describe, expect, test, vi } from 'vitest'
import type {
  AgentOptions,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage
} from '@cursor/sdk'
import { LlmDebugRecorder } from '../../services/llm-debug-recorder.js'
import {
  CursorSdkRuntime,
  cursorAgentExecutionOptions,
  sanitizeCursorSdkError,
  type CursorSdkApi,
  type CursorSdkRuntimeDeps
} from './cursor-sdk-runtime.js'

function messages(values: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  return (async function* () {
    for (const value of values) yield value
  })()
}

function fakeRun(input: {
  stream?: SDKMessage[]
  result?: Partial<RunResult>
  cancel?: () => Promise<void>
} = {}): Run {
  const result: RunResult = {
    id: 'run_1',
    status: 'finished',
    result: 'hello',
    ...input.result
  }
  return {
    id: 'run_1',
    agentId: 'agent_1',
    supports: (operation) => operation === 'stream' || operation === 'wait' || operation === 'cancel',
    unsupportedReason: () => undefined,
    stream: () => messages(input.stream ?? [{
      type: 'assistant',
      agent_id: 'agent_1',
      run_id: 'run_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
    }]),
    conversation: async () => [],
    wait: async () => result,
    cancel: input.cancel ?? (async () => undefined),
    status: result.status,
    onDidChangeStatus: () => () => undefined,
    result: result.result,
    error: result.error,
    model: result.model,
    durationMs: result.durationMs,
    usage: result.usage,
    git: result.git,
    createdAt: 1
  }
}

function harness(input: {
  apiKey?: string
  run?: Run
  thread?: Record<string, unknown>
  items?: Array<Record<string, unknown>>
  attachmentStore?: CursorSdkRuntimeDeps['attachmentStore']
  debugSink?: LlmDebugRecorder
  turnLimits?: { maxWallTimeMs?: number }
  loadError?: Error
}) {
  const applied: unknown[] = []
  const recorded: unknown[] = []
  const finished: unknown[] = []
  const createOptions: AgentOptions[] = []
  const sentMessages: unknown[] = []
  const run = input.run ?? fakeRun()
  const agent = {
    agentId: 'agent_1',
    model: { id: 'auto' },
    send: async (message: unknown) => {
      sentMessages.push(message)
      return run
    },
    close: vi.fn(),
    reload: async () => undefined,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    [Symbol.asyncDispose]: async () => undefined
  } as SDKAgent
  const sdk: CursorSdkApi = {
    Agent: {
      create: async (options) => {
        createOptions.push(options)
        return agent
      }
    }
  }
  const thread = {
    id: 'thread_1',
    title: 'Cursor test',
    workspace: '/tmp/cursor-workspace',
    model: 'auto',
    mode: 'agent',
    approvalPolicy: 'auto',
    sandboxMode: 'danger-full-access',
    systemPrompt: '',
    turns: [{ id: 'turn_1', model: 'auto', mode: 'agent' }],
    ...input.thread
  }
  const deps = {
    providerConfigs: {
      'cursor-subscription': {
        kind: 'cursor-sdk',
        apiKey: input.apiKey ?? 'cursor-secret'
      }
    },
    providerIds: new Set(['cursor-subscription']),
    defaultIsCursor: false,
    defaultModel: 'auto',
    systemPrompt: 'Kun system prompt',
    threadStore: { get: async () => thread },
    sessionStore: {
      loadItems: async () => input.items ?? [{
        id: 'user_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
        role: 'user',
        status: 'completed',
        createdAt: new Date().toISOString(),
        kind: 'user_message',
        text: 'hi'
      }]
    },
    turns: {
      applyItem: async (_threadId: string, item: unknown) => { applied.push(item) },
      finishTurn: async (value: unknown) => { finished.push(value) }
    },
    events: { record: async (value: unknown) => { recorded.push(value) } },
    ids: { next: (prefix: string) => `${prefix}_1` },
    loadSdk: async () => {
      if (input.loadError) throw input.loadError
      return sdk
    },
    debugSink: input.debugSink,
    attachmentStore: input.attachmentStore,
    turnLimits: input.turnLimits
  } as unknown as CursorSdkRuntimeDeps
  return {
    runtime: new CursorSdkRuntime(deps),
    createOptions,
    applied,
    recorded,
    finished,
    sentMessages,
    agent
  }
}

describe('CursorSdkRuntime', () => {
  test('claims only configured Cursor providers', () => {
    const h = harness({})
    expect(h.runtime.handlesProvider('cursor-subscription')).toBe(true)
    expect(h.runtime.handlesProvider('claude-subscription')).toBe(false)
    expect(h.runtime.handlesProvider(undefined)).toBe(false)
  })

  test('runs a complete local SDK turn with isolated settings and an SDK trace', async () => {
    const debugSink = new LlmDebugRecorder()
    const h = harness({ debugSink })
    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(h.createOptions[0]).toMatchObject({
      apiKey: 'cursor-secret',
      model: { id: 'auto' },
      mode: 'agent',
      local: {
        cwd: '/tmp/cursor-workspace',
        settingSources: [],
        sandboxOptions: { enabled: false }
      }
    })
    expect(h.applied).toContainEqual(expect.objectContaining({
      kind: 'assistant_text',
      text: 'hello',
      status: 'completed'
    }))
    expect(h.finished).toContainEqual(expect.objectContaining({ status: 'completed' }))
    const trace = debugSink.snapshot()[0]?.exchanges[0]
    expect(trace).toMatchObject({
      transport: 'sdk',
      endpointFormat: 'cursor-sdk',
      request: { method: 'SDK', url: 'cursor-sdk://local/agent' }
    })
    expect(JSON.stringify(trace)).not.toContain('cursor-secret')
  })

  test('uses plan mode and sandbox when Kun cannot auto-approve mutation', () => {
    expect(cursorAgentExecutionOptions({
      workspace: '/tmp/work',
      apiKey: 'key',
      model: 'auto',
      name: 'test',
      planMode: false,
      approvalPolicy: 'always',
      sandboxMode: 'workspace-write'
    })).toMatchObject({
      mode: 'plan',
      local: { settingSources: [], sandboxOptions: { enabled: true } }
    })
    expect(cursorAgentExecutionOptions({
      workspace: '/tmp/work',
      apiKey: 'key',
      model: 'auto',
      name: 'test',
      planMode: false,
      approvalPolicy: 'auto',
      sandboxMode: 'read-only'
    }).mode).toBe('plan')
  })

  test('forwards authorized image attachments as a structured SDK message without tracing bytes', async () => {
    const debugSink = new LlmDebugRecorder()
    const imageBytes = Buffer.from('sensitive-image-bytes')
    const resolveContent = vi.fn(async () => ({
      id: 'att_0123456789abcdef01234567',
      name: 'diagram.png',
      kind: 'image',
      mimeType: 'image/png',
      byteSize: imageBytes.byteLength,
      hash: 'hash',
      width: 640,
      height: 480,
      threadIds: ['thread_1'],
      workspaces: ['/tmp/cursor-workspace'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: imageBytes
    }))
    const h = harness({
      debugSink,
      attachmentStore: { resolveContent } as unknown as CursorSdkRuntimeDeps['attachmentStore'],
      items: [{
        id: 'user_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
        role: 'user',
        status: 'completed',
        createdAt: new Date().toISOString(),
        kind: 'user_message',
        text: 'describe this image',
        attachmentIds: ['att_0123456789abcdef01234567']
      }]
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('completed')

    expect(resolveContent).toHaveBeenCalledWith(
      'att_0123456789abcdef01234567',
      { threadId: 'thread_1', workspace: '/tmp/cursor-workspace' }
    )
    expect(h.sentMessages[0]).toMatchObject({
      text: expect.stringContaining('describe this image'),
      images: [{
        data: imageBytes.toString('base64'),
        mimeType: 'image/png',
        dimension: { width: 640, height: 480 }
      }]
    })
    const traceJson = JSON.stringify(debugSink.snapshot())
    expect(traceJson).not.toContain(imageBytes.toString('base64'))
    expect(traceJson).toContain('"count":1')
    expect(traceJson).toContain('"mimeType":"image/png"')
  })

  test('fails closed without borrowing the default provider credential', async () => {
    const h = harness({ apiKey: '' })
    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')
    expect(h.createOptions).toEqual([])
    expect(h.finished).toContainEqual(expect.objectContaining({
      status: 'failed',
      code: 'cursor_sdk_missing_credential'
    }))
  })

  test('cancels an active SDK run when the Kun turn aborts', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const cancel = vi.fn(async () => { release() })
    const run = fakeRun({ cancel })
    run.stream = () => (async function* () {
      await blocked
      yield* []
    })()
    const h = harness({ run })
    const controller = new AbortController()
    const outcome = h.runtime.runTurn('thread_1', 'turn_1', controller.signal, 'cursor-subscription')
    await vi.waitFor(() => expect(h.createOptions).toHaveLength(1))
    controller.abort()
    await expect(outcome).resolves.toBe('aborted')
    expect(cancel).toHaveBeenCalled()
    expect(h.finished).toContainEqual(expect.objectContaining({ status: 'aborted' }))
  })

  test('cancels and reports a stable failure when wall time expires', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const cancel = vi.fn(async () => { release() })
    const run = fakeRun({ cancel })
    run.stream = () => (async function* () {
      await blocked
      yield* []
    })()
    const h = harness({ run, turnLimits: { maxWallTimeMs: 5 } })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')
    expect(cancel).toHaveBeenCalled()
    expect(h.finished).toContainEqual(expect.objectContaining({
      status: 'failed',
      code: 'turn_wall_time_limit'
    }))
  })

  test('redacts the configured key from SDK failures', () => {
    expect(sanitizeCursorSdkError(
      new Error('request using cursor-secret failed'),
      'cursor-secret'
    )).toBe('request using [REDACTED] failed')
  })

  test('keeps SDK errors and traces free of the configured key', async () => {
    const debugSink = new LlmDebugRecorder()
    const h = harness({
      debugSink,
      loadError: new Error('Cursor rejected cursor-secret')
    })

    await expect(h.runtime.runTurn(
      'thread_1',
      'turn_1',
      new AbortController().signal,
      'cursor-subscription'
    )).resolves.toBe('failed')
    expect(JSON.stringify(h.recorded)).not.toContain('cursor-secret')
    expect(JSON.stringify(h.finished)).not.toContain('cursor-secret')
    expect(JSON.stringify(debugSink.snapshot())).not.toContain('cursor-secret')
    expect(JSON.stringify(h.finished)).toContain('[REDACTED]')
  })
})
