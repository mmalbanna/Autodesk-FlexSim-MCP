// Protocol-level test of the built bundle against test/fake-flexsim.mjs, a stand-in for flexsim.exe.
// It runs in CI because it needs no FlexSim, but it proves nothing about FlexSim itself: use
// test/integration.mjs for that. Linux and macOS only, since Windows cannot spawn a script as an exe.
import { strict as assert } from "node:assert";
import { chmodSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (process.platform === "win32") {
  console.error("Smoke test skipped on Windows: run it in CI, or use npm run test:flexsim here.");
  process.exit(0);
}
chmodSync("test/fake-flexsim.mjs", 0o755);

const LOG = "/tmp/fake-flexsim.log"; rmSync(LOG, { force: true });
function assertLastRunStopped() {
  const pid = Number([...readFileSync(LOG, "utf8").matchAll(/^PID (\d+)$/gm)].at(-1)[1]);
  assert.throws(() => process.kill(pid, 0), "the FlexSim process must be gone");
}
const MODEL = "/tmp/Test Line.fsm"; writeFileSync(MODEL, "x");
async function connect(mode) {
  const c = new Client({ name: "smoke", version: "1.0.0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["bundle/server/index.mjs"],
    env: { ...getDefaultEnvironment(), FLEXSIM_EXE: process.cwd() + "/test/fake-flexsim.mjs", FAKE_LOG: LOG, FAKE_MODE: mode, FLEXSIM_TIMEOUT_SECONDS: "30" } }));
  return c;
}
let c = await connect("ok");
const { tools } = await c.listTools();
assert.deepEqual(tools.map(t => t.name).sort(), ["flexsim_cancel_run","flexsim_check_installation","flexsim_get_run","flexsim_list_models","flexsim_open_in_gui","flexsim_read_table","flexsim_run_model","flexsim_run_script","flexsim_start_run"]);
let r = await c.callTool({ name: "flexsim_check_installation", arguments: { smoke_test: true } });
assert.ok(!r.isError, JSON.stringify(r.content)); assert.equal(r.structuredContent.smoke_test, "passed");
r = await c.callTool({ name: "flexsim_run_model", arguments: { model_path: MODEL, run_time: 28800, parameters: { NumOperators: 4, Shift: "A \"day\"" }, results_script: 'return "x\\ny";' } });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(r.structuredContent.run_end_time, 28800); assert.deepEqual(r.structuredContent.performance_measures, { Throughput: 123 });
assert.equal(r.structuredContent.warning, undefined);
r = await c.callTool({ name: "flexsim_read_table", arguments: { model_path: MODEL, table_name: "Schedule" } });
assert.ok(!r.isError); assert.deepEqual(r.structuredContent.table.rows, [[5]]);
r = await c.callTool({ name: "flexsim_list_models", arguments: { folder: "/tmp" } });
assert.ok(r.structuredContent.models.some(m => m.path === MODEL));
r = await c.callTool({ name: "flexsim_run_model", arguments: { model_path: "/tmp/missing.fsm", run_time: 10 } });
assert.equal(r.isError, true);
writeFileSync("/tmp/x.txt", "x");
r = await c.callTool({ name: "flexsim_run_model", arguments: { model_path: "/tmp/x.txt", run_time: 10 } });
assert.equal(r.isError, true, "non-.fsm must be rejected");
assert.match(r.content[0].text, /\.fsm/);
r = await c.callTool({ name: "flexsim_list_models", arguments: { folder: "/tmp/x.txt" } });
assert.equal(r.isError, true, "a file is not a folder");
r = await c.callTool({ name: "flexsim_run_script", arguments: { script: "does not compile" } });
assert.equal(r.isError, true, "a script that does not compile must be an error");
assert.match(r.structuredContent.error, /could not compile your script/);
assert.equal(r.structuredContent.result, null);
// Background runs: start returns at once, get collects the same results as a direct run.
r = await c.callTool({ name: "flexsim_start_run", arguments: { model_path: MODEL, run_time: 28800 } });
assert.ok(!r.isError, JSON.stringify(r.content));
const runId = r.structuredContent.run_id;
r = await c.callTool({ name: "flexsim_get_run", arguments: { run_id: runId, wait_seconds: 20 } });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(r.structuredContent.status, "succeeded");
assert.equal(r.structuredContent.run_end_time, 28800);
assert.deepEqual(r.structuredContent.performance_measures, { Throughput: 123 });
r = await c.callTool({ name: "flexsim_get_run", arguments: {} });
assert.ok(r.structuredContent.runs.some((x) => x.run_id === runId));
r = await c.callTool({ name: "flexsim_get_run", arguments: { run_id: "nosuchid" } });
assert.equal(r.isError, true);
await c.close();

// A cancelled background run stops FlexSim. While one is going, direct calls are told so at once.
c = await connect("hang");
r = await c.callTool({ name: "flexsim_start_run", arguments: { model_path: MODEL, run_time: 10 } });
const hanging = r.structuredContent.run_id;
await new Promise((resolve) => setTimeout(resolve, 2000));
r = await c.callTool({ name: "flexsim_get_run", arguments: { run_id: hanging, wait_seconds: 0 } });
assert.equal(r.structuredContent.status, "running");
r = await c.callTool({ name: "flexsim_run_script", arguments: { script: "return 1;" } });
assert.equal(r.isError, true);
assert.match(r.structuredContent.error, /Background run/);
r = await c.callTool({ name: "flexsim_cancel_run", arguments: { run_id: hanging } });
assert.equal(r.structuredContent.status, "cancelled");
assertLastRunStopped();
await c.close();

// Closing the connection during a background run stops FlexSim too.
c = await connect("hang");
await c.callTool({ name: "flexsim_start_run", arguments: { model_path: MODEL, run_time: 10 } });
await new Promise((resolve) => setTimeout(resolve, 2000));
await c.close();
await new Promise((resolve) => setTimeout(resolve, 1000));
assertLastRunStopped();

c = await connect("crash");
r = await c.callTool({ name: "flexsim_run_script", arguments: { script: "return 1;" } });
assert.equal(r.isError, true); assert.match(r.structuredContent.error, /without writing results/);
await c.close();

c = await connect("hang");
let t0 = Date.now();
r = await c.callTool({ name: "flexsim_run_script", arguments: { script: "return 1;", timeout_seconds: 10 } });
assert.equal(r.isError, true); assert.match(r.structuredContent.error, /did not finish within 10 s/);
assert.ok(Date.now() - t0 < 14000);
assertLastRunStopped();
await c.close();

c = await connect("linger");
t0 = Date.now();
r = await c.callTool({ name: "flexsim_run_script", arguments: { script: "return 1 + 1;", timeout_seconds: 60 } });
assert.ok(!r.isError); assert.equal(r.structuredContent.result, 2); assert.ok(Date.now() - t0 < 25000);
assertLastRunStopped();
await c.close();

const log = readFileSync(LOG, "utf8");
const steps = [...log.matchAll(/executestring\((".*")\);/g)].map(x => JSON.parse(x[1]));
assert.ok(steps.some(c => c.includes('Model.parameters["Shift"].value = "A \\"day\\"";')), "string param escaping");
console.error("Smoke test passed");
