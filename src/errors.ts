export class TieredDispatchError extends Error {
  override readonly name: string = "TieredDispatchError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export class ConfigurationError extends TieredDispatchError {
  override readonly name = "TieredDispatchConfigurationError"
}

export class DispatchError extends TieredDispatchError {
  override readonly name: string = "TieredDispatchExecutionError"
}

export type ProviderErrorRecord = Readonly<Record<string, unknown>> & {
  type?: unknown
  message?: unknown
  status?: unknown
}
