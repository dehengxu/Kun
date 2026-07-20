import { describe, expect, it } from 'vitest'
import {
  parseModelRequestTracePage,
  parseModelRequestTracePageJson
} from './model-request-traces'

function record(id = 'trace-1') {
  return {
    schemaVersion: 1,
    id,
    sequence: 1,
    threadId: 'thread-1',
    turnId: 'turn-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    endpointFormat: 'openai-chat',
    attempt: 1,
    attemptReason: 'initial',
    status: 'completed',
    startedAt: '2026-07-20T01:02:03.000Z',
    finishedAt: '2026-07-20T01:02:03.100Z',
    durationMs: 100,
    request: {
      method: 'POST',
      url: 'https://api.deepseek.com/chat/completions',
      urlRedacted: false,
      headers: {
        values: { authorization: '[REDACTED]', 'content-type': 'application/json' },
        redactedNames: ['authorization']
      },
      body: {
        text: '{"model":"deepseek-chat"}',
        capturedBytes: 25,
        originalBytes: 25,
        truncated: false
      }
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { values: { 'content-type': 'text/event-stream' }, redactedNames: [] },
      body: {
        text: 'data: {"choices":[]}\n\n',
        capturedBytes: 22,
        originalBytes: 22,
        truncated: false
      }
    },
    decoded: {
      text: 'hello',
      reasoning: '',
      toolCalls: [],
      usage: { inputTokens: 12 }
    }
  }
}

function page(records: unknown[] = [record()]) {
  return {
    schemaVersion: 1,
    records,
    nextCursor: 'opaque-cursor',
    activeCount: 0,
    limits: {
      maxRequestBodyBytes: 4_194_304,
      maxResponseBodyBytes: 4_194_304,
      maxPageSize: 200
    },
    warnings: []
  }
}

describe('model request trace renderer contract', () => {
  it('parses the bounded wire exchange without discarding redaction and raw stream metadata', () => {
    const parsed = parseModelRequestTracePageJson(JSON.stringify(page()))
    expect(parsed.records[0]).toMatchObject({
      id: 'trace-1',
      attemptReason: 'initial',
      request: {
        headers: {
          values: { authorization: '[REDACTED]' },
          redactedNames: ['authorization']
        }
      },
      response: { status: 200 },
      decoded: { text: 'hello' }
    })
    expect(parsed.records[0]?.response?.body?.text).toContain('data:')
  })

  it('fails closed for unsupported versions, methods, and oversized pages', () => {
    expect(() => parseModelRequestTracePage({ ...page(), schemaVersion: 2 }))
      .toThrow('unsupported model request trace schema')
    expect(() => parseModelRequestTracePage(page([
      { ...record(), request: { ...record().request, method: 'GET' } }
    ]))).toThrow('request.method is invalid')
    expect(() => parseModelRequestTracePage(page(
      Array.from({ length: 201 }, (_, index) => record(`trace-${index}`))
    ))).toThrow('bounded array')
  })

  it('rejects malformed JSON and unbounded header values', () => {
    expect(() => parseModelRequestTracePageJson('{')).toThrow('invalid model request trace JSON')
    expect(() => parseModelRequestTracePage(page([{
      ...record(),
      request: {
        ...record().request,
        headers: { values: { huge: 'x'.repeat(65_537) }, redactedNames: [] }
      }
    }]))).toThrow('bounded string')
  })
})
