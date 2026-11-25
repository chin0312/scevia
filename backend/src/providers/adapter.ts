import type { CoverageEntity, EntityCoverageReport, NormalizedRecord, ProviderCapabilities } from '../domain/model.js'

export interface ProviderPage {
  payload: unknown
  nextCursor: string | null
  checkpoint: string | null
  coverage: Partial<Record<CoverageEntity, EntityCoverageReport>>
}

export interface FetchPageRequest {
  externalAccountId: string
  streamName: string
  cursor: string | null
  checkpoint: string | null
  signal: AbortSignal
}

export interface ProviderAdapter {
  readonly capabilities: ProviderCapabilities
  fetchPage(request: FetchPageRequest): Promise<ProviderPage>
  normalizePage(page: ProviderPage, streamName: string): NormalizedRecord[]
}

export class ProviderAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code)
    this.name = 'ProviderAdapterError'
  }
}
