import { describe, expect, it, vi } from 'vitest'
import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildDelegationToolProviders } from './delegation-tool-provider.js'

describe('delegate_task observability output', () => {
  it('keeps child runtime selection out of model-facing schemas', () => {
    const runtime = {
      enabled: () => true,
      listProfiles: () => [],
      defaultToolPolicy: 'inherit'
    } as unknown as DelegationRuntime
    const tools = buildDelegationToolProviders(runtime)[0]?.tools ?? []
    const delegateTool = tools.find((candidate) => candidate.name === 'delegate_task')
    const generateTool = tools.find((candidate) => candidate.name === 'generate_subagent')
    const properties = delegateTool?.inputSchema.properties as Record<string, { description?: string }> | undefined
    const generatedProperties = generateTool?.inputSchema.properties as Record<string, unknown> | undefined

    expect(delegateTool?.description).toContain('not tool-call arguments')
    expect(properties).not.toHaveProperty('model')
    expect(properties).not.toHaveProperty('providerId')
    expect(generatedProperties).not.toHaveProperty('model')
    expect(generatedProperties).not.toHaveProperty('providerId')
    expect(properties?.custom_agent?.description).toContain('always inherits the current turn model/provider/reasoning strength')
    const customProperties = (properties?.custom_agent as { properties?: Record<string, unknown> })?.properties
    expect(customProperties).not.toHaveProperty('reasoning_effort')
  })

  it('includes the effective model and snapshotted profile name in live and final output', async () => {
    const runChild = vi.fn(async (input: Parameters<DelegationRuntime['runChild']>[0]) => {
      const metadata = {
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        reasoningEffort: 'high',
        profile: 'security-auditor',
        profileName: 'Security Auditor'
      }
      await input.onQueued?.('child_audit', 'security-auditor', metadata)
      await input.onRunning?.('child_audit', 'security-auditor', metadata)
      return {
        id: 'child_audit',
        parentThreadId: 'thread_parent',
        parentTurnId: 'turn_parent',
        prompt: 'Audit the change',
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        reasoningEffort: 'high',
        profile: 'security-auditor',
        profileSnapshot: { name: 'Security Auditor' },
        toolPolicy: 'readOnly' as const,
        status: 'completed' as const,
        summary: 'No critical findings.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        returnFormat: 'summary' as const,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:01.000Z'
      }
    })
    const runtime = {
      enabled: () => true,
      listProfiles: () => [],
      runChild
    } as unknown as DelegationRuntime
    const tool = buildDelegationToolProviders(runtime)[0]?.tools
      .find((candidate) => candidate.name === 'delegate_task')
    expect(tool).toBeDefined()

    const updates: unknown[] = []
    const result = await tool!.execute({
      label: 'Audit pass',
      prompt: 'Audit the change',
      model: 'stale-model',
      providerId: 'stale-provider'
    }, context(), (update) => {
      updates.push(update.output)
    })

    expect(updates).toEqual([
      expect.objectContaining({
        childId: 'child_audit',
        status: 'queued',
        profile: 'security-auditor',
        profileName: 'Security Auditor',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high'
      }),
      expect.objectContaining({
        childId: 'child_audit',
        status: 'running',
        profile: 'security-auditor',
        profileName: 'Security Auditor',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high'
      })
    ])
    expect(result.output).toMatchObject({
      childId: 'child_audit',
      status: 'completed',
      profile: 'security-auditor',
      profileName: 'Security Auditor',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high'
    })
    expect(runChild).toHaveBeenCalledWith(expect.objectContaining({
      inheritedModel: 'gpt-5.6-luna',
      inheritedProviderId: 'openai',
      inheritedReasoningEffort: 'high'
    }))
    const childInput = runChild.mock.calls[0]?.[0]
    expect(childInput).not.toHaveProperty('model')
    expect(childInput).not.toHaveProperty('providerId')
  })
})

function context(): ToolHostContext {
  return {
    threadId: 'thread_parent',
    turnId: 'turn_parent',
    workspace: '/workspace',
    approvalPolicy: 'auto',
    sandboxMode: 'workspace-write',
    model: {
      id: 'gpt-5.6-luna',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsToolCalling: true,
      messageParts: ['text']
    },
    modelProviderId: 'openai',
    reasoningEffort: 'high',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}
