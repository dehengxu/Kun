import { useState, type ReactElement } from 'react'
import { SecretInput, SettingsCard, SettingRow, Toggle } from './settings-controls'

const DEFAULT_IMAGE_GENERATION = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  defaultSize: '',
  timeoutMs: 180000
}

export function ImageGenerationSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const {
    t,
    kun,
    updateKun
  } = ctx
  const imageGeneration = {
    ...DEFAULT_IMAGE_GENERATION,
    ...(kun.imageGeneration ?? {})
  }
  const [showImageGenApiKey, setShowImageGenApiKey] = useState(false)
  const updateImageGeneration = (patch: Record<string, unknown>): void => {
    updateKun({
      imageGeneration: {
        ...imageGeneration,
        ...patch
      }
    })
  }

  return (
    <SettingsCard title={t('imageGen')}>
      <SettingRow
        title={t('imageGenEnabled')}
        description={t('imageGenEnabledDesc')}
        control={
          <Toggle
            checked={imageGeneration.enabled}
            onChange={(enabled) => updateImageGeneration({ enabled })}
          />
        }
      />
      {imageGeneration.enabled ? (
        <>
          <SettingRow
            title={t('imageGenBaseUrl')}
            description={t('imageGenBaseUrlDesc')}
            control={
              <input
                className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30 md:max-w-md"
                value={imageGeneration.baseUrl}
                placeholder={t('imageGenBaseUrlPlaceholder')}
                onChange={(e) => updateImageGeneration({ baseUrl: e.target.value })}
              />
            }
          />
          <SettingRow
            title={t('imageGenApiKey')}
            description={t('imageGenApiKeyDesc')}
            control={
              <SecretInput
                value={imageGeneration.apiKey}
                onChange={(value) => updateImageGeneration({ apiKey: value })}
                visible={showImageGenApiKey}
                onToggleVisibility={() => setShowImageGenApiKey((value) => !value)}
                autoComplete="off"
                showLabel={t('showSecret')}
                hideLabel={t('hideSecret')}
                className="md:max-w-md"
              />
            }
          />
          <SettingRow
            title={t('imageGenModel')}
            description={t('imageGenModelDesc')}
            control={
              <input
                className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30 md:max-w-md"
                value={imageGeneration.model}
                placeholder={t('imageGenModelPlaceholder')}
                onChange={(e) => updateImageGeneration({ model: e.target.value })}
              />
            }
          />
          <SettingRow
            title={t('imageGenDefaultSize')}
            description={t('imageGenDefaultSizeDesc')}
            control={
              <input
                className="w-40 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                value={imageGeneration.defaultSize}
                placeholder="1024x1024"
                onChange={(e) => updateImageGeneration({ defaultSize: e.target.value })}
              />
            }
          />
          <SettingRow
            title={t('imageGenTimeout')}
            description={t('imageGenTimeoutDesc')}
            control={
              <input
                type="number"
                min={10000}
                max={600000}
                step={10000}
                className="w-32 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                value={imageGeneration.timeoutMs}
                onChange={(e) => updateImageGeneration({ timeoutMs: Number(e.target.value) })}
              />
            }
          />
        </>
      ) : null}
    </SettingsCard>
  )
}
