import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedBackup, isValidBackup } from './check-daily-backup.mjs'

test('checks the last due backup across the UTC deadline and year boundary', () => {
  assert.equal(expectedBackup(new Date('2027-01-01T07:14:59.999Z')).name, 'diario/2026-12-31.dump')
  assert.equal(expectedBackup(new Date('2027-01-01T07:15:00.000Z')).name, 'diario/2027-01-01.dump')
})

const now = new Date('2026-11-19T07:30:00Z')
const expected = expectedBackup(now)
const metadata = {
  name: expected.name,
  creation_time: '2026-11-19T03:15:54-03:00',
  size: 183_547_863,
}

test('accepts GCS metadata with an explicit timezone and a complete-sized object', () => {
  assert.equal(isValidBackup(metadata, expected, now), true)
})

test('rejects absent, stale, future, misnamed or undersized objects', () => {
  for (const entry of [
    null,
    { ...metadata, creation_time: 'invalid' },
    { ...metadata, creation_time: '2026-11-18T23:59:59Z' },
    { ...metadata, creation_time: '2026-11-19T07:30:01Z' },
    { ...metadata, name: 'diario/2026-11-18.dump' },
    { ...metadata, size: 1_048_576 },
    { ...metadata, size: 'Infinity' },
  ]) {
    assert.equal(isValidBackup(entry, expected, now), false)
  }
})
