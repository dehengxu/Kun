import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'

const useTraces = vi.hoisted(() => vi.fn())
vi.mock('./useModelRequestTraces', () => ({ useModelRequestTraces: useTraces }))

import { AgentPerspectivePanel } from './AgentPerspectivePanel'

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('')
}

describe('AgentPerspectivePanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useTraces.mockReturnValue({
      records: [{
        schemaVersion: 1,
        id: 'trace-1',
        sequence: 1,
        threadId: 'thread-1',
        turnId: 'turn-1',
        provider: 'deepseek',
        model: 'deepseek-chat',
        endpointFormat: 'openai-chat',
        attempt: 1,
        attemptReason: 'initial',
        status: 'completed',
        startedAt: '2026-07-20T00:00:00.000Z',
        durationMs: 42,
        request: {
          method: 'POST',
          url: 'https://api.deepseek.com/chat/completions',
          urlRedacted: false,
          headers: {
            values: { authorization: '[REDACTED]', 'content-type': 'application/json' },
            redactedNames: ['authorization']
          },
          body: {
            text: '{"model":"deepseek-chat","messages":[]}',
            capturedBytes: 43,
            originalBytes: 43,
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
        decoded: { text: 'Hello', reasoning: '', toolCalls: [] }
      }],
      selectedId: 'trace-1',
      selected: null,
      activeCount: 0,
      warnings: [],
      loading: false,
      loadingOlder: false,
      error: null,
      select: vi.fn(),
      refresh: vi.fn(),
      loadOlder: vi.fn()
    })
    const state = useTraces.getMockImplementation()?.()
    state.selected = state.records[0]
    useTraces.mockReturnValue(state)
  })

  it('exposes accessible detail tabs and renders already-redacted request data', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(AgentPerspectivePanel, {
        threadId: 'thread-1',
        active: true,
        threadRunning: false
      }))
    })

    const tabs = renderer.root.findAll((node) => node.props.role === 'tab')
    expect(tabs.map(textContent)).toEqual(['Overview', 'Request', 'Response', 'Decoded'])
    expect(tabs[0]?.props['aria-selected']).toBe(true)
    expect(renderer.root.findByProps({ 'aria-label': 'Refresh requests' })).toBeDefined()

    act(() => tabs[1]?.props.onClick())
    const requestBody = renderer.root.findByProps({ 'aria-label': 'Request body' })
    expect(requestBody.props.value).toContain('"model": "deepseek-chat"')
    const renderedText = textContent(renderer.root)
    expect(renderedText).toContain('authorization')
    expect(renderedText).toContain('[REDACTED]')
    expect(renderedText).not.toContain('sk-secret')
  })
})
