import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./disk-alert-policy.mjs", import.meta.url));
const args = {
  project: "speedbikers-test",
  "instance-id": "12345678901234567890",
  device: "/dev/sda1",
  "channel-id": "42",
};
const generate = (inputs) => spawnSync(process.execPath, [
  script,
  ...Object.entries(inputs).flatMap(([key, value]) => [`--${key}`, value]),
], { encoding: "utf8" });

test("gera política para uma VM e um dispositivo usando a porcentagem ocupada", () => {
  const run = generate(args);
  assert.equal(run.status, 0, run.stderr);
  const policy = JSON.parse(run.stdout);
  assert.deepEqual(policy.notificationChannels, ["projects/speedbikers-test/notificationChannels/42"]);
  const [{ conditionThreshold: threshold }] = policy.conditions;
  assert.equal(threshold.filter, [
    'resource.type = "gce_instance"',
    'resource.labels.project_id = "speedbikers-test"',
    'resource.labels.instance_id = "12345678901234567890"',
    'metric.type = "agent.googleapis.com/disk/percent_used"',
    'metric.labels.state = "used"',
    'metric.labels.device = "/dev/sda1"',
  ].join(" AND "));
  assert.equal(threshold.thresholdValue, 85);
  assert.equal(threshold.duration, "600s");
  assert.equal(threshold.evaluationMissingData, "EVALUATION_MISSING_DATA_NO_OP");
});

test("recusa destino ausente, filtro ambíguo e canal de outro projeto", () => {
  for (const invalid of [
    { "instance-id": "" },
    { project: "" },
    { device: '/dev/sda1" OR "x' },
    { device: "/dev/../sda1" },
    { "channel-id": "projects/outro/notificationChannels/42" },
  ]) {
    const run = generate({ ...args, ...invalid });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, "");
  }
});
