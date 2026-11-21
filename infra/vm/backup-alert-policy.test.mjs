import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./backup-alert-policy.mjs', import.meta.url))
const params = { project: 'speedbikers-test', region: 'southamerica-east1', job: 'backup-check', 'channel-id': '42' }
const run = (overrides) => spawnSync(process.execPath, [
  script, ...Object.entries({ ...params, ...overrides }).flatMap(([name, value]) => [`--${name}`, value]),
], { encoding: 'utf8' })

test('restringe o alerta à saída de erro da sondagem no projeto e região informados', () => {
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  const policy = JSON.parse(result.stdout)
  assert.deepEqual(policy.notificationChannels, ['projects/speedbikers-test/notificationChannels/42'])
  assert.equal(policy.conditions[0].conditionMatchedLog.filter, [
    'resource.type="cloud_run_job"',
    'resource.labels.project_id="speedbikers-test"',
    'resource.labels.location="southamerica-east1"',
    'resource.labels.job_name="backup-check"',
    'log_id("run.googleapis.com/stderr")',
    'jsonPayload.status=("invalid_backup" OR "invalid_metadata" OR "unavailable")',
  ].join(' AND '))
  assert.equal(policy.alertStrategy.notificationRateLimit.period, '3600s')
})

test('recusa job ausente ou ambíguo, região inválida e canal de outro projeto', () => {
  for (const invalid of [
    { job: '' },
    { job: 'backup" OR "' },
    { region: 'southamerica-east' },
    { 'channel-id': 'projects/other/notificationChannels/42' },
  ]) {
    const result = run(invalid)
    assert.equal(result.status, 2, result.stderr)
    assert.equal(result.stdout, '')
  }
})
