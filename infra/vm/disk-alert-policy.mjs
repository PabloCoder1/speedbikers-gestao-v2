import { parseArgs } from "node:util";

try {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      "instance-id": { type: "string" },
      device: { type: "string" },
      "channel-id": { type: "string" },
    },
  });
  const { project, "instance-id": instanceId, device, "channel-id": channelId } = values;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project ?? "")) throw new Error("--project inválido");
  if (!/^[1-9][0-9]{0,19}$/u.test(instanceId ?? "")) throw new Error("--instance-id inválido");
  if (!/^\/dev\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(device ?? "")) throw new Error("--device inválido");
  if (!/^[1-9][0-9]{0,19}$/u.test(channelId ?? "")) throw new Error("--channel-id inválido");

  const filter = [
    'resource.type = "gce_instance"',
    `resource.labels.project_id = "${project}"`,
    `resource.labels.instance_id = "${instanceId}"`,
    'metric.type = "agent.googleapis.com/disk/percent_used"',
    'metric.labels.state = "used"',
    `metric.labels.device = "${device}"`,
  ].join(" AND ");
  const policy = {
    displayName: `sb-db: utilização de disco (${instanceId} ${device})`,
    combiner: "OR",
    notificationChannels: [`projects/${project}/notificationChannels/${channelId}`],
    documentation: {
      content: "Conferir espaço e crescimento em /opt/supabase e no armazenamento Docker da VM.",
      mimeType: "text/markdown",
    },
    conditions: [{
      displayName: "Disco acima de 85% por 10 minutos",
      conditionThreshold: {
        filter,
        aggregations: [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_MAX" }],
        comparison: "COMPARISON_GT",
        thresholdValue: 85,
        duration: "600s",
        evaluationMissingData: "EVALUATION_MISSING_DATA_NO_OP",
      },
    }],
  };
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
