import type { CloudTasksClient } from "@google-cloud/tasks";
import { describe, expect, it, vi } from "vitest";

import { DISPATCH_DEADLINE_SECONDS, createEnqueuer } from "./enqueue.js";
import type { Env } from "./env.js";

const ENV = {
  GCP_PROJECT_ID: "projeto-teste",
  GCP_REGION: "southamerica-east1",
  WORKER_URL: "https://worker.example.test",
  TASKS_INVOKER_SERVICE_ACCOUNT: "tasks@projeto-teste.iam.gserviceaccount.com",
} as unknown as Env;

interface CreateTaskRequest {
  task: { dispatchDeadline?: { seconds: number } };
}

function fakeClient() {
  const createTask = vi.fn<(request: CreateTaskRequest) => Promise<unknown[]>>(() => Promise.resolve([{}]));
  const client = {
    queuePath: (projeto: string, regiao: string, fila: string) => `projects/${projeto}/locations/${regiao}/queues/${fila}`,
    createTask,
  } as unknown as CloudTasksClient;

  return { client, createTask };
}

describe("createEnqueuer", () => {
  it("define o prazo de entrega igual ao timeout do worker, e não o padrão de 10 min", async () => {
    const { client, createTask } = fakeClient();

    await createEnqueuer(ENV, client).enqueue({
      jobType: "sync.orders.window",
      organizationId: "aaaaaaaa-0000-4000-8000-000000000001",
      dedupeKey: "sync.orders.window:conta:2026-09-28",
      queue: "ml-orders",
    });

    expect(DISPATCH_DEADLINE_SECONDS).toBe(900);
    expect(createTask.mock.calls[0]?.[0].task.dispatchDeadline).toEqual({ seconds: 900 });
  });
});
