/**
 * Small, dependency-free deadline helpers used by the native smoke runner.
 *
 * A timeout implemented with Promise.race alone does not stop fetch.  These
 * helpers own an AbortController for every attempt so a request that is still
 * pending when its deadline expires receives an actual abort signal.
 */

export class NativeDeadlineError extends Error {
  constructor(message, { deadline, input } = {}) {
    super(message)
    this.name = "NativeDeadlineError"
    this.code = "NATIVE_DEADLINE_EXCEEDED"
    this.deadline = deadline
    if (input !== undefined) this.input = input
  }
}

export function deadlineFromTimeout(timeoutMs, now = Date.now) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeout must be a positive finite number, got ${timeoutMs}`)
  }
  return now() + timeoutMs
}

/**
 * Run an operation with a signal that is aborted at an absolute deadline.
 * `operation` is allowed to reject normally; only the owned deadline error is
 * translated, so provider/HTTP errors remain available to callers.
 */
export async function runWithDeadline(operation, {
  deadline,
  timeoutMs,
  now = Date.now,
  signal,
  timeoutMessage = "native operation timed out",
  input,
} = {}) {
  const actualDeadline = deadline === undefined
    ? deadlineFromTimeout(timeoutMs, now)
    : deadline
  const remaining = actualDeadline - now()
  if (!Number.isFinite(remaining)) {
    throw new Error(`deadline must be a finite timestamp, got ${actualDeadline}`)
  }
  if (remaining <= 0) {
    throw new NativeDeadlineError(timeoutMessage, { deadline: actualDeadline, input })
  }

  const controller = new AbortController()
  const detach = forwardAbort(signal, controller)
  let timeoutError
  let timer
  let settled = false
  const operationPromise = Promise.resolve().then(() => operation(controller.signal))
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timeoutError = new NativeDeadlineError(timeoutMessage, { deadline: actualDeadline, input })
      controller.abort(timeoutError)
      reject(timeoutError)
    }, Math.max(0, remaining))
  })

  operationPromise.then(
    () => { settled = true },
    () => { settled = true },
  )

  try {
    return await Promise.race([operationPromise, timeoutPromise])
  } catch (error) {
    if (timeoutError !== undefined) throw timeoutError
    throw error
  } finally {
    clearTimeout(timer)
    detach()
    // A non-cooperative operation may ignore AbortSignal.  Abort it once more
    // during cleanup, while never aborting a caller-owned signal.
    if (!settled && !controller.signal.aborted) controller.abort()
    // Promise.race attaches a rejection handler, but retain this explicit
    // sink for an operation that settles after the race has returned.
    void operationPromise.catch(() => {})
  }
}

/**
 * Fetch a response before an absolute deadline.  The deadline covers the
 * fetch promise itself; use fetchJsonWithDeadline when the response body is
 * also part of the bounded operation.
 */
export async function fetchWithDeadline(input, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") throw new Error("global fetch is not available")
  const { fetchImpl: _ignored, signal: optionSignal, ...deadlineOptions } = options
  return runWithDeadline(
    (signal) => fetchImpl(input, { ...init, signal }),
    { ...deadlineOptions, signal: optionSignal ?? init.signal, input: String(input) },
  )
}

/**
 * Fetch and decode JSON while retaining the response for status checks.  This
 * is the form used by the runner for API calls so a stalled body cannot outlive
 * the request deadline.
 */
export async function fetchJsonWithDeadline(input, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") throw new Error("global fetch is not available")
  const { fetchImpl: _ignored, signal: optionSignal, ...deadlineOptions } = options
  return runWithDeadline(
    async (signal) => {
      const response = await fetchImpl(input, { ...init, signal })
      const data = await response.json()
      return { response, data }
    },
    { ...deadlineOptions, signal: optionSignal ?? init.signal, input: String(input) },
  )
}

/**
 * Poll until a predicate is truthy.  Every predicate invocation gets a fresh
 * signal, and the invocation itself is raced against the same absolute
 * deadline as the poll loop.  Predicate failures are retryable (which is
 * useful while the server is still starting); the final timeout retains the
 * most recent failure as `cause` and `lastPredicateError`.
 */
export async function waitForDeadline(
  predicate,
  timeout,
  getLogs = () => "",
  { nativeTimeout = false, intervalMs = 100, now = Date.now, deadline } = {},
) {
  const actualDeadline = deadline ?? deadlineFromTimeout(timeout, now)
  let lastPredicateError

  while (true) {
    const remaining = actualDeadline - now()
    if (remaining <= 0) break
    try {
      const matched = await runWithDeadline(
        (signal) => predicate(signal, actualDeadline),
        {
          deadline: actualDeadline,
          now,
          timeoutMessage: "native smoke predicate timed out",
        },
      )
      if (matched) return
    } catch (error) {
      if (error?.code === "NATIVE_DEADLINE_EXCEEDED") break
      lastPredicateError = error
    }

    const delay = Math.min(Math.max(0, intervalMs), Math.max(0, actualDeadline - now()))
    if (delay <= 0) break
    await new Promise((resolve) => setTimeout(resolve, delay))
  }

  let logText
  try {
    logText = await Promise.resolve().then(getLogs)
  } catch (error) {
    logText = `could not read native smoke logs: ${error?.message ?? String(error)}`
  }
  const error = new Error(`OpenCode native-agent smoke timed out\n${logText ?? ""}`)
  if (nativeTimeout) error.code = "NATIVE_SMOKE_TIMEOUT"
  if (lastPredicateError !== undefined) {
    error.cause = lastPredicateError
    error.lastPredicateError = lastPredicateError
  }
  error.deadline = actualDeadline
  throw error
}

export const waitFor = waitForDeadline

function forwardAbort(source, target) {
  if (!source) return () => {}
  if (source.aborted) {
    target.abort(source.reason)
    return () => {}
  }
  const onAbort = () => target.abort(source.reason)
  source.addEventListener("abort", onAbort, { once: true })
  return () => source.removeEventListener("abort", onAbort)
}
