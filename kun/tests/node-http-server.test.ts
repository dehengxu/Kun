import { describe, expect, it } from 'vitest'
import { startNodeHttpServer } from '../src/server/node-http-server.js'
import { Router } from '../src/server/router.js'

describe('Node HTTP server', () => {
  it('hides internal exception details in 500 responses', async () => {
    const router = new Router()
    router.add('GET', '/boom', () => {
      throw new Error('leaked stack detail: /tmp/private-token')
    })
    const server = await startNodeHttpServer({
      router,
      host: '127.0.0.1',
      port: 0
    })

    try {
      const response = await fetch(`http://${server.host}:${server.port}/boom`)
      const body = await response.json() as { code?: string; message?: string }

      expect(response.status).toBe(500)
      expect(body).toEqual({
        code: 'internal_error',
        message: 'Internal server error.'
      })
      expect(JSON.stringify(body)).not.toContain('private-token')
    } finally {
      await server.close()
    }
  })
})
