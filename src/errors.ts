export class TieredDispatchError extends Error {
  override readonly name: string = "TieredDispatchError"
}

export class ConfigurationError extends TieredDispatchError {
  override readonly name = "TieredDispatchConfigurationError"
}

export class DispatchError extends TieredDispatchError {
  override readonly name = "TieredDispatchExecutionError"
}
