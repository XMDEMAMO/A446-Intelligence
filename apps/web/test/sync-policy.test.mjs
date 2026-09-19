import assert from 'node:assert/strict'
import test from 'node:test'
import { failedConnectionMode, nextPollDelay, permitsServerMutation } from '../src/sync-policy.js'

test('polling uses a bounded exponential retry schedule', () => {
  assert.equal(nextPollDelay(0), 3_000)
  assert.equal(nextPollDelay(1), 1_000)
  assert.equal(nextPollDelay(2), 2_000)
  assert.equal(nextPollDelay(6), 30_000)
  assert.equal(nextPollDelay(20), 30_000)
})

test('failed refreshes distinguish stale reconnecting data from offline state', () => {
  assert.equal(failedConnectionMode({ hasSnapshot: true, consecutiveFailures: 1, browserOnline: true }), 'reconnecting')
  assert.equal(failedConnectionMode({ hasSnapshot: true, consecutiveFailures: 3, browserOnline: true }), 'offline')
  assert.equal(failedConnectionMode({ hasSnapshot: false, consecutiveFailures: 1, browserOnline: true }), 'offline')
  assert.equal(failedConnectionMode({ hasSnapshot: true, consecutiveFailures: 1, browserOnline: false }), 'offline')
})

test('only a live Hub permits server mutations', () => {
  assert.equal(permitsServerMutation('live'), true)
  for (const state of ['loading', 'reconnecting', 'offline', 'demo']) assert.equal(permitsServerMutation(state), false)
})
