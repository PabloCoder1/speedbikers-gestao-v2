import { spawnSync } from 'node:child_process'

const bucket = 'speedbikers-prod-db-backups'
const minimumSize = 1_048_576

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
  const uri = `gs://${bucket}/${expected.name}`
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
      console.error(JSON.stringify({ status: 'invalid_metadata', object: uri }))
      return 2
    }
  } else {
    console.error(JSON.stringify({ status: 'unavailable', object: uri }))
    return 2
  }

  if (!isValidBackup(metadata, expected, Date.now())) {
    console.error(JSON.stringify({ status: 'invalid_backup', object: uri }))
    return 1
  }

  console.log(JSON.stringify({ status: 'ok', object: uri, bytes: Number(metadata.size) }))
  return 0
}

if (import.meta.main) process.exitCode = run()
