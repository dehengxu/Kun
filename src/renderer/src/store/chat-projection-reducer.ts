import type { ChatBlock, RuntimeErrorEventPayload, RuntimeStatusEventPayload } from '../agent/types'
import type { RuntimeProjectionAction } from '../agent/runtime-projection-actions'
import type { ChatState } from './chat-store-types'

export type ChatProjectionReducerContext = {
  now: number
  clearRecoveringError: (error: string | null) => string | null
  goalTimelineText: (goal: ChatState['activeThreadGoal'], cleared?: boolean) => string
  runtimeStatusText: (event: RuntimeStatusEventPayload) => string
  runtimeErrorView: (event: RuntimeErrorEventPayload) => {
    summary: string
    code?: string
    detail?: string
  }
  upsertRuntimeError: (
    blocks: ChatBlock[],
    block: Extract<ChatBlock, { kind: 'system' }>
  ) => ChatBlock[]
}

export function flushLiveProjection(
  state: ChatState,
  now: number,
  base: Partial<ChatState> = {}
): Partial<ChatState> {
  const nextBlocks = [...state.blocks]
  const createdAt = new Date(now).toISOString()
  if (state.liveReasoning.trim()) {
    nextBlocks.push({ kind: 'reasoning', id: `r-${now}`, createdAt, text: state.liveReasoning })
  }
  if (state.liveAssistant.trim()) {
    nextBlocks.push({ kind: 'assistant', id: `a-${now}`, createdAt, text: state.liveAssistant })
  }
  if (nextBlocks.length === state.blocks.length) return base
  return { ...base, blocks: nextBlocks, liveReasoning: '', liveAssistant: '' }
}

/** Pure state projection for normalized actions; browser work is emitted elsewhere. */
export function reduceChatProjection(
  state: ChatState,
  action: RuntimeProjectionAction,
  context: ChatProjectionReducerContext
): Partial<ChatState> {
  switch (action.type) {
    case 'deltas_received': {
      const deltas = action.deltas
      if (deltas.length === 0) return {}
      const seqs = deltas
        .map((delta) => delta.seq)
        .filter((value): value is number => typeof value === 'number')
      const patch: Partial<ChatState> = {
        error: context.clearRecoveringError(state.error),
        ...(seqs.length > 0 ? { lastSeq: Math.max(state.lastSeq, ...seqs) } : {}),
        ...(!state.busy ? { busy: true } : {})
      }
      let liveReasoning = state.liveReasoning
      let liveAssistant = state.liveAssistant
      let liveDeltaSeqFloor = state.liveDeltaSeqFloor
      let reasoningFirst = state.turnReasoningFirstAtByUserId
      let reasoningLast = state.turnReasoningLastAtByUserId
      let sawReasoning = false
      for (const delta of deltas) {
        if (typeof delta.seq === 'number') {
          if (delta.seq <= liveDeltaSeqFloor) continue
          liveDeltaSeqFloor = delta.seq
        }
        if (delta.kind === 'agent_reasoning') {
          liveReasoning += delta.text
          sawReasoning = true
        } else {
          liveAssistant += delta.text
        }
      }
      const userId = state.currentTurnUserId
      if (sawReasoning && userId) {
        if (typeof reasoningFirst[userId] !== 'number') {
          reasoningFirst = { ...reasoningFirst, [userId]: context.now }
        }
        reasoningLast = { ...reasoningLast, [userId]: context.now }
      }
      return {
        ...patch,
        ...(liveReasoning !== state.liveReasoning ? { liveReasoning } : {}),
        ...(liveAssistant !== state.liveAssistant ? { liveAssistant } : {}),
        ...(liveDeltaSeqFloor !== state.liveDeltaSeqFloor ? { liveDeltaSeqFloor } : {}),
        ...(reasoningFirst !== state.turnReasoningFirstAtByUserId
          ? { turnReasoningFirstAtByUserId: reasoningFirst }
          : {}),
        ...(reasoningLast !== state.turnReasoningLastAtByUserId
          ? { turnReasoningLastAtByUserId: reasoningLast }
          : {})
      }
    }
    case 'approval_received': {
      const request = action.payload
      if (state.blocks.some(
        (block) => block.kind === 'approval' && block.approvalId === request.approvalId
      )) return {}
      const flushed = flushLiveProjection(state, context.now)
      const baseBlocks = flushed.blocks ?? state.blocks
      return {
        ...flushed,
        blocks: [...baseBlocks, {
          kind: 'approval',
          id: `approval-${request.approvalId}`,
          createdAt: new Date(context.now).toISOString(),
          approvalId: request.approvalId,
          summary: request.summary,
          toolName: request.toolName,
          status: 'pending',
          ...(request.meta ? { meta: request.meta } : {})
        }],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'user_input_requested': {
      const req = action.payload
      const existing = state.blocks.find(
        (block) => block.kind === 'user_input' && block.requestId === req.requestId
      )
      if (existing) {
        if (existing.kind === 'user_input' && existing.live === true) return {}
        return {
          blocks: state.blocks.map((block) =>
            block.kind === 'user_input' && block.requestId === req.requestId
              ? { ...block, live: true, status: 'pending' as const }
              : block
          )
        }
      }
      const flushed = flushLiveProjection(state, context.now)
      const baseBlocks = flushed.blocks ?? state.blocks
      return {
        ...flushed,
        blocks: [...baseBlocks, {
          kind: 'user_input',
          id: req.itemId,
          createdAt: new Date(context.now).toISOString(),
          requestId: req.requestId,
          questions: req.questions,
          status: 'pending',
          live: true
        }],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'user_input_status_changed': {
      const event = action.payload
      return {
        error: context.clearRecoveringError(state.error),
        blocks: state.blocks.map((block) =>
          block.kind === 'user_input' && block.id === event.itemId
            ? block.status === 'submitted' && event.status === 'error' &&
                isUserInputInterruptError(event.errorMessage)
              ? block
              : {
                  ...block,
                  status: event.status,
                  answers: event.answers ?? block.answers,
                  errorMessage: event.errorMessage ?? block.errorMessage
                }
            : block
        )
      }
    }
    case 'runtime_status_received': {
      const event = action.payload
      const base: Partial<ChatState> = state.busy ? {} : { busy: true }
      const flushed = flushLiveProjection(state, context.now)
      const baseBlocks = flushed.blocks ?? state.blocks
      const block: ChatBlock = {
        kind: 'system',
        id: event.itemId,
        createdAt: event.createdAt ?? new Date(context.now).toISOString(),
        text: context.runtimeStatusText(event)
      }
      const index = baseBlocks.findIndex(
        (candidate) => candidate.kind === 'system' && candidate.id === event.itemId
      )
      const blocks = [...baseBlocks]
      if (index >= 0) blocks[index] = block
      else blocks.push(block)
      return {
        ...base,
        ...flushed,
        blocks,
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'runtime_error_received': {
      const event = action.payload
      const flushed = flushLiveProjection(state, context.now)
      const baseBlocks = flushed.blocks ?? state.blocks
      const view = context.runtimeErrorView(event)
      const block: Extract<ChatBlock, { kind: 'system' }> = {
        kind: 'system',
        id: event.itemId,
        createdAt: event.createdAt ?? new Date(context.now).toISOString(),
        text: view.summary,
        ...(view.code ? { code: view.code } : {}),
        ...(view.detail ? { detail: view.detail } : {}),
        severity: event.severity ?? 'error'
      }
      return {
        ...flushed,
        blocks: context.upsertRuntimeError(baseBlocks, block),
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'compaction_updated': {
      const event = action.payload
      const base: Partial<ChatState> = {}
      if (!state.busy && event.status === 'running') base.busy = true
      if (state.busy && event.status !== 'running' && !state.currentTurnId) base.busy = false
      const index = state.blocks.findIndex(
        (block) => block.kind === 'compaction' && block.id === event.itemId
      )
      if (index >= 0) {
        const current = state.blocks[index]
        if (current.kind !== 'compaction') return base
        const blocks = [...state.blocks]
        blocks[index] = {
          ...current,
          summary: event.summary || current.summary,
          status: event.status,
          detail: event.detail ?? current.detail,
          auto: event.auto ?? current.auto,
          messagesBefore: event.messagesBefore ?? current.messagesBefore,
          messagesAfter: event.messagesAfter ?? current.messagesAfter,
          createdAt: current.createdAt ?? event.createdAt
        }
        return { ...base, blocks, error: context.clearRecoveringError(state.error) }
      }
      const flushed = flushLiveProjection(state, context.now)
      const baseBlocks = flushed.blocks ?? state.blocks
      return {
        ...base,
        ...flushed,
        blocks: [...baseBlocks, {
          kind: 'compaction',
          id: event.itemId,
          createdAt: event.createdAt ?? new Date(context.now).toISOString(),
          summary: event.summary,
          status: event.status,
          detail: event.detail,
          auto: event.auto,
          messagesBefore: event.messagesBefore,
          messagesAfter: event.messagesAfter
        }],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'review_updated': {
      const event = action.payload
      const base: Partial<ChatState> = !state.busy && event.status === 'running' ? { busy: true } : {}
      const index = state.blocks.findIndex(
        (block) => block.kind === 'review' && block.id === event.itemId
      )
      if (index >= 0) {
        const current = state.blocks[index]
        if (current.kind !== 'review') return base
        const blocks = [...state.blocks]
        blocks[index] = {
          ...current,
          title: event.title || current.title,
          status: event.status,
          target: event.target ?? current.target,
          reviewText: event.reviewText ?? current.reviewText,
          output: event.output ?? current.output,
          createdAt: current.createdAt ?? event.createdAt
        }
        return { ...base, blocks, error: context.clearRecoveringError(state.error) }
      }
      const flushed = flushLiveProjection(state, context.now)
      const baseBlocks = flushed.blocks ?? state.blocks
      return {
        ...base,
        ...flushed,
        blocks: [...baseBlocks, {
          kind: 'review',
          id: event.itemId,
          createdAt: event.createdAt ?? new Date(context.now).toISOString(),
          title: event.title,
          status: event.status,
          target: event.target,
          reviewText: event.reviewText,
          output: event.output
        }],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'goal_changed': {
      const event = action.payload
      if (!event.threadId) return {}
      const currentThread = state.activeThreadId === event.threadId
      const updatedAt = event.goal?.updatedAt ?? event.createdAt ?? new Date(context.now).toISOString()
      const threads = state.threads.map((thread) =>
        thread.id === event.threadId ? { ...thread, goal: event.goal, updatedAt } : thread
      )
      if (!currentThread) return { threads }
      const flushed = flushLiveProjection(state, context.now)
      const baseBlocks = flushed.blocks ?? state.blocks
      const block: ChatBlock = {
        kind: 'system',
        id: `goal-${event.threadId}-${updatedAt}-${event.goal?.status ?? 'cleared'}`,
        createdAt: updatedAt,
        text: context.goalTimelineText(event.goal, event.cleared)
      }
      return {
        ...flushed,
        activeThreadGoal: event.goal,
        threads,
        blocks: [...baseBlocks, block],
        error: context.clearRecoveringError(state.error)
      }
    }
    case 'todos_changed': {
      const event = action.payload
      if (!event.threadId) return {}
      const todos = event.cleared ? null : event.todos
      const updatedAt = todos?.updatedAt ?? event.createdAt ?? new Date(context.now).toISOString()
      const threads = state.threads.map((thread) =>
        thread.id === event.threadId ? { ...thread, todos, updatedAt } : thread
      )
      return state.activeThreadId === event.threadId
        ? { activeThreadTodos: todos, threads, error: context.clearRecoveringError(state.error) }
        : { threads }
    }
    case 'thread_metadata_changed': {
      const event = action.payload
      const title = event.title?.trim()
      if (!event.threadId || !title) return {}
      return {
        threads: state.threads.map((thread) =>
          thread.id === event.threadId
            ? { ...thread, title, ...(event.titleAuto !== undefined ? { titleAuto: event.titleAuto } : {}) }
            : thread
        )
      }
    }
    case 'usage_received':
      return {
        usageRefreshKey: state.usageRefreshKey + 1,
        lastTurnUsage: { threadId: state.activeThreadId ?? '', snapshot: action.payload }
      }
    default:
      return {}
  }
}

function isUserInputInterruptError(message: string | undefined): boolean {
  if (!message) return false
  const normalized = message.trim().toLowerCase()
  return normalized.includes('interrupt') || normalized.includes('cancelled') || normalized.includes('canceled')
}
