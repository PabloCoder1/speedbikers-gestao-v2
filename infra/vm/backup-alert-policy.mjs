import { parseArgs } from 'node:util'
import { backupFailure } from './check-daily-backup.mjs'

try {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      region: { type: 'string' },
      job: { type: 'string' },
      'channel-id': { type: 'string' },
    },
  })
  const { project, region, job, 'channel-id': channelId } = values
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project ?? '')) throw new Error('--project inválido')
  if (!/^[a-z]+(?:-[a-z]+)+[0-9]+$/u.test(region ?? '')) throw new Error('--region inválida')
  if (!/^[a-z](?:[a-z0-9-]{0,46}[a-z0-9])?$/u.test(job ?? '')) throw new Error('--job inválido')
  if (!/^[1-9][0-9]{0,19}$/u.test(channelId ?? '')) throw new Error('--channel-id inválido')

  const filter = [
    'resource.type="cloud_run_job"',
    `resource.labels.project_id="${project}"`,
    `resource.labels.location="${region}"`,
    `resource.labels.job_name="${job}"`,
    'log_id("run.googleapis.com/stderr")',
    `jsonPayload.status=(${Object.values(backupFailure).map((status) => JSON.stringify(status)).join(' OR ')})`,
  ].join(' AND ')

  console.log(JSON.stringify({
    displayName: `Backup diário da VM: falha na sondagem (${job})`,
    combiner: 'OR',
    notificationChannels: [`projects/${project}/notificationChannels/${channelId}`],
    documentation: {
      content: 'Conferir o status da sondagem, a geração do objeto no Cloud Storage e o cron de backup da VM.',
      mimeType: 'text/markdown',
    },
    alertStrategy: { notificationRateLimit: { period: '3600s' }, autoClose: '86400s' },
    conditions: [{ displayName: 'Sondagem de backup reprovada', conditionMatchedLog: { filter } }],
  }, null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
