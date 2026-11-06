// Background runs. MCP clients may stop waiting for a tool call after about a minute, and cancelling
// a call stops FlexSim. A background run belongs to the server instead of to a call, so it can
// outlast any one call. Runs live in this server process's memory only.
// Author: Motasem Albanna
import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobOutcome {
  payload: Record<string, unknown>;
  failed: boolean;
}

export interface Job {
  id: string;
  label: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  outcome?: JobOutcome;
  cancelRequested: boolean;
  controller: AbortController;
  finished: Promise<void>;
}

/** What a job's work is given, so it can report when it really starts and notice cancellation. */
export interface JobContext {
  signal: AbortSignal;
  onStart: () => void;
}

const MAX_FINISHED_JOBS = 20;

export class JobManager {
  private readonly jobs = new Map<string, Job>();

  start(label: string, work: (ctx: JobContext) => Promise<JobOutcome>): Job {
    const controller = new AbortController();
    const job: Job = {
      id: randomUUID().slice(0, 8),
      label,
      status: "queued",
      createdAt: Date.now(),
      cancelRequested: false,
      controller,
      finished: Promise.resolve(),
    };
    const onStart = () => {
      job.status = "running";
      job.startedAt = Date.now();
    };
    job.finished = Promise.resolve()
      .then(() => work({ signal: controller.signal, onStart }))
      .catch((e: unknown): JobOutcome => ({
        payload: { ok: false, error: `The run failed unexpectedly: ${e instanceof Error ? e.message : String(e)}` },
        failed: true,
      }))
      .then((outcome) => {
        job.outcome = outcome;
        job.finishedAt = Date.now();
        job.status = job.cancelRequested ? "cancelled" : outcome.failed ? "failed" : "succeeded";
        this.prune();
      });
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  /** Runs that haven't finished. */
  unfinished(): Job[] {
    return this.list().filter((j) => !j.finishedAt);
  }

  cancel(job: Job): void {
    if (job.finishedAt) return;
    job.cancelRequested = true;
    job.controller.abort();
  }

  /** Wait until the job finishes, the time is up, or the call itself is cancelled. */
  async wait(job: Job, ms: number, signal?: AbortSignal): Promise<void> {
    if (job.finishedAt || ms <= 0 || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", finish);
      void job.finished.then(finish);
    });
  }

  private prune(): void {
    const finished = this.list().filter((j) => j.finishedAt);
    for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) this.jobs.delete(old.id);
  }
}

/** A job as reported to the client: status first, then the run's own results once it has finished. */
export function describeJob(job: Job, now = Date.now()): Record<string, unknown> {
  const base: Record<string, unknown> = {
    run_id: job.id,
    run: job.label,
    status: job.status,
    elapsed_seconds: Math.round(((job.finishedAt ?? now) - (job.startedAt ?? job.createdAt)) / 1000),
  };
  if (!job.finishedAt) return { ok: true, ...base };
  return { ...job.outcome!.payload, ...base };
}
