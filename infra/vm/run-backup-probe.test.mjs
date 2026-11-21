import assert from 'node:assert/strict'
import test from 'node:test'
import { runBackupProbe } from './run-backup-probe.mjs'

const now = () => Date.parse('2026-11-20T08:00:00Z')
const auth = () => Response.json({ access_token: 'fixture' })
const fixture = { name: 'diario/2026-11-20.dump', size: '187580692', timeCreated: '2026-11-20T06:15:57Z' }

test('consulta apenas os campos de metadados do dump usando a identidade do job', async () => {
  const request = async (url, options) => {
    if (url.startsWith('http://metadata.google.internal/')) {
      assert.equal(options.headers['Metadata-Flavor'], 'Google')
      return auth()
    }
    assert.equal(url, 'https://storage.googleapis.com/storage/v1/b/speedbikers-prod-db-backups/o/diario%2F2026-11-20.dump?fields=name,size,timeCreated')
    assert.equal(options.headers.Authorization, 'Bearer fixture')
    return Response.json(fixture)
  }
  const result = await runBackupProbe({ request, now })
  assert.deepEqual(result, {
    code: 0,
    entry: { status: 'ok', object: 'gs://speedbikers-prod-db-backups/diario/2026-11-20.dump', bytes: 187580692 },
  })
})

test('mantém o contrato de erro para objeto ausente, JSON inválido e metadados fora da regra', async () => {
  for (const [response, status, code] of [
    [new Response(null, { status: 404 }), 'unavailable', 2],
    [new Response('invalid JSON'), 'invalid_metadata', 2],
    [Response.json({ ...fixture, size: '17' }), 'invalid_backup', 1],
  ]) {
    const request = (url) => url.startsWith('http:') ? auth() : response
    const result = await runBackupProbe({ request, now })
    assert.equal(result.code, code)
    assert.equal(result.entry.status, status)
    assert.equal(result.entry.severity, 'ERROR')
  }
})

test('emite falha sintética sem acessar a rede', async () => {
  const result = await runBackupProbe({ now, simulateFailure: true, request: () => assert.fail() })
  assert.equal(result.code, 2)
  assert.equal(result.entry.status, 'unavailable')
  assert.equal(result.entry.simulated, true)
})
