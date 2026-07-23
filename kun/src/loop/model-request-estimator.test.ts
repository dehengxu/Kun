import { describe, expect, it } from 'vitest'
import { estimateModelRequestInputTokens } from './model-request-estimator.js'
import type { ModelRequest } from '../ports/model-client.js'

describe('estimateModelRequestInputTokens', () => {
  it('includes document and image attachment payloads', () => {
    const request: ModelRequest = {
      threadId: 'thr_estimate',
      turnId: 'turn_estimate',
      model: 'model',
      systemPrompt: 'system',
      prefix: [],
      history: [],
      tools: [],
      attachments: [{ id: 'image', name: 'image.png', mimeType: 'image/png', dataBase64: 'a'.repeat(400) }],
      attachmentDocuments: [{ id: 'doc', name: 'doc.txt', mimeType: 'text/plain', text: 'b'.repeat(400), byteSize: 400 }],
      abortSignal: new AbortController().signal
    }

    expect(estimateModelRequestInputTokens(request)).toBeGreaterThanOrEqual(2_100)
  })

  it('includes a separate thread profile in request overhead', () => {
    const base: ModelRequest = {
      threadId: 'thr_profile_estimate',
      turnId: 'turn_profile_estimate',
      model: 'model',
      systemPrompt: 'stable',
      prefix: [],
      history: [],
      tools: [],
      abortSignal: new AbortController().signal
    }

    expect(estimateModelRequestInputTokens({
      ...base,
      threadProfileInstruction: 'p'.repeat(400)
    })).toBeGreaterThanOrEqual(estimateModelRequestInputTokens(base) + 100)
  })
})
