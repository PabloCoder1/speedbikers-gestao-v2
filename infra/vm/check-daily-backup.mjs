import { spawnSync } from 'node:child_process'

export const backupBucket = 'speedbikers-prod-db-backups'
const minimumSize = 1_048_576
export const backupFailure = Object.freeze({
  invalidBackup: 'invalid_backup',
  invalidMetadata: 'invalid_metadata',
  unavailable: 'unavailable',
})

export function expectedBackup(now) {
  // The dump starts at 06:15 UTC. Allow one hour for dump, validation and upload.
  const dueDate = new Date(now)
  if (dueDate.getUTCHours() * 60 + dueDate.getUTCMinutes() < 7 * 60 + 15) {
    dueDate.setUTCDate(dueDate.getUTCDate() - 1)
  }
  const day = dueDate.toISOString().slice(0, 10)
  return { name: `diario/${day}.dump`, dayStart: Date.parse(`${day}T00:00:00Z`) }
}

export function isValidBackup(metadata, expected, now) {
  const createdAt = Date.parse(metadata?.creation_time)
  const size = Number(metadata?.size)
  return metadata?.name === expected.name &&
    Number.isSafeInteger(size) && size > minimumSize &&
    createdAt >= expected.dayStart && createdAt <= now
}

function run() {
  const expected = expectedBackup(new Date())
  const uri = `gs://${backupBucket}/${expected.name}`
  const args = ['storage', 'objects', 'describe', uri, '--project=speedbikers-prod', '--quiet', '--format=json']
  const options = { encoding: 'utf8', timeout: 30_000 }

  // Windows installs gcloud as a batch file. All command arguments are fixed
  // literals or derived from an ISO date.
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', 'gcloud.cmd', ...args], options)
    : spawnSync('gcloud', args, options)

  let metadata
  if (result.status === 0) {
    try {
      metadata = JSON.parse(result.stdout)
    } catch {
      reportFailure(backupFailure.invalidMetadata, uri)
      return 2
    }
  } else {
    reportFailure(backupFailure.unavailable, uri)
    return 2
  }

  if (!isValidBackup(metadata, expected, Date.now())) {
    reportFailure(backupFailure.invalidBackup, uri)
    return 1
  }

  console.log(JSON.stringify({ status: 'ok', object: uri, bytes: Number(metadata.size) }))
  return 0
}

function reportFailure(status, object) {
  console.error(JSON.stringify({ severity: 'ERROR', status, object }))
}

if (import.meta.main) process.exitCode = run()
