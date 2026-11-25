export class IngestionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'IngestionError'
  }
}

export class SyncAlreadyRunningError extends IngestionError {
  constructor() {
    super('sync_already_running')
    this.name = 'SyncAlreadyRunningError'
  }
}
