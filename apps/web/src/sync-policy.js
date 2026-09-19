export const NORMAL_POLL_MS = 3_000
export const MAX_POLL_MS = 30_000

/**
 * @param {number} consecutiveFailures
 */
export function nextPollDelay(consecutiveFailures) {
  if (consecutiveFailures <= 0) return NORMAL_POLL_MS
  return Math.min(MAX_POLL_MS, 1_000 * (2 ** Math.min(consecutiveFailures - 1, 5)))
}

/**
 * @param {{ hasSnapshot: boolean, consecutiveFailures: number, browserOnline: boolean }} input
 * @returns {'reconnecting' | 'offline'}
 */
export function failedConnectionMode({ hasSnapshot, consecutiveFailures, browserOnline }) {
  if (!browserOnline || !hasSnapshot || consecutiveFailures >= 3) return 'offline'
  return 'reconnecting'
}

/**
 * @param {'loading' | 'live' | 'reconnecting' | 'offline' | 'demo'} mode
 */
export function permitsServerMutation(mode) {
  return mode === 'live'
}
