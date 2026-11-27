import { backupBucket, backupFailure, expectedBackup, isValidBackup } from './check-daily-backup.mjs'

const tokenUrl = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'

export async function runBackupProbe({ request = fetch, now = Date.now, simulateFailure = false } = {}) {
  const expected = expectedBackup(new Date(now()))
  const object = `gs://${backupBucket}/${expected.name}`
  const fail = (status, code, fields) => ({
    code, entry: { severity: 'ERROR', status, object, ...fields },
  })

  if (simulateFailure) return fail(backupFailure.unavailable, 2, { simulated: true })

  let response
  try {
    const auth = await request(tokenUrl, {
      headers: { 'Metadata-Flavor': 'Google' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!auth.ok) return fail(backupFailure.unavailable, 2, { source: 'identity', httpStatus: auth.status })
    const { access_token: accessToken } = await auth.json()
    if (typeof accessToken !== 'string' || !accessToken) return fail(backupFailure.unavailable, 2, { source: 'identity' })

    const url = `https://storage.googleapis.com/storage/v1/b/${backupBucket}/o/${encodeURIComponent(expected.name)}?fields=name,size,timeCreated`
    response = await request(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return fail(backupFailure.unavailable, 2, { source: 'storage', httpStatus: response.status })
  } catch {
    return fail(backupFailure.unavailable, 2, { source: 'request' })
  }

  let metadata
  try {
    metadata = await response.json()
  } catch {
    return fail(backupFailure.invalidMetadata, 2)
  }
  const backup = { name: metadata?.name, size: metadata?.size, creation_time: metadata?.timeCreated }
  if (!isValidBackup(backup, expected, now())) return fail(backupFailure.invalidBackup, 1)
  return { code: 0, entry: { status: 'ok', object, bytes: Number(backup.size) } }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 1 || args[0] !== '--test-failure')) {
    console.error('Argumento inválido para a sondagem')
    process.exitCode = 2
  } else {
    const { code, entry } = await runBackupProbe({ simulateFailure: args.length === 1 })
    const log = code === 0 ? console.log : console.error
    log(JSON.stringify(entry))
    process.exitCode = code
  }
}
