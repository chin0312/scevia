import type { CoverageEntity, CoverageState, NormalizedRecord, ProviderCapabilities } from '../domain/model.js'

export interface ProviderPage {
  payload: unknown
  nextCursor: string | null
  sourceAsOf: string | null
  coverage: Partial<Record<CoverageEntity, CoverageState>>
}

export interface FetchPageRequest {
  externalAccountId: string
  cursor: string | null
  signal: AbortSignal
}

export interface ProviderAdapter {
  readonly capabilities: ProviderCapabilities
  fetchPage(request: FetchPageRequest): Promise<ProviderPage>
  normalizePage(page: ProviderPage): NormalizedRecord[]
}

export class ProviderAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code)
    this.name = 'ProviderAdapterError'
  }
}
