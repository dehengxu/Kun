import { createElement } from 'react'
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { useChatStore } from '../store/chat-store'
import { SessionHeader } from './SessionHeader'

const initialChatState = useChatStore.getState()

describe('SessionHeader', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useChatStore.setState({
      ...initialChatState,
      workspaceLabel: 'Working directory',
      activeThreadId: 'thread-1',
      blocks: [
        { kind: 'user', id: 'user-1', turnId: 'turn-1', text: 'Question' },
        { kind: 'assistant', id: 'assistant-1', turnId: 'turn-1', text: 'Answer' }
      ],
      threads: [{
        id: 'thread-1',
        title: 'Fix drag region',
        updatedAt: '2026-06-10T10:00:00.000Z',
        model: 'deepseek-chat',
        mode: 'chat',
        workspace: '/workspace/deepseek-gui'
      }]
    })
  })

  afterEach(() => {
    useChatStore.setState(initialChatState)
  })

  it('renders the active workspace and conversation as a draggable compact breadcrumb', () => {
    let renderer: ReactTestRenderer
    act(() => {
      renderer = createRenderer(createElement(SessionHeader, { compact: true }))
    })
    const html = JSON.stringify(renderer!.toJSON())

    expect(html).toContain('session-header-compact flex')
    expect(html).not.toContain('session-header-compact ds-no-drag')
    expect(html).toContain('session-header-compact-workspace')
    expect(html).toContain('session-header-compact-chevron')
    expect(html).toContain('session-header-compact-title')
    expect(html).toContain('ds-no-drag relative shrink-0')
    expect(html).toContain('"aria-label":"Export conversation"')
    expect(html).toContain('deepseek-gui')
    expect(html).toContain('Fix drag region')
    act(() => renderer!.unmount())
  })

  it('shows only the current workspace identity when there is no active conversation', () => {
    useChatStore.setState({
      activeThreadId: null,
      threads: []
    })

    let renderer: ReactTestRenderer
    act(() => {
      renderer = createRenderer(createElement(SessionHeader, { compact: true }))
    })
    const html = JSON.stringify(renderer!.toJSON())

    expect(html).toContain('session-header-compact-empty')
    expect(html).toContain('Working directory')
    expect(html).not.toContain('Fix drag region')
    expect(html).not.toContain('"aria-label":"Export conversation"')
    act(() => renderer!.unmount())
  })

  it('keeps a full-width themed divider and hides lower-priority breadcrumb text at narrow widths', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const css = await readFile(new URL('../styles/base-shell.css', import.meta.url), 'utf8')

    expect(css).toContain('.chat-topbar.ds-topbar-surface {')
    expect(css).toContain('border-bottom: 1px solid color-mix(in srgb, var(--ds-border) 78%, transparent);')
    expect(css).toContain('@container (max-width: 520px)')
    expect(css).toContain('.session-header-compact-workspace,')
    expect(css).toContain('.session-header-compact-chevron {')
    expect(css).toMatch(/\.session-header-compact-chevron \{\s+display: none;/)
  })
})
