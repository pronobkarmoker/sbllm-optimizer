/** Thrown (or recognized) when the user cancels a run. */
export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

/** True for any of the shapes a cancellation arrives in: our own CancelledError, a DOMException
 *  from fetch/Gemini, Ollama's AbortError — or any error at all once the signal has fired. */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
