import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import { ContextEstimator } from './context-estimator.js'
import { IMAGE_TOOL_RESULT_TOKEN_ESTIMATE } from './tool-result-image.js'

function toolResult(output: unknown): Extract<TurnItem, { kind: 'tool_result' }> {
  return {
    id: 'i', turnId: 't', threadId: 'th', role: 'tool', status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z', kind: 'tool_result',
    toolName: 'computer_use', callId: 'c', toolKind: 'command_execution', output, isError: false
  }
}

describe('ContextEstimator image awareness', () => {
  it('charges a screenshot a flat vision cost, not its base64 length', () => {
    const estimator = new ContextEstimator()
    const hugeBase64 = 'A'.repeat(400_000) // ~100k tokens if counted as text
    const item = toolResult({
      kind: 'computer_screenshot',
      screen: { width: 1280, height: 800 },
      images: [{ mime_type: 'image/png', data_base64: hugeBase64, width: 1280, height: 800 }]
    })
    const tokens = estimator.estimateItem(item)
    // Must be dominated by the flat per-image estimate, NOT the 100k-token base64.
    expect(tokens).toBeLessThan(IMAGE_TOOL_RESULT_TOKEN_ESTIMATE + 2_000)
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOOL_RESULT_TOKEN_ESTIMATE)
  })

  it('still counts ordinary (non-image) tool output by its text length', () => {
    const estimator = new ContextEstimator()
    const big = toolResult({ output: 'x'.repeat(40_000) })
    expect(estimator.estimateItem(big)).toBeGreaterThan(5_000)
  })
})
