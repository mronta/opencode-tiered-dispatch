import { DispatchError, type ProviderErrorRecord } from "./errors.js"

interface AssistantTextPart {
  type: "text"
  text: string
}

interface AssistantMessage {
  type: "assistant"
  content: readonly ({ type: string } | AssistantTextPart)[]
  error?: ProviderErrorRecord
  retry?: { error?: ProviderErrorRecord }
}

interface IdleMessage {
  type: "idle"
  outcome: "succeeded" | "failed" | "interrupted"
}

interface FailureMessage {
  type: string
  error?: ProviderErrorRecord
  status?: string
  content?: readonly FailureContentPart[]
}

interface FailureContentPart {
  type: string
  state?: { status?: string; error?: ProviderErrorRecord }
}

type ContextMessage = { type: string } | AssistantMessage | IdleMessage | FailureMessage

export function extractFinalText(messages: readonly ContextMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== "assistant") continue
    const assistant = message as AssistantMessage
    const text = assistant.content
      .filter((part): part is AssistantTextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  throw new DispatchError("Delegation completed without assistant text")
}

export function assertSuccessfulOutcome(
  outcome: "succeeded" | "failed" | "interrupted" | undefined,
  messages: readonly ContextMessage[],
): void {
  if (outcome === "succeeded") return
  if (outcome === "interrupted") throw new DOMException("Delegation was interrupted", "AbortError")
  if (outcome === "failed") {
    const providerError = findProviderError(messages)
    if (providerError) throw providerError
    throw new DispatchError("unknown provider error")
  }
  throw new DispatchError("Delegation became idle without a recorded outcome")
}

function findProviderError(messages: readonly ContextMessage[]): ProviderErrorRecord | undefined {
  for (const message of [...messages].reverse()) {
    const failure = message as FailureMessage
    if (failure.error) return failure.error
    if (failure.content) {
      for (const part of [...failure.content].reverse()) {
        if (part.state?.error) return part.state.error
      }
    }
    const assistant = message as AssistantMessage
    if (assistant.retry?.error) return assistant.retry.error
  }
  return undefined
}
