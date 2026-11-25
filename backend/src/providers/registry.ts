import type { ProviderAdapter } from './adapter.js'
import { ProviderAdapterError } from './adapter.js'
import { MultiOutcomeFixtureAdapter } from './fixtures/multi-outcome-adapter.js'
import { SnapshotFixtureAdapter } from './fixtures/snapshot-adapter.js'
import { PolymarketAdapter } from './polymarket/adapter.js'

export class ProviderRegistry {
  private readonly adapters: Map<string, ProviderAdapter>

  constructor(adapters: ProviderAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.capabilities.providerCode, adapter]))
    if (this.adapters.size !== adapters.length) throw new Error('Provider codes must be unique')
  }

  get(providerCode: string): ProviderAdapter {
    const adapter = this.adapters.get(providerCode)
    if (!adapter) throw new ProviderAdapterError('provider_adapter_unavailable', false)
    return adapter
  }

  listCapabilities() {
    return Array.from(this.adapters.values(), ({ capabilities }) => capabilities)
  }
}

export const providerRegistry = new ProviderRegistry([
  new PolymarketAdapter(),
  new MultiOutcomeFixtureAdapter(),
  new SnapshotFixtureAdapter(),
])
