import { BUILTIN_SUBAGENT_PROFILES } from '../../delegation/builtin-profiles.js'
import {
  profileAvailableOnSurface,
  type ChildRoutingMetadata,
  type DelegationRuntime
} from '../../delegation/delegation-runtime.js'
import {
  generatedSubagentProfileId,
  type SubagentGenerationResult,
  type SubagentGenerator
} from '../../delegation/subagent-generator.js'
import {
  CustomSubagentDefinitionSchema,
  customSubagentProfile,
  customSubagentProfileId,
  subagentTaskRequiresReadOnly,
  type CustomSubagentDefinition,
  type SubagentRouteResult,
  type SubagentRouter,
  type SubagentRoutingDocument
} from '../../delegation/subagent-router.js'
import type { ToolExecutionUpdate, ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import { BUILTIN_AGENT_CATALOG_BY_ID } from '../../delegation/builtin-agent-catalog.js'

type InlineProfile = {
  id: string
  profile: ReturnType<typeof customSubagentProfile>
  source?: 'builtin' | 'configured' | 'workspace' | 'custom' | 'generated'
}

export function buildDelegationToolProviders(
  runtime: DelegationRuntime | undefined,
  router?: SubagentRouter,
  generator?: SubagentGenerator
): CapabilityToolProvider[] {
  if (!runtime?.enabled()) return []
  const profiles = runtime.listProfiles().filter((profile) => profile.mode !== 'primary')
  const builtinDocuments = builtinRoutingDocuments()

  return [{
    id: 'delegation',
    kind: 'delegation',
    enabled: true,
    available: true,
    tools: [
      LocalToolHost.defineTool({
        name: 'delegate_task',
        description: buildDelegateTaskDescription(runtime, profiles.length),
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'A distinct 2-4 word UI title for this child.' },
            prompt: { type: 'string', description: 'The task for the child agent.' },
            model: { type: 'string', description: 'Child model override; requires providerId.' },
            providerId: { type: 'string', description: 'Child provider override; requires model.' },
            profile: {
              type: 'string',
              description: 'Optional exact agent profile id. Omit profile and custom_agent for BM25 Top-5 agent recall plus an LLM fit decision.'
            },
            custom_agent: customAgentSchema(),
            detach: { type: 'boolean', description: 'Run in the background and return after the child is queued.' },
            returnFormat: { type: 'string', enum: ['summary', 'evidence'] }
          },
          required: ['prompt'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context, onUpdate) => {
          const common = parseCommonArgs(args, context)
          if (common instanceof Error) return toolError(common.message)
          const requestedProfile = stringValue(args.profile)
          const customDefinition = parseCustomAgent(args.custom_agent)
          if (customDefinition instanceof Error) return toolError(customDefinition.message)
          if (requestedProfile && customDefinition) return toolError('profile and custom_agent are mutually exclusive')

          let resolvedProfile = requestedProfile || undefined
          let inlineProfile: InlineProfile | undefined
          let routing: ChildRoutingMetadata | undefined
          let generatedResult: SubagentGenerationResult | undefined
          const agentSurface = context.agentSurface ?? 'code'

          if (customDefinition) {
            inlineProfile = {
              id: customSubagentProfileId(customDefinition.name),
              profile: customSubagentProfile(customDefinition),
              source: 'custom'
            }
            routing = explicitCustomMetadata(inlineProfile)
          } else if (requestedProfile) {
            const snapshot = await runtime.resolveProfileSnapshot(requestedProfile, common.workspace, agentSurface)
            if (!snapshot) {
              return toolError(`unknown or unavailable ${agentSurface} subagent profile: ${requestedProfile}`)
            }
            inlineProfile = { id: snapshot.id, profile: snapshot.profile, source: snapshot.source }
            resolvedProfile = undefined
            routing = {
              method: 'explicit-profile',
              selectedKind: 'profile',
              selectedId: requestedProfile,
              reason: 'The parent agent explicitly selected this standalone profile.',
              agentSurface,
              candidates: []
            }
          } else if (router) {
            const documents = await runtime.listRoutingProfiles(common.workspace, agentSurface)
            const route = await router.route({
              threadId: context.threadId,
              turnId: context.turnId,
              task: common.prompt,
              agentSurface,
              documents,
              mainModel: common.inheritedModel,
              mainProviderId: common.inheritedProviderId,
              abortSignal: context.abortSignal
            })
            resolvedProfile = route.profileId
            if (route.generate) {
              if (!generator) return toolError('subagent generator is unavailable')
              const generated = await generator.generate({
                threadId: context.threadId,
                turnId: context.turnId,
                task: common.prompt,
                roleBrief: route.generate.roleBrief,
                documents: builtinDocuments.filter((document) =>
                  profileAvailableOnSurface(document.profile, agentSurface)),
                toolPolicy: route.generate.permissionHint,
                mainModel: common.inheritedModel,
                mainProviderId: common.inheritedProviderId,
                abortSignal: context.abortSignal
              })
              generatedResult = generated
              inlineProfile = generatedInlineProfile(generated)
              routing = generatedRouteMetadata(route, generated, inlineProfile, agentSurface)
            } else {
              const snapshot = documents.find((document) => document.id === resolvedProfile)
              if (!snapshot) return toolError(`routed subagent profile disappeared: ${resolvedProfile ?? ''}`)
              inlineProfile = { id: snapshot.id, profile: snapshot.profile, source: snapshot.source }
              resolvedProfile = undefined
              routing = existingRouteMetadata(route, agentSurface)
            }
          }

          return await runChild(runtime, common, context, onUpdate, {
            ...(resolvedProfile ? { profile: resolvedProfile } : {}),
            ...(inlineProfile ? { inlineProfile } : {}),
            ...(routing ? { routing } : {})
          }, generatedResult)
        }
      }),
      LocalToolHost.defineTool({
        name: 'generate_subagent',
        description: 'Design a one-run standalone subagent from up to three trusted built-in agent exemplars, then immediately run it. Use when no fixed profile fits or a task needs a narrower custom specialty. The role is not added to settings/catalog; its exact definition is retained in the child-run audit snapshot.',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'A distinct 2-4 word UI title for this child.' },
            prompt: { type: 'string', description: 'The task the generated child must execute.' },
            role_brief: { type: 'string', description: 'Optional expertise, scope, non-goals, and output the generated role should own.' },
            tool_policy: { type: 'string', enum: ['auto', 'readOnly', 'inherit'], description: 'Maximum role tool policy; permissions still cannot exceed the parent.' },
            reference_agent_ids: { type: 'array', maxItems: 3, items: { type: 'string' }, description: 'Optional trusted built-in agent examples.' },
            model: { type: 'string', description: 'Child model override; requires providerId.' },
            providerId: { type: 'string', description: 'Child provider override; requires model.' },
            detach: { type: 'boolean' },
            returnFormat: { type: 'string', enum: ['summary', 'evidence'] }
          },
          required: ['prompt'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context, onUpdate) => {
          if (!generator) return toolError('subagent generator is unavailable')
          const common = parseCommonArgs(args, context)
          if (common instanceof Error) return toolError(common.message)
          const requestedReferences = stringArray(args.reference_agent_ids)
          const unknownReferences = requestedReferences.filter(
            (id) => !Object.prototype.hasOwnProperty.call(BUILTIN_SUBAGENT_PROFILES, id)
          )
          if (unknownReferences.length) {
            return toolError(`unknown built-in reference agent id: ${unknownReferences.join(', ')}`)
          }
          const agentSurface = context.agentSurface ?? 'code'
          const unavailableReferences = requestedReferences.filter((id) => {
            const profile = BUILTIN_SUBAGENT_PROFILES[id]
            return profile ? !profileAvailableOnSurface(profile, agentSurface) : false
          })
          if (unavailableReferences.length) {
            return toolError(`built-in reference agent is unavailable on ${agentSurface}: ${unavailableReferences.join(', ')}`)
          }
          const policy = stringValue(args.tool_policy)
          const generated = await generator.generate({
            threadId: context.threadId,
            turnId: context.turnId,
            task: common.prompt,
            roleBrief: stringValue(args.role_brief) || undefined,
            documents: builtinDocuments.filter((document) =>
              profileAvailableOnSurface(document.profile, agentSurface)),
            ...(requestedReferences.length ? { referenceAgentIds: requestedReferences } : {}),
            toolPolicy: policy === 'readOnly' || policy === 'inherit' ? policy : 'auto',
            mainModel: common.inheritedModel,
            mainProviderId: common.inheritedProviderId,
            abortSignal: context.abortSignal
          })
          const inlineProfile = generatedInlineProfile(generated)
          const routing: ChildRoutingMetadata = {
            method: 'explicit-generated',
            selectedKind: 'generated',
            selectedId: inlineProfile.id,
            reason: generated.reason,
            agentSurface,
            candidates: generated.candidates,
            customAgent: inlineProfile.profile,
            generation: generationSnapshot(generated)
          }
          return await runChild(runtime, common, context, onUpdate, { inlineProfile, routing }, generated)
        }
      })
    ]
  }]
}

function customAgentSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'One-run standalone role written by the parent. Mutually exclusive with profile; not added to settings/catalog, but retained in the child-run audit snapshot.',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      system_prompt: { type: 'string', description: 'Self-contained expertise, scope, procedure, output, verification, and boundaries.' },
      tool_policy: { type: 'string', enum: ['readOnly', 'inherit'] },
      blocked_tools: { type: 'array', items: { type: 'string' } },
      reasoning_effort: { type: 'string', enum: ['auto', 'off', 'low', 'medium', 'high', 'max'] }
    },
    required: ['name', 'description', 'system_prompt'],
    additionalProperties: false
  }
}

function parseCommonArgs(args: Record<string, unknown>, context: ToolHostContext): {
  prompt: string
  workspace: string
  model?: string
  providerId?: string
  inheritedModel?: string
  inheritedProviderId?: string
  label?: string
  detach: boolean
  returnFormat?: 'evidence'
} | Error {
  const prompt = stringValue(args.prompt)
  if (!prompt) return new Error('prompt is required')
  const model = stringValue(args.model)
  const providerId = stringValue(args.providerId)
  if (Boolean(model) !== Boolean(providerId)) return new Error('model and providerId overrides must be supplied together')
  return {
    prompt,
    workspace: context.workspace,
    ...(model ? { model, providerId } : {}),
    ...(context.model?.id?.trim() ? { inheritedModel: context.model.id.trim() } : {}),
    ...(context.modelProviderId?.trim() ? { inheritedProviderId: context.modelProviderId.trim() } : {}),
    ...(stringValue(args.label) ? { label: stringValue(args.label) } : {}),
    detach: args.detach === true,
    ...(args.returnFormat === 'evidence' ? { returnFormat: 'evidence' as const } : {})
  }
}

async function runChild(
  runtime: DelegationRuntime,
  common: Exclude<ReturnType<typeof parseCommonArgs>, Error>,
  context: ToolHostContext,
  onUpdate: ((update: ToolExecutionUpdate) => Promise<void> | void) | undefined,
  selection: { profile?: string; inlineProfile?: InlineProfile; routing?: ChildRoutingMetadata },
  generated?: SubagentGenerationResult
): Promise<{ output: Record<string, unknown>; isError: boolean }> {
  const record = await runtime.runChild({
    parentThreadId: context.threadId,
    parentTurnId: context.turnId,
    prompt: common.prompt,
    workspace: common.workspace,
    ...(common.label ? { label: common.label } : {}),
    ...(common.model ? { model: common.model, providerId: common.providerId } : {}),
    ...(selection.profile ? { profile: selection.profile } : {}),
    ...(selection.inlineProfile ? { inlineProfile: selection.inlineProfile } : {}),
    ...(selection.routing ? { routing: selection.routing } : {}),
    agentSurface: context.agentSurface ?? 'code',
    ...(subagentTaskRequiresReadOnly(common.prompt) ? { toolPolicyCeiling: 'readOnly' as const } : {}),
    security: {
      sandboxRoot: context.workspace,
      ...(context.allowedProviderIds ? { allowedProviderIds: [...context.allowedProviderIds] } : {}),
      ...(context.allowedToolNames ? { allowedToolNames: [...context.allowedToolNames] } : {}),
      ...(context.blockedProviderIds ? { blockedProviderIds: [...context.blockedProviderIds] } : {}),
      ...(context.blockedToolNames ? { blockedToolNames: [...context.blockedToolNames] } : {}),
      ...(context.blockedSkillIds ? { blockedSkillIds: [...context.blockedSkillIds] } : {}),
      memoryEnabled: context.memoryPolicy?.enabled === true
    },
    ...(common.inheritedModel ? { inheritedModel: common.inheritedModel } : {}),
    ...(common.inheritedProviderId ? { inheritedProviderId: common.inheritedProviderId } : {}),
    approvalPolicy: context.approvalPolicy,
    ...(context.sandboxMode ? { sandboxMode: context.sandboxMode } : {}),
    ...(context.guiDesignCanvas ? { guiDesignCanvas: true } : {}),
    ...(common.detach ? { detach: true } : {}),
    ...(common.returnFormat ? { returnFormat: common.returnFormat } : {}),
    onQueued: async (childId, profile) => {
      await onUpdate?.({
        output: {
          childId,
          status: 'queued',
          detached: common.detach,
          ...(profile ? { profile } : {}),
          ...(generated ? { generatedAgent: generatedToolOutput(profile, generated) } : {})
        },
        isError: false
      })
    },
    ...(common.detach ? {} : {
      onRunning: async (childId: string, profile?: string) => {
        await onUpdate?.({
          output: {
            childId,
            status: 'running',
            detached: false,
            ...(profile ? { profile } : {}),
            ...(generated ? { generatedAgent: generatedToolOutput(profile, generated) } : {})
          },
          isError: false
        })
      }
    }),
    signal: context.abortSignal
  })
  return {
    output: {
      childId: record.id,
      status: record.status,
      detached: record.detached === true,
      summary: record.summary,
      error: record.error,
      evidence: record.evidence,
      usage: record.usage,
      returnFormat: record.returnFormat,
      ...(record.profile ? { profile: record.profile } : {}),
      ...(record.routing ? { routing: routingToolOutput(record.routing) } : {}),
      ...(generated ? { generatedAgent: generatedToolOutput(record.profile, generated) } : {}),
      ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
      ...(record.toolInvocations !== undefined ? { toolInvocations: record.toolInvocations } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.queuedMs !== undefined ? { queuedMs: record.queuedMs } : {})
    },
    isError: record.status === 'failed' || record.status === 'aborted'
  }
}

function parseCustomAgent(value: unknown): CustomSubagentDefinition | undefined | Error {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Error('custom_agent must be an object')
  const input = value as Record<string, unknown>
  const parsed = CustomSubagentDefinitionSchema.safeParse({
    name: input.name,
    description: input.description,
    systemPrompt: input.system_prompt,
    toolPolicy: input.tool_policy ?? 'readOnly',
    ...(input.blocked_tools !== undefined ? { blockedTools: input.blocked_tools } : {}),
    ...(input.reasoning_effort !== undefined ? { reasoningEffort: input.reasoning_effort } : {})
  })
  return parsed.success
    ? parsed.data
    : new Error(`invalid custom_agent: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
}

function builtinRoutingDocuments(): SubagentRoutingDocument[] {
  return Object.entries(BUILTIN_SUBAGENT_PROFILES).map(([id, profile]) => ({
    kind: 'profile', id, source: 'builtin', profile,
    routingTerms: BUILTIN_AGENT_CATALOG_BY_ID[id]?.routingTerms
  }))
}

function generatedInlineProfile(generated: SubagentGenerationResult): InlineProfile {
  return {
    id: generatedSubagentProfileId(generated.definition),
    profile: customSubagentProfile(generated.definition),
    source: 'generated'
  }
}

function explicitCustomMetadata(inlineProfile: InlineProfile): ChildRoutingMetadata {
  return {
    method: 'explicit-custom',
    selectedKind: 'custom',
    selectedId: inlineProfile.id,
    reason: 'The parent supplied a one-run standalone role.',
    candidates: [],
    customAgent: inlineProfile.profile
  }
}

function existingRouteMetadata(
  route: SubagentRouteResult,
  agentSurface: 'code' | 'write' | 'design'
): ChildRoutingMetadata {
  return {
    method: route.source === 'llm-profile' ? 'bm25-llm-profile' : 'bm25-fallback-profile',
    selectedKind: 'profile',
    selectedId: route.profileId ?? 'general',
    agentSurface,
    reason: route.reason,
    ...(route.confidence !== undefined ? { confidence: route.confidence } : {}),
    candidates: route.candidates
  }
}

function generatedRouteMetadata(
  route: SubagentRouteResult,
  generated: SubagentGenerationResult,
  inlineProfile: InlineProfile,
  agentSurface: 'code' | 'write' | 'design'
): ChildRoutingMetadata {
  return {
    method: route.source === 'llm-generate' ? 'bm25-llm-generated' : 'bm25-fallback-generated',
    selectedKind: 'generated',
    selectedId: inlineProfile.id,
    agentSurface,
    reason: `${route.reason} ${generated.reason}`.trim(),
    ...(route.confidence !== undefined ? { confidence: route.confidence } : {}),
    candidates: route.candidates,
    customAgent: inlineProfile.profile,
    generation: generationSnapshot(generated)
  }
}

function generationSnapshot(generated: SubagentGenerationResult): NonNullable<ChildRoutingMetadata['generation']> {
  return {
    method: generated.source,
    referenceAgentIds: generated.referenceAgentIds,
    reason: generated.reason
  }
}

function routingToolOutput(routing: ChildRoutingMetadata): Record<string, unknown> {
  return {
    method: routing.method,
    selectedKind: routing.selectedKind,
    selectedId: routing.selectedId,
    ...(routing.reason ? { reason: routing.reason } : {}),
    ...(routing.confidence !== undefined ? { confidence: routing.confidence } : {}),
    candidates: routing.candidates.map((candidate) => ({
      targetId: candidate.targetId,
      name: candidate.name,
      source: candidate.source,
      score: candidate.score
    })),
    ...(routing.generation ? { generation: routing.generation } : {}),
    ...(routing.customAgent ? {
      agent: {
        name: routing.customAgent.name,
        description: routing.customAgent.description,
        toolPolicy: routing.customAgent.toolPolicy,
        reasoningEffort: routing.customAgent.reasoningEffort
      }
    } : {})
  }
}

function generatedToolOutput(profile: string | undefined, generated: SubagentGenerationResult): Record<string, unknown> {
  return {
    id: profile,
    name: generated.definition.name,
    description: generated.definition.description,
    toolPolicy: generated.definition.toolPolicy,
    reasoningEffort: generated.definition.reasoningEffort,
    generationMethod: generated.source,
    referenceAgentIds: generated.referenceAgentIds,
    reason: generated.reason
  }
}

function buildDelegateTaskDescription(runtime: DelegationRuntime, profileCount: number): string {
  return [
    'Run a standalone child agent and return its result. With no profile or custom_agent, BM25 recalls the Top-5 agent profiles and an LLM selects a fitting profile; if none fits, a separate generator designs and runs a one-run role.',
    'Issue multiple calls in one message for independent parallel work.',
    `${profileCount} agent profiles are searchable.`,
    `Children default to the "${runtime.defaultToolPolicy}" tool policy and can never recursively delegate.`
  ].join(' ')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(stringValue).filter(Boolean))].slice(0, 3)
    : []
}

function toolError(message: string): { output: { error: string }; isError: true } {
  return { output: { error: message }, isError: true }
}
