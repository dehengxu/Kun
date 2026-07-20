import { describe, expect, it, vi } from 'vitest'
import type { AppSettingsV1 } from '../shared/app-settings'
import {
  MODELS_DEV_CACHE_TTL_MS,
  MODELS_DEV_MAX_RESPONSE_BYTES,
  ModelsDevCatalogService,
  resolveModelsDevProvider
} from './models-dev-catalog'

function catalogBody(): string {
  return JSON.stringify({
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      api: 'https://api.deepseek.com',
      models: {
        'deepseek-chat': {
          id: 'deepseek-chat',
          name: 'DeepSeek Chat',
          description: 'General chat model',
          reasoning: false,
          tool_call: true,
          modalities: { input: ['text', 'image', 'unknown'], output: ['text'] },
          limit: { context: 128_000, output: 16_000 },
          cost: { input: 1, output: 2 }
        }
      }
    },
    openai: {
      id: 'openai',
      name: 'OpenAI',
      models: {
        'gpt-5.5': {
          id: 'gpt-5.5',
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 1_000_000, output: 128_000 }
        }
      }
    },
    'future-provider': {
      id: 'future-provider',
      name: 'Future Provider',
      api: 'https://future.example/v1',
      models: {
        'future-model': {
          id: 'future-model',
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 64_000 }
        }
      }
    },
    'ambiguous-one': {
      id: 'ambiguous-one',
      name: 'Ambiguous One',
      api: 'https://ambiguous.example/v1',
      models: {}
    },
    'ambiguous-two': {
      id: 'ambiguous-two',
      name: 'Ambiguous Two',
      api: 'https://ambiguous.example/v1',
      models: {}
    }
  })
}

function proxySettings(): AppSettingsV1 {
  return {
    provider: {
      proxy: { enabled: true, url: 'http://127.0.0.1:7890' }
    }
  } as unknown as AppSettingsV1
}

describe('resolveModelsDevProvider', () => {
  it.each([
    ['deepseek', 'https://api.deepseek.com/v1', 'deepseek', 'catalog'],
    ['longcat', 'https://api.longcat.chat/openai', 'longcat', 'catalog'],
    ['zhipu-coding-plan', 'https://example.invalid/custom', 'zhipuai-coding-plan', 'catalog'],
    ['zai-coding-plan', 'https://example.invalid/custom', 'zai-coding-plan', 'catalog'],
    ['kimi-code', 'https://api.kimi.com/coding/v1', 'kimi-for-coding', 'catalog'],
    ['opencode-go', 'https://opencode.ai/zen/go/v1', 'opencode-go', 'catalog'],
    ['moonshot-cn', 'https://api.moonshot.cn/v1', 'moonshotai-cn', 'catalog'],
    ['moonshot-global', 'https://api.moonshot.ai/v1', 'moonshotai', 'catalog'],
    ['xiaomi', 'https://api.xiaomimimo.com/v1', 'xiaomi', 'catalog'],
    ['xiaomi-token-plan', 'https://token-plan-cn.xiaomimimo.com/v1/', 'xiaomi-token-plan-cn', 'catalog'],
    ['xiaomi-token-plan', 'https://token-plan-sgp.xiaomimimo.com/v1', 'xiaomi-token-plan-sgp', 'catalog'],
    ['xiaomi-token-plan', 'https://token-plan-ams.xiaomimimo.com/v1', 'xiaomi-token-plan-ams', 'catalog'],
    ['minimax-token-plan', 'https://api.minimax.io/anthropic', 'minimax-coding-plan', 'catalog'],
    ['minimax-token-plan', 'https://api.minimaxi.com/anthropic', 'minimax-cn-coding-plan', 'catalog'],
    ['minimax', 'https://api.minimaxi.com/anthropic', 'minimax-cn', 'catalog'],
    ['minimax', 'https://api.minimax.io/anthropic', 'minimax', 'catalog'],
    ['aliyun', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'alibaba-cn', 'catalog'],
    ['aliyun', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'alibaba', 'catalog'],
    ['aliyun-token-plan', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'alibaba-token-plan-cn', 'catalog'],
    ['aliyun-token-plan', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'alibaba-token-plan', 'catalog'],
    ['tencentcloud-token-plan', 'https://api.lkeap.cloud.tencent.com/plan/v3', 'tencent-token-plan', 'catalog'],
    ['codex', 'https://chatgpt.com/backend-api/codex/responses', 'openai', 'enrichment-only'],
    ['claude-subscription', 'https://api.anthropic.com', 'anthropic', 'enrichment-only'],
    ['vercel-ai-gateway', 'https://ai-gateway.vercel.sh/v1', 'vercel', 'catalog']
  ])('maps %s deterministically', (providerId, baseUrl, providerKey, matchMode) => {
    expect(resolveModelsDevProvider({ providerId, baseUrl })).toEqual({ providerKey, matchMode })
  })

  it('uses exact unambiguous URLs for custom profile ids and refuses fuzzy matches', () => {
    expect(resolveModelsDevProvider({
      providerId: 'my-moonshot',
      baseUrl: 'https://api.moonshot.cn/v1/'
    })).toEqual({ providerKey: 'moonshotai-cn', matchMode: 'catalog' })
    expect(resolveModelsDevProvider({
      providerId: 'looks-like-minimax',
      baseUrl: 'https://proxy.example/minimax'
    })).toBeNull()
    expect(resolveModelsDevProvider({
      providerId: 'volcengine-coding-plan',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3'
    })).toBeNull()
  })
})

describe('ModelsDevCatalogService', () => {
  it('sanitizes one matched provider and never sends provider credentials', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL,
      _init: RequestInit | undefined,
      _proxyUrl: string
    ) => new Response(catalogBody(), {
      status: 200,
      headers: { etag: '"catalog-v1"' }
    }))
    const service = new ModelsDevCatalogService(fetcher)

    const result = await service.fetch({
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com'
    }, proxySettings())

    expect(result).toEqual({
      status: 'ok',
      providerKey: 'deepseek',
      providerName: 'DeepSeek',
      matchMode: 'catalog',
      stale: false,
      models: [{
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        description: 'General chat model',
        reasoning: false,
        toolCalling: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000
      }]
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' }
      }),
      'http://127.0.0.1:7890/'
    )
    const headers = fetcher.mock.calls[0]?.[1]?.headers
    expect(JSON.stringify(headers)).not.toContain('apiKey')
    expect(JSON.stringify(headers)).not.toContain('Authorization')
  })

  it('uses a unique exact catalog API URL as the custom-provider fallback', async () => {
    const fetcher = vi.fn(async () => new Response(catalogBody(), { status: 200 }))
    const service = new ModelsDevCatalogService(fetcher)
    await expect(service.fetch({
      providerId: 'custom-provider',
      baseUrl: 'https://future.example/v1/'
    })).resolves.toMatchObject({
      status: 'ok',
      providerKey: 'future-provider',
      models: [{ id: 'future-model', contextWindowTokens: 64_000 }]
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses absent, ambiguous, and invalid custom provider matches', async () => {
    const fetcher = vi.fn(async () => new Response(catalogBody(), { status: 200 }))
    const service = new ModelsDevCatalogService(fetcher)
    await expect(service.fetch({
      providerId: 'custom-provider',
      baseUrl: 'https://missing.example/v1'
    })).resolves.toEqual({ status: 'unmapped', models: [] })
    await expect(service.fetch({
      providerId: 'custom-provider',
      baseUrl: 'https://ambiguous.example/v1'
    })).resolves.toEqual({ status: 'unmapped', models: [] })
    await expect(service.fetch({
      providerId: 'custom-provider',
      baseUrl: 'not-a-url'
    })).resolves.toEqual({ status: 'unmapped', models: [] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reuses fresh cache and deduplicates concurrent loads', async () => {
    const fetcher = vi.fn(async () => new Response(catalogBody(), { status: 200 }))
    const service = new ModelsDevCatalogService(fetcher)
    const request = { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com' }

    const [first, second] = await Promise.all([service.fetch(request), service.fetch(request)])
    const third = await service.fetch(request)

    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    expect(third.status).toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('revalidates a fresh cache when a manual refresh is requested', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(catalogBody(), {
        status: 200,
        headers: { etag: '"catalog-v1"' }
      }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const service = new ModelsDevCatalogService(fetcher)
    const request = { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com' }

    await service.fetch(request)
    await service.fetch({ ...request, forceRefresh: true })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({
      Accept: 'application/json',
      'If-None-Match': '"catalog-v1"'
    })
  })

  it('uses ETag conditional refresh after the freshness window', async () => {
    let now = 1_000
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(catalogBody(), {
        status: 200,
        headers: { etag: '"catalog-v1"' }
      }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const service = new ModelsDevCatalogService(fetcher, () => now)
    const request = { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com' }

    await service.fetch(request)
    now += MODELS_DEV_CACHE_TTL_MS + 1
    const refreshed = await service.fetch(request)

    expect(refreshed.status).toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({
      Accept: 'application/json',
      'If-None-Match': '"catalog-v1"'
    })
  })

  it('falls back to stale cache when refresh fails', async () => {
    let now = 1_000
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(catalogBody(), { status: 200 }))
      .mockRejectedValueOnce(new Error('offline'))
    const service = new ModelsDevCatalogService(fetcher, () => now)
    const request = { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com' }

    await service.fetch(request)
    now += MODELS_DEV_CACHE_TTL_MS + 1
    const stale = await service.fetch(request)

    expect(stale).toMatchObject({ status: 'ok', stale: true })
  })

  it('reports malformed, oversized, and timed-out first loads', async () => {
    const oversized = new ModelsDevCatalogService(vi.fn(async () => new Response('', {
      status: 200,
      headers: { 'content-length': String(MODELS_DEV_MAX_RESPONSE_BYTES + 1) }
    })))
    const malformed = new ModelsDevCatalogService(vi.fn(async () => new Response('{', { status: 200 })))
    const timeoutError = new Error('timed out')
    timeoutError.name = 'TimeoutError'
    const timedOut = new ModelsDevCatalogService(vi.fn(async () => { throw timeoutError }))
    const request = { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com' }

    await expect(oversized.fetch(request)).resolves.toMatchObject({
      status: 'error',
      message: expect.stringContaining('byte limit')
    })
    await expect(malformed.fetch(request)).resolves.toEqual({
      status: 'error',
      message: 'models.dev returned invalid JSON.',
      models: []
    })
    await expect(timedOut.fetch(request)).resolves.toMatchObject({
      status: 'error',
      message: 'Request to models.dev timed out after 10s.'
    })
  })
})
