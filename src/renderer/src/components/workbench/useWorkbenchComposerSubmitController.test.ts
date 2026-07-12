import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useCallback: <T>(callback: T): T => callback
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string): string => key
  })
}))

import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { useWorkbenchComposerSubmitController } from './useWorkbenchComposerSubmitController'

describe('useWorkbenchComposerSubmitController', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { kunGui: {} })
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/missing-write-workspace',
      activeFilePath: '/missing-write-workspace/draft.md',
      quotedSelections: [],
      agentPresets: [],
      assistantAgentPresetId: '',
      assistantModel: '',
      assistantProviderId: ''
    })
  })

  it('restores the Write draft when an existing mapped thread rejects the send', async () => {
    const setInput = vi.fn()
    const sendMessage = vi.fn(async () => false)
    const controller = useWorkbenchComposerSubmitController({
      activeClawChannelId: '',
      activeSddDraft: false,
      activeThreadId: 'thr_mapped',
      attachmentUploadEnabled: true,
      buildCodeCanvasOutboundPrompt: vi.fn(async () => ''),
      clearComposerAttachments: vi.fn(),
      clearComposerFileReferences: vi.fn(),
      composerAttachments: [],
      composerFileReferences: [],
      composerMode: 'agent',
      composerModelGroups: [],
      composerReasoningEffort: 'auto',
      ensureWriteThreadForWorkspace: vi.fn(async () => 'thr_mapped'),
      getAttachmentScope: () => 'write',
      handleGuiPlanCommand: vi.fn(),
      input: 'keep this prompt',
      resetClawChannelSession: vi.fn(async () => undefined),
      rightPanelMode: null,
      route: 'write',
      selectClawChannel: vi.fn(async () => undefined),
      sendMessage,
      sendPlanTurn: vi.fn(async () => false),
      sendSddAssistantPrompt: vi.fn(async () => undefined),
      setAttachmentUploadError: vi.fn(),
      setClawChannelModel: vi.fn(async () => undefined),
      setError: vi.fn(),
      setInput,
      threads: [],
      workspaceRoot: '/missing-write-workspace',
      appendLocalClawTurn: vi.fn()
    })

    controller.sendWritePrompt('keep this prompt')

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(setInput).toHaveBeenLastCalledWith('keep this prompt'))
    expect(setInput.mock.calls).toEqual([[''], ['keep this prompt']])
  })
})
