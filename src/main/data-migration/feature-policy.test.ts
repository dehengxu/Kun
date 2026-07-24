import { describe, expect, it } from 'vitest'
import { resolveDataMigrationFeatureEnabled } from './feature-policy'

describe('data migration release policy', () => {
  it('enables normal packaged launches that do not inherit the build environment', () => {
    expect(resolveDataMigrationFeatureEnabled({})).toBe(true)
  })

  it('accepts an explicit enable override', () => {
    expect(resolveDataMigrationFeatureEnabled({ KUN_DATA_MIGRATION_ENABLED: '1' })).toBe(true)
  })

  it('keeps the emergency disable override', () => {
    expect(resolveDataMigrationFeatureEnabled({ KUN_DATA_MIGRATION_ENABLED: '0' })).toBe(false)
  })
})
