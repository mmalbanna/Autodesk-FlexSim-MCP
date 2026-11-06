// Background run bookkeeping, with no FlexSim involved. Run with: npm test
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { describeJob, JobManager } from "../src/jobs.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const success = { payload: { ok: true, results: 7 }, failed: false };

test("a job goes from queued to running to succeeded, and keeps its results", async () => {
  const jobs = new JobManager();
  let release;
  const gate = new Promise((r) => (release = r));
  let started;
  const job = jobs.start("line", async ({ onStart }) => {
    started = onStart;
    await gate;
    return success;
  });
  assert.equal(job.status, "queued");
  await sleep(1);
  started();
  assert.equal(job.status, "running");
  assert.equal(jobs.unfinished().length, 1);
  release();
  await job.finished;
  assert.equal(job.status, "succeeded");
  assert.equal(jobs.unfinished().length, 0);
  const d = describeJob(job);
  assert.equal(d.status, "succeeded");
  assert.equal(d.results, 7);
  assert.equal(d.ok, true);
});

test("a failed outcome is reported as failed, keeping its error", async () => {
  const jobs = new JobManager();
  const job = jobs.start("x", async () => ({ payload: { ok: false, error: "boom" }, failed: true }));
  await job.finished;
  assert.equal(job.status, "failed");
  assert.equal(describeJob(job).error, "boom");
});

test("work that throws becomes a failed job rather than an unhandled rejection", async () => {
  const jobs = new JobManager();
  const job = jobs.start("x", async () => {
    throw new Error("kaput");
  });
  await job.finished;
  assert.equal(job.status, "failed");
  assert.match(describeJob(job).error, /kaput/);
});

test("cancel signals the work and the job ends as cancelled", async () => {
  const jobs = new JobManager();
  const job = jobs.start("x", ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ payload: { ok: false, error: "stopped" }, failed: true }));
  }));
  await sleep(1);
  jobs.cancel(job);
  await job.finished;
  assert.equal(job.status, "cancelled");
});

test("cancelling a finished job changes nothing", async () => {
  const jobs = new JobManager();
  const job = jobs.start("x", async () => success);
  await job.finished;
  jobs.cancel(job);
  assert.equal(job.status, "succeeded");
});

test("wait returns early when the job finishes, and on time otherwise", async () => {
  const jobs = new JobManager();
  const quick = jobs.start("x", async () => success);
  let t0 = Date.now();
  await jobs.wait(quick, 5000);
  assert.ok(Date.now() - t0 < 1000);

  const never = jobs.start("y", () => new Promise(() => {}));
  t0 = Date.now();
  await jobs.wait(never, 50);
  assert.equal(never.status, "queued");
  assert.ok(Date.now() - t0 < 1000);
});

test("wait stops when the call itself is cancelled, leaving the job alone", async () => {
  const jobs = new JobManager();
  const never = jobs.start("y", () => new Promise(() => {}));
  const c = new AbortController();
  setTimeout(() => c.abort(), 10);
  const t0 = Date.now();
  await jobs.wait(never, 5000, c.signal);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(never.cancelRequested, false);
});

test("only recent finished jobs are kept, and unfinished ones never go", async () => {
  const jobs = new JobManager();
  const running = jobs.start("keep", () => new Promise(() => {}));
  for (let i = 0; i < 30; i++) await jobs.start(`j${i}`, async () => success).finished;
  assert.equal(jobs.list().length, 21);
  assert.ok(jobs.get(running.id));
});
