export type DataMigrationFeatureEnvironment = {
  KUN_DATA_MIGRATION_ENABLED?: string
}

/**
 * Data migration is a released desktop capability. Packaged applications are
 * normally launched without the environment from the machine that built them,
 * so absence of the override must keep the feature enabled.
 *
 * Managed or diagnostic launches can still set the override to `0` to stop new
 * exports/imports while leaving interrupted-operation recovery available.
 */
export function resolveDataMigrationFeatureEnabled(
  environment: DataMigrationFeatureEnvironment = {
    KUN_DATA_MIGRATION_ENABLED: process.env.KUN_DATA_MIGRATION_ENABLED
  }
): boolean {
  return environment.KUN_DATA_MIGRATION_ENABLED !== '0'
}
