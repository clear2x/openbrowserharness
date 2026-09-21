/**
 * Bundled JSON module shape for the model-rules seed. The wildcard keeps the
 * package's tsc program JSON-import-free (no resolveJsonModule); the actual
 * bytes load through the standard bundler/vitest JSON pipeline.
 */
declare module '*.json' {
  const value: {
    schemaVersion: number
    revision: number
    modelRules: readonly unknown[]
    modelApiRules: readonly unknown[]
    providerTemplates: readonly {
      id: string
      name: string
      nameEn: string
      apiType: string
      baseUrl: string
    }[]
  }
  export default value
}
