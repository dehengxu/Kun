import { describe, expect, it } from 'vitest'
import { parseDelegateDetail } from './SubagentCallCard'

describe('parseDelegateDetail', () => {
  it('reads the generated role name from the direct generated-agent result', () => {
    expect(parseDelegateDetail(JSON.stringify({
      profile: 'generated:ipc-investigator:12345678',
      generatedAgent: { name: 'IPC Investigator' }
    }))).toMatchObject({
      generated: true,
      generatedAgentName: 'IPC Investigator'
    })
  })

  it('falls back to the generated role snapshot embedded in routing metadata', () => {
    expect(parseDelegateDetail(JSON.stringify({
      profile: 'generated:browser-qa:12345678',
      routing: {
        selectedKind: 'generated',
        agent: { name: 'Browser QA Specialist' }
      }
    }))).toMatchObject({
      generated: true,
      generatedAgentName: 'Browser QA Specialist'
    })
  })
})
