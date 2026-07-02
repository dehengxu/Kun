import { describe, expect, it, vi } from 'vitest'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import {
  activeCanvasTurnMatchesThread,
  canvasReplayStateForStoreUpdate,
  replayActiveCanvasTurn
} from './use-apply-shape-ops-live'

describe('replayActiveCanvasTurn', () => {
  it('replays existing tool blocks and streaming text when enabled mid-turn', () => {
    const toolBlock: ToolBlock = {
      kind: 'tool',
      id: 'tool-1',
      summary: 'canvas op',
      status: 'success',
      meta: { toolName: 'design_update_shapes' },
      detail: '{"ops":[]}'
    }
    const applyToolBlock = vi.fn()
    const processStreaming = vi.fn()

    replayActiveCanvasTurn(
      {
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
        blocks: [
          { kind: 'user', id: 'user-1', text: 'draw a diagram' },
          toolBlock,
          { kind: 'assistant', id: 'assistant-1', text: 'Working on it.' }
        ] satisfies ChatBlock[]
      },
      applyToolBlock,
      processStreaming
    )

    expect(applyToolBlock).toHaveBeenCalledTimes(1)
    expect(applyToolBlock).toHaveBeenCalledWith(toolBlock)
    expect(processStreaming).toHaveBeenCalledTimes(1)
  })

  it('replays only tool blocks after the current turn user block', () => {
    const oldToolBlock: ToolBlock = {
      kind: 'tool',
      id: 'tool-old',
      summary: 'old canvas op',
      status: 'success',
      meta: { toolName: 'design_update_shapes' },
      detail: '{"ops":[]}'
    }
    const currentToolBlock: ToolBlock = {
      kind: 'tool',
      id: 'tool-current',
      summary: 'current canvas op',
      status: 'success',
      meta: { toolName: 'design_update_shapes' },
      detail: '{"ops":[]}'
    }
    const applyToolBlock = vi.fn()
    const processStreaming = vi.fn()

    replayActiveCanvasTurn(
      {
        currentTurnId: 'turn-2',
        currentTurnUserId: 'user-2',
        blocks: [
          { kind: 'user', id: 'user-1', text: 'old request' },
          oldToolBlock,
          { kind: 'assistant', id: 'assistant-1', text: 'Done.' },
          { kind: 'user', id: 'user-2', text: 'current request' },
          currentToolBlock
        ] satisfies ChatBlock[]
      },
      applyToolBlock,
      processStreaming
    )

    expect(applyToolBlock).toHaveBeenCalledTimes(1)
    expect(applyToolBlock).toHaveBeenCalledWith(currentToolBlock)
    expect(processStreaming).toHaveBeenCalledTimes(1)
  })

  it('stops replay at the next user block if the current user id is stale', () => {
    const currentToolBlock: ToolBlock = {
      kind: 'tool',
      id: 'tool-current',
      summary: 'current canvas op',
      status: 'success',
      meta: { toolName: 'design_update_shapes' },
      detail: '{"ops":[]}'
    }
    const nextToolBlock: ToolBlock = {
      kind: 'tool',
      id: 'tool-next',
      summary: 'next canvas op',
      status: 'success',
      meta: { toolName: 'design_update_shapes' },
      detail: '{"ops":[]}'
    }
    const applyToolBlock = vi.fn()
    const processStreaming = vi.fn()

    replayActiveCanvasTurn(
      {
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
        blocks: [
          { kind: 'user', id: 'user-1', text: 'current request' },
          currentToolBlock,
          { kind: 'user', id: 'user-2', text: 'future request' },
          nextToolBlock
        ] satisfies ChatBlock[]
      },
      applyToolBlock,
      processStreaming
    )

    expect(applyToolBlock).toHaveBeenCalledTimes(1)
    expect(applyToolBlock).toHaveBeenCalledWith(currentToolBlock)
    expect(processStreaming).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no turn is active', () => {
    const applyToolBlock = vi.fn()
    const processStreaming = vi.fn()

    replayActiveCanvasTurn(
      {
        currentTurnId: null,
        blocks: [
          {
            kind: 'tool',
            id: 'tool-1',
            summary: 'canvas op',
            status: 'success',
            meta: { toolName: 'design_update_shapes' },
            detail: '{"ops":[]}'
          }
        ]
      },
      applyToolBlock,
      processStreaming
    )

    expect(applyToolBlock).not.toHaveBeenCalled()
    expect(processStreaming).not.toHaveBeenCalled()
  })

  it('can scope replay to the active code whiteboard thread', () => {
    const toolBlock: ToolBlock = {
      kind: 'tool',
      id: 'tool-1',
      summary: 'canvas op',
      status: 'success',
      meta: { toolName: 'design_update_shapes' },
      detail: '{"ops":[]}'
    }
    const applyToolBlock = vi.fn()
    const processStreaming = vi.fn()

    replayActiveCanvasTurn(
      {
        activeThreadId: 'thread-code',
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
        blocks: [
          { kind: 'user', id: 'user-1', text: 'draw a diagram' },
          toolBlock
        ] satisfies ChatBlock[]
      },
      applyToolBlock,
      processStreaming,
      'thread-code'
    )

    expect(activeCanvasTurnMatchesThread({ activeThreadId: 'thread-code' }, 'thread-code')).toBe(true)
    expect(applyToolBlock).toHaveBeenCalledTimes(1)
    expect(processStreaming).toHaveBeenCalledTimes(1)
  })

  it('does not replay canvas output from another thread', () => {
    const toolBlock: ToolBlock = {
      kind: 'tool',
      id: 'tool-foreign',
      summary: 'canvas op',
      status: 'success',
      meta: { toolName: 'design_update_shapes' },
      detail: '{"ops":[]}'
    }
    const applyToolBlock = vi.fn()
    const processStreaming = vi.fn()

    replayActiveCanvasTurn(
      {
        activeThreadId: 'thread-other',
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
        blocks: [
          { kind: 'user', id: 'user-1', text: 'draw a diagram' },
          toolBlock
        ] satisfies ChatBlock[]
      },
      applyToolBlock,
      processStreaming,
      'thread-code'
    )

    expect(activeCanvasTurnMatchesThread({ activeThreadId: 'thread-other' }, 'thread-code')).toBe(false)
    expect(applyToolBlock).not.toHaveBeenCalled()
    expect(processStreaming).not.toHaveBeenCalled()
  })

  it('can replay tool blocks that arrive in the same update that clears the turn id', () => {
    const toolBlock: ToolBlock = {
      kind: 'tool',
      id: 'tool-late',
      summary: 'canvas op',
      status: 'success',
      meta: { toolName: 'design_update_shapes' },
      detail: '{"ops":[]}'
    }
    const applyToolBlock = vi.fn()
    const processStreaming = vi.fn()
    const replayState = canvasReplayStateForStoreUpdate(
      {
        activeThreadId: 'thread-code',
        currentTurnId: null,
        currentTurnUserId: null,
        blocks: [
          { kind: 'user', id: 'user-1', text: 'put it on the canvas' },
          toolBlock
        ] satisfies ChatBlock[]
      },
      {
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1'
      }
    )

    replayActiveCanvasTurn(replayState, applyToolBlock, processStreaming, 'thread-code')

    expect(replayState.currentTurnId).toBe('turn-1')
    expect(replayState.currentTurnUserId).toBe('user-1')
    expect(applyToolBlock).toHaveBeenCalledTimes(1)
    expect(applyToolBlock).toHaveBeenCalledWith(toolBlock)
    expect(processStreaming).toHaveBeenCalledTimes(1)
  })
})
