import type { CloudTasksClient } from "@google-cloud/tasks";
import { describe, expect, it } from "vitest";

import { createEnqueuer } from "./enqueue.js";
import type { Env } from "./env.js";

const ENV = {
  GCP_PROJECT_ID: "proj",
  GCP_REGION: "southamerica-east1",
  WORKER_URL: "https://worker.example.com",
  TASKS_INVOKER_SERVICE_ACCOUNT: "invoker@proj.iam.gserviceaccount.com",
} as unknown as Env;

function makeClient() {
  const created: unknown[] = [];
  const client = {
    queuePath: (p: string, r: string, q: string) => `projects/${p}/locations/${r}/queues/${q}`,
    createTask: (req: unknown) => {
      created.push(req);

      return Promise.resolve([{}]);
    },
  } as unknown as CloudTasksClient;

  return { client, created };
}

const BASE = {
  jobType: "backfill.orders",
  organizationId: "11111111-1111-4111-8111-111111111111",
  dedupeKey: "k-1",
  queue: "backfill",
};

describe("worker enqueue (D-819)", () => {
  it("rejeita delaySeconds negativo, NaN ou Infinity antes de chamar Cloud Tasks", async () => {
    const { client, created } = makeClient();
    const enqueuer = createEnqueuer(ENV, client);

    await expect(enqueuer.enqueue({ ...BASE, delaySeconds: -5 })).rejects.toThrow(RangeError);
    await expect(enqueuer.enqueue({ ...BASE, delaySeconds: Number.NaN })).rejects.toThrow(RangeError);
    await expect(enqueuer.enqueue({ ...BASE, delaySeconds: Number.POSITIVE_INFINITY })).rejects.toThrow(RangeError);
    expect(created).toEqual([]);
  });

  it("trunca delaySeconds fracionário para inteiro seguro em scheduleTime.seconds", async () => {
    const { client, created } = makeClient();
    const enqueuer = createEnqueuer(ENV, client);

    await enqueuer.enqueue({ ...BASE, delaySeconds: 12.9 });

    expect(created).toHaveLength(1);
    const task = (created[0] as { task: { scheduleTime?: { seconds?: number } } }).task;
    expect(Number.isInteger(task.scheduleTime?.seconds)).toBe(true);
  });
});
