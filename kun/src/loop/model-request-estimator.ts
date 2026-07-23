import type { TurnItem } from '../contracts/items.js'
import type {
  ModelDocumentAttachment,
  ModelInputAttachment,
  ModelRequest,
  ModelTextAttachmentFallback,
  ModelToolSpec
} from '../ports/model-client.js'
import { ContextEstimator } from './context-estimator.js'

const CHARS_PER_TOKEN = 4

const estimator = new ContextEstimator(CHARS_PER_TOKEN)

export function estimateModelRequestInputTokens(request: ModelRequest): number {
  let tokens = 0
  tokens += estimateText(request.systemPrompt)
  tokens += estimateText(request.threadProfileInstruction)
  tokens += estimateText(request.modeInstruction)
  tokens += estimateText(request.contextInstructions?.join('\n'))
  tokens += estimateItems(request.prefix)
  tokens += estimateItems(request.history)
  tokens += estimateTools(request.tools)
  tokens += estimateTextFallbacks(request.attachmentTextFallbacks)
  tokens += estimateDocuments(request.attachmentDocuments)
  tokens += estimateImageAttachments(request.attachments)
  tokens += estimateText(request.requiredToolName)
  tokens += estimateText(request.reasoningEffort)
  return Math.max(0, tokens)
}

/**
 * Estimate the per-request token overhead that is sent on *every* turn
 * but is not part of the stored conversation items: the system prompt,
 * the few-shot prefix, the mode/context instructions, and the full tool
 * schemas. The item-only {@link ContextEstimator} ignores all of this,
 * which makes compaction under-trigger when no provider usage count is
 * available (e.g. the first turn after a process restart). Compaction
 * adds this overhead to its history estimate as a safety floor.
 */
export function estimateRequestOverheadTokens(input: {
  systemPrompt?: string
  threadProfileInstruction?: string
  modeInstruction?: string
  contextInstructions?: string[]
  prefix?: TurnItem[]
  tools?: readonly ModelToolSpec[]
}): number {
  let tokens = 0
  tokens += estimateText(input.systemPrompt)
  tokens += estimateText(input.threadProfileInstruction)
  tokens += estimateText(input.modeInstruction)
  tokens += estimateText(input.contextInstructions?.join('\n'))
  tokens += estimateItems(input.prefix)
  tokens += estimateTools(input.tools)
  return Math.max(0, tokens)
}

function estimateItems(items?: TurnItem[]): number {
  return items && items.length > 0 ? estimator.estimateItems(items) : 0
}

function estimateTools(tools?: readonly ModelToolSpec[]): number {
  if (!tools?.length) return 0
  return tools.reduce((sum, tool) => {
    return sum + estimateText([
      tool.name,
      tool.description,
      JSON.stringify(tool.inputSchema)
    ].join('\n'))
  }, 0)
}

function estimateTextFallbacks(fallbacks?: ModelTextAttachmentFallback[]): number {
  if (!fallbacks?.length) return 0
  return fallbacks.reduce((sum, attachment) => {
    return sum + estimateText([
      attachment.name,
      attachment.mimeType,
      String(attachment.byteSize),
      attachment.dataBase64
    ].join('\n'))
  }, 0)
}

function estimateDocuments(documents?: ModelDocumentAttachment[]): number {
  if (!documents?.length) return 0
  return documents.reduce((sum, document) => sum + estimateText([
    document.name,
    document.mimeType,
    document.text
  ].join('\n')), 0)
}

/**
 * Providers meter vision input differently from the base64 transport encoding.
 * Estimate from pixels when known (with a conservative fallback) so normal
 * image inputs are included in the hard cap without treating their 4/3 wire
 * encoding as text tokens.
 */
function estimateImageAttachments(attachments?: ModelInputAttachment[]): number {
  if (!attachments?.length) return 0
  return attachments.reduce((sum, attachment) => {
    const pixels = (attachment.width ?? 0) * (attachment.height ?? 0)
    const imageTokens = pixels > 0 ? Math.max(256, Math.ceil(pixels / 768)) : 2_048
    return sum + imageTokens + estimateText(`${attachment.name}\n${attachment.mimeType}`)
  }, 0)
}

function estimateText(text?: string): number {
  if (!text?.trim()) return 0
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}
