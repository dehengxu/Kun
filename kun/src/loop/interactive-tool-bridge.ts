import type { TurnItem } from '../contracts/items.js'
import { makeUserInputItem } from '../domain/item.js'
import type { ApprovalRequest } from '../domain/approval.js'
import type { ApprovalGate } from '../ports/approval-gate.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type {
  UserInputGate,
  UserInputResolution,
  UserInputRequest
} from '../ports/user-input-gate.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import { awaitAbortableGate } from '../services/interactive-gate.js'

export type InteractiveToolBridgeDeps = {
  approvalGate: ApprovalGate
  userInputGate: UserInputGate
  events: RuntimeEventRecorder
  turns: TurnService
  sessionStore: SessionStore
  nowIso: () => string
}

export type AwaitToolApprovalInput = {
  approval: ApprovalRequest
  approvalPolicy: ToolHostContext['approvalPolicy']
  sandboxMode: NonNullable<ToolHostContext['sandboxMode']>
  signal: AbortSignal
}

export type AwaitToolUserInputInput = {
  threadId: string
  turnId: string
  input: Omit<UserInputRequest, 'threadId' | 'turnId'>
  signal: AbortSignal
}

/**
 * Owns the interactive portions of native tool execution. It deliberately
 * preserves the different persistence models: approval is event-only, while
 * user input writes both an item and request/resolution events.
 */
export class InteractiveToolBridge {
  constructor(private readonly deps: InteractiveToolBridgeDeps) {}

  async awaitApproval(input: AwaitToolApprovalInput): Promise<'allow' | 'deny'> {
    const pending = this.deps.approvalGate.request(input.approval)
    const cancelPendingApproval = (reason: string): void => {
      if (!this.deps.approvalGate.expire?.(input.approval.id, reason)) {
        this.deps.approvalGate.decide(input.approval.id, 'deny', reason)
      }
    }
    try {
      await this.deps.events.record({
        kind: 'approval_requested',
        threadId: input.approval.threadId,
        turnId: input.approval.turnId,
        approvalId: input.approval.id,
        toolName: input.approval.toolName,
        status: 'pending',
        approvalPolicy: input.approvalPolicy,
        sandboxMode: input.sandboxMode,
        summary: input.approval.summary
      })
    } catch (error) {
      cancelPendingApproval('failed to publish approval request')
      void pending.catch(() => undefined)
      throw error
    }
    return awaitAbortableGate(
      pending,
      input.signal,
      () => { cancelPendingApproval('turn aborted while awaiting approval') },
      'approval wait aborted'
    )
  }

  async awaitUserInput(input: AwaitToolUserInputInput): Promise<UserInputResolution> {
    // Arm before the item/event becomes observable. An SSE subscriber can
    // submit synchronously while processing user_input_requested.
    const request: UserInputRequest = {
      ...input.input,
      threadId: input.threadId,
      turnId: input.turnId
    }
    const pending = this.deps.userInputGate.request(request)
    const item = makeUserInputItem({
      id: input.input.itemId,
      threadId: input.threadId,
      turnId: input.turnId,
      inputId: input.input.id,
      prompt: input.input.prompt,
      questions: input.input.questions
    })
    try {
      await this.deps.turns.applyItem(input.threadId, item)
      await this.deps.events.record({
        kind: 'user_input_requested',
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: item.id,
        inputId: input.input.id,
        status: 'pending',
        prompt: input.input.prompt,
        questions: input.input.questions
      })
    } catch (error) {
      this.deps.userInputGate.resolve(input.input.id, { status: 'cancelled' })
      void pending.catch(() => undefined)
      throw error
    }

    const resolution = await awaitAbortableGate(
      pending,
      input.signal,
      () => { this.deps.userInputGate.resolve(input.input.id, { status: 'cancelled' }) },
      'cancelled while awaiting user input'
    )
    await this.deps.turns.updateItem(input.threadId, item.id, {
      status: resolution.status,
      finishedAt: this.deps.nowIso(),
      ...(resolution.status === 'submitted' ? { answers: resolution.answers } : {})
    } as Partial<TurnItem>)
    const alreadyRecorded = (await this.deps.sessionStore.loadEventsSince(input.threadId, 0)).some(
      (event) => event.kind === 'user_input_resolved' && event.inputId === input.input.id
    )
    if (!alreadyRecorded) {
      await this.deps.events.record({
        kind: 'user_input_resolved',
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: item.id,
        inputId: input.input.id,
        status: resolution.status,
        prompt: input.input.prompt,
        questions: input.input.questions,
        ...(resolution.status === 'submitted' ? { answers: resolution.answers } : {})
      })
    }
    return resolution
  }
}
