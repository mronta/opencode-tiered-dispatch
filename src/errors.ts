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

export class ProviderDispatchError extends DispatchError {
  override readonly name = "TieredDispatchProviderError"
  readonly providerError: ProviderErrorRecord

  constructor(providerError: ProviderErrorRecord) {
    const type = typeof providerError.type === "string" ? providerError.type : undefined
    const message = typeof providerError.message === "string" ? providerError.message : undefined
    const detail = message ?? type ?? "unknown provider error"
    super(type && message ? `${type}: ${detail}` : detail, { cause: providerError })
    this.providerError = providerError
  }
}
