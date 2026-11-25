export const MULTI_OUTCOME_ACCOUNT_ID = 'fixture-multisided-account'
export const SNAPSHOT_ACCOUNT_ID = 'fixture-snapshot-account'

export const multiOutcomePages: Record<string, unknown> = {
  first: {
    markets: [
      {
        eventId: 'event-city-election-2026',
        eventName: '2026 City Council election',
        eventDescription: 'Fixture event with three independently tradable outcomes.',
        resolutionRules: 'The outcome is based on the certified election result.',
        eventLifecycle: 'open',
        eventResolvesAt: '2026-12-01T00:00:00Z',
        marketId: 'market-city-council-winner',
        marketTitle: 'Who wins the city council seat?',
        marketLifecycle: 'open',
        settlementRules: 'One listed candidate outcome receives the market payout.',
        settlementAssetCode: 'USD',
        sourceUpdatedAt: '2026-11-24T09:00:00Z',
        outcomes: [
          { id: 'candidate-north', name: 'North', type: 'candidate', payout: null, asset: 'USD' },
          { id: 'candidate-south', name: 'South', type: 'candidate', payout: null, asset: 'USD' },
          { id: 'other-candidate', name: 'Other', type: 'candidate', payout: null, asset: 'USD' },
        ],
      },
    ],
    trades: [
      {
        id: 'fill-multi-001',
        contract: 'market-city-council-winner',
        outcome: 'candidate-north',
        action: 'buy',
        timestamp: '2026-11-20T12:30:00Z',
        quantity: '12.000000000000000001',
        price: '0.234567890123456789',
        feeAmount: null,
        feeStatus: 'unavailable',
        asset: 'USD',
        finality: 'confirmed',
      },
    ],
    transfers: [
      {
        id: 'deposit-multi-001',
        direction: 'deposit',
        timestamp: '2026-11-18T08:00:00Z',
        amount: '250.000000000000000001',
        asset: 'USD',
        feeAmount: null,
        feeStatus: 'unavailable',
      },
    ],
    positions: [
      {
        id: 'position-multi-001-20261124',
        contract: 'market-city-council-winner',
        outcome: 'candidate-north',
        observed: '2026-11-24T10:00:00Z',
        quantity: '12.000000000000000001',
        averageCost: '0.234567890123456789',
        mark: '0.250000000000000001',
        markTimestamp: '2026-11-24T09:59:00Z',
        asset: 'USD',
        origin: 'provider_reported',
      },
    ],
    cash: [
      {
        id: 'cash-multi-20261124',
        observed: '2026-11-24T10:00:00Z',
        amount: '800.123456789012345678',
        asset: 'USD',
      },
    ],
    prices: [
      {
        id: 'mark-multi-001',
        contract: 'market-city-council-winner',
        outcome: 'candidate-north',
        observed: '2026-11-24T09:59:00Z',
        value: '0.250000000000000001',
        kind: 'last_trade',
        asset: 'USD',
      },
    ],
    settlements: [],
  },
  second: {
    markets: [],
    trades: [
      {
        id: 'fill-multi-002',
        contract: 'market-city-council-winner',
        outcome: 'candidate-south',
        action: 'buy',
        timestamp: '2026-11-21T13:15:00Z',
        quantity: '2.5',
        price: '0.4',
        feeAmount: '0.01',
        feeStatus: 'reported',
        asset: 'USD',
        finality: 'confirmed',
      },
    ],
    transfers: [
      {
        id: 'withdrawal-multi-001',
        direction: 'withdrawal',
        timestamp: '2026-11-22T07:30:00Z',
        amount: '25.00',
        asset: 'USD',
        feeAmount: '0.10',
        feeStatus: 'reported',
      },
    ],
    positions: [],
    cash: [],
    prices: [],
    settlements: [
      {
        id: 'settlement-multi-001',
        contract: 'market-city-council-winner',
        outcome: 'other-candidate',
        timestamp: '2026-11-23T12:00:00Z',
        quantity: '3.25',
        payout: '2.75',
        asset: 'USD',
        feeAmount: '0.02',
        feeStatus: 'reported',
      },
    ],
  },
}

export const snapshotPage: unknown = {
  contracts: [
    {
      caseId: 'event-river-level',
      caseName: 'River level above 4 metres',
      resolution: 'Official gauge reading at the specified station.',
      caseStatus: 'open',
      marketRef: 'contract-river-level',
      question: 'Will the river exceed 4 metres?',
      contractStatus: 'open',
      collateral: 'USDC',
      outcomes: [
        { legRef: 'leg-river-yes', label: 'Yes', kind: 'yes', payoutUnits: null },
        { legRef: 'leg-river-no', label: 'No', kind: 'no', payoutUnits: null },
      ],
    },
  ],
  executions: [
    {
      fillRef: 'execution-snapshot-001',
      contractRef: 'contract-river-level',
      legRef: 'leg-river-yes',
      verb: 'buy',
      filledAt: '2026-11-19T06:00:00Z',
      lots: '40.000000000000000000',
      unitPrice: '0.625',
      fee: { status: 'estimated', value: '0.31' },
      collateral: 'USDC',
      transactionState: 'final',
    },
  ],
  accountChanges: [
    {
      changeRef: 'account-change-snapshot-001',
      type: 'deposit',
      effectiveAt: '2026-11-17T02:00:00Z',
      delta: '500.00',
      collateral: 'USDC',
      charge: null,
      chargeState: 'unavailable',
    },
  ],
  holdings: [
    {
      holdingRef: 'holding-snapshot-001-20261124',
      contractRef: 'contract-river-level',
      legRef: 'leg-river-yes',
      snapshotAt: '2026-11-24T04:00:00Z',
      contractsHeld: '40',
      averageEntry: '0.625',
      currentMark: null,
      collateral: 'USDC',
      reportedByProvider: true,
    },
  ],
  accountBalance: null,
}
