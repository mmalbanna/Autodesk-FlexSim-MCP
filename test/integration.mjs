// End-to-end test against a REAL FlexSim install, through the built bundle and a real MCP client.
// Not run in CI, because hosted runners have no FlexSim or licence. Run it before every release:
//
//   npm run build
//   npm run test:flexsim -- "C:\path\to\any-model.fsm"          (add --gui to also open a window)
//
// Any model works, though one with a Global Table and a Sink covers more; FlexSim's Statistics
// Collector tutorial model has both. It is copied to a temp folder first, so your file is never
// opened directly. The temp folder name deliberately contains a space and a hyphen, because
// FlexSim's command-line parser is sensitive to both. The server runs with the trimmed environment
// many MCP hosts use, with ProgramData and ALLUSERSPROFILE removed as well, because their absence
// crashes FlexSim unless the server restores them.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const source = process.argv[2];
const openGui = process.argv.includes("--gui");
if (!source || source.startsWith("--")) {
  console.error('Usage: npm run test:flexsim -- "C:\\path\\to\\model.fsm" [--gui]');
  process.exit(2);
}

// getDefaultEnvironment() copies PROGRAMDATA from this process, so it has to be removed here.
delete process.env.ProgramData;
delete process.env.ALLUSERSPROFILE;

const root = mkdtempSync(join(tmpdir(), "flexsim mcp-test "));
const modelDir = join(root, "models-dir");
const workDir = join(root, "work dir-1");
mkdirSync(modelDir);
mkdirSync(workDir);
const model = join(modelDir, "line-1.fsm");
// savemodelwithpermissions adds ".locked" to the name it is given.
const fixture = join(modelDir, "fixture-1.locked.fsm");
copyFileSync(source, model);
const hash = () => createHash("sha256").update(readFileSync(model)).digest("hex");
const before = hash();

async function connect(extraEnv = {}) {
  const client = new Client({ name: "flexsim-integration-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["bundle/server/index.mjs"],
      // Set FLEXSIM_EXE to test a FlexSim version other than the newest installed one.
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.FLEXSIM_EXE ? { FLEXSIM_EXE: process.env.FLEXSIM_EXE } : {}),
        ...extraEnv,
      },
    }),
  );
  return client;
}

class Skip extends Error {}
let failures = 0;
let skipped = 0;
async function step(name, fn) {
  const t0 = Date.now();
  const took = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  try {
    const note = await fn();
    console.log(`PASS  ${name} (${took()})${note ? `  ${note}` : ""}`);
  } catch (e) {
    if (e instanceof Skip) {
      skipped++;
      console.log(`SKIP  ${name}: ${e.message}`);
      return;
    }
    failures++;
    console.log(`FAIL  ${name} (${took()})\n      ${String(e.message).split("\n").join("\n      ")}`);
  }
}
const ok = (r) => {
  assert.ok(!r.isError, JSON.stringify(r.structuredContent ?? r.content).slice(0, 1500));
  return r.structuredContent;
};
const headlessRuns = () =>
  Number(
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process -Filter \"Name='flexsim.exe'\" | Where-Object { $_.CommandLine -match '/maintenance' }).Count"],
      { encoding: "utf8" },
    ).trim(),
  );

const c = await connect();
const call = (name, args = {}, options = { timeout: 300000 }) => c.callTool({ name, arguments: args }, options);

await step("lists all the tools, with honest annotations", async () => {
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "flexsim_cancel_run", "flexsim_check_installation", "flexsim_get_run", "flexsim_list_models",
    "flexsim_open_in_gui", "flexsim_read_table", "flexsim_run_model", "flexsim_run_script", "flexsim_start_run",
  ]);
  const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  for (const name of ["flexsim_run_model", "flexsim_run_script"]) assert.equal(hints[name].destructiveHint, true, name);
  for (const name of ["flexsim_run_model", "flexsim_run_script", "flexsim_read_table", "flexsim_open_in_gui"]) {
    assert.equal(hints[name].readOnlyHint, false, name);
  }
});

await step("check_installation smoke test, no model", async () => {
  const s = ok(await call("flexsim_check_installation", { smoke_test: true }));
  assert.equal(s.smoke_test, "passed");
  return `using ${s.exe_in_use}`;
});

await step("run_script, no model", async () => {
  assert.equal(ok(await call("flexsim_run_script", { script: "return 6 * 7;" })).result, 42);
});

await step("run_script returns print() output, without start-up noise", async () => {
  const s = ok(await call("flexsim_run_script", { script: 'print("hello console"); return 1;' }));
  assert.equal(s.flexsim_output, "hello console");
});

await step("run_script reports a script that does not compile as an error, not as 0", async () => {
  const r = await call("flexsim_run_script", { script: "this is not flexscript;", timeout_seconds: 90 });
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent).slice(0, 400));
  assert.match(r.structuredContent.error, /could not compile your script/);
  assert.equal(r.structuredContent.result, null);
});

await step("run_script reports a script legitimately returning 0 as a success", async () => {
  assert.equal(ok(await call("flexsim_run_script", { script: "return 0;" })).result, 0);
});

await step("run_script with no return statement gives 0, as documented", async () => {
  assert.equal(ok(await call("flexsim_run_script", { script: 'print("x");' })).result, 0);
});

await step("run_script treats clearing the console as a normal script", async () => {
  assert.equal(ok(await call("flexsim_run_script", { script: "clearconsole(); return 7;" })).result, 7);
});

await step("run_script reports a FlexScript exception as an error and does not hang", async () => {
  const r = await call("flexsim_run_script", { script: 'Model.parameters["NoSuchXyz"].value = 1; return 1;', timeout_seconds: 90 });
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent).slice(0, 400));
  assert.match(r.structuredContent.error, /exception/i);
});

await step("the server stops FlexSim at its time limit", async () => {
  const r = await call("flexsim_run_script", { script: "while (1) { }", timeout_seconds: 15 });
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent).slice(0, 400));
  assert.match(r.structuredContent.error, /did not finish within 15 s and was stopped/);
  assert.equal(headlessRuns(), 0, "FlexSim is still running");
});

await step("the next run works after FlexSim was force-stopped", async () => {
  assert.equal(ok(await call("flexsim_run_script", { script: "return 8;" })).result, 8);
});

await step("the server stops FlexSim at its time limit, again", async () => {
  const r = await call("flexsim_run_script", { script: "while (1) { }", timeout_seconds: 15 });
  assert.equal(r.isError, true);
});

await step("cancelling a call stops FlexSim", async () => {
  const controller = new AbortController();
  const pending = c.callTool(
    { name: "flexsim_run_script", arguments: { script: "while (1) { }", timeout_seconds: 120 } },
    { signal: controller.signal, timeout: 300000 },
  );
  setTimeout(() => controller.abort(), 8000);
  await assert.rejects(pending);
  await new Promise((resolve) => setTimeout(resolve, 12000));
  assert.equal(headlessRuns(), 0, "FlexSim is still running");
  // The server must still work afterwards.
  assert.equal(ok(await call("flexsim_run_script", { script: "return 5;" })).result, 5);
});

let tableName;
let hasSink = false;
await step("run_script against a model: the documented object listing works", async () => {
  const s = ok(await call("flexsim_run_script", {
    model_path: model,
    script: [
      "Map m;",
      "Array names = []; treenode root = model();",
      "for (int i = 1; i <= root.subnodes.length; i++) names.push(root.subnodes[i].name);",
      'm["objects"] = names;',
      'Array tables = []; treenode gt = Model.find("Tools/GlobalTables");',
      "if (gt) for (int i = 1; i <= gt.subnodes.length; i++) tables.push(gt.subnodes[i].name);",
      'm["tables"] = tables;',
      "return m;",
    ].join("\n"),
  }));
  assert.ok(s.result.objects.includes("Tools"), JSON.stringify(s.result));
  tableName = s.result.tables?.[0];
  hasSink = s.result.objects.includes("SystemExit");
  return `${s.result.objects.length} objects, tables: ${JSON.stringify(s.result.tables)}`;
});

await step("output has no model-load noise", async () => {
  const s = ok(await call("flexsim_run_script", { model_path: model, script: 'print("only this"); return 1;' }));
  assert.equal(s.flexsim_output, "only this");
});

await step("run_model runs to the stop time", async () => {
  const s = ok(await call("flexsim_run_model", { model_path: model, run_time: 1000 }));
  assert.equal(s.warning, undefined, s.warning);
  assert.ok(Math.abs(Number(s.model_time) - 1000) < 1, `model_time was ${s.model_time}`);
  return `model_time ${s.model_time}`;
});

await step("run_model returns results_script output", async () => {
  const s = ok(await call("flexsim_run_model", {
    model_path: model, run_time: 500, include_performance_measures: false,
    results_script: "return Model.time * 2;",
  }));
  assert.ok(Math.abs(Number(s.results) - 1000) < 2, JSON.stringify(s));
});

await step("the documented results_script form reads a Sink's statistics", async () => {
  if (!hasSink) throw new Skip("this model has no object named SystemExit");
  const s = ok(await call("flexsim_run_model", {
    model_path: model, run_time: 5000, include_performance_measures: false,
    results_script: 'Object s = Model.find("SystemExit"); return s.stats.input.value;',
  }));
  assert.equal(typeof s.results, "number", JSON.stringify(s).slice(0, 400));
  return `SystemExit input after a run: ${s.results}`;
});

await step("run_model runs setup_script between the reset and the run", async () => {
  const s = ok(await call("flexsim_run_model", {
    model_path: model, run_time: 100, include_performance_measures: false,
    setup_script: 'Model.find("Tools").subnodes.assert("mcptest").value = 42; return Model.time;',
    results_script: 'return Model.find("Tools/mcptest").value;',
  }));
  assert.equal(s.setup_result, 0, "setup should run at time 0");
  assert.equal(s.results, 42);
});

await step("run_model fails when setup_script raises an exception", async () => {
  const r = await call("flexsim_run_model", {
    model_path: model, run_time: 100, include_performance_measures: false,
    setup_script: 'Model.parameters["NoSuchXyz"].value = 1; return 1;',
  });
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent).slice(0, 400));
  assert.match(r.structuredContent.error, /setup_script raised an exception/);
});

await step("read_table returns headers and rows", async () => {
  if (!tableName) throw new Skip("this model has no Global Tables");
  const s = ok(await call("flexsim_read_table", { model_path: model, table_name: tableName, max_rows: 5 }));
  assert.ok(s.table.columns.length > 0, JSON.stringify(s.table));
  assert.equal(s.table.rows.length, Math.min(5, s.table.num_rows));
  return `"${tableName}": ${s.table.columns.length} columns, ${s.table.num_rows} rows`;
});

await step("read_table reports a missing table as an error", async () => {
  const r = await call("flexsim_read_table", { model_path: model, table_name: "NoSuchTableXyz" });
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent).slice(0, 400));
  assert.match(r.structuredContent.error, /NoSuchTableXyz. was not found/);
});

// New FlexSim sessions start with a parameter "Parameter1" (range 1 to 10) and one performance
// measure, so saving one gives a fixture for testing what-if behaviour without shipping a model.
await step("builds a fixture model with a parameter and a performance measure", async () => {
  const s = ok(await call("flexsim_run_script", {
    script: `applicationcommand("savemodelwithpermissions", ${JSON.stringify(join(modelDir, "fixture-1.fsm").replace(/\\/g, "/"))}); return Model.parameters["Parameter1"] ? 1 : 0;`,
  }));
  assert.equal(s.result, 1);
  assert.ok(existsSync(fixture), "fixture was not saved");
});

await step("run_model applies a what-if parameter, and it survives the reset", async () => {
  const s = ok(await call("flexsim_run_model", {
    model_path: fixture, run_time: 100, parameters: { Parameter1: 3 },
    results_script: "return Model.parameters.Parameter1;",
  }));
  assert.equal(s.parameters_applied, "ok");
  assert.equal(Number(s.results), 3, JSON.stringify(s));
  return `Parameter1 read back as ${s.results}`;
});

await step("run_model accepts a boolean parameter value", async () => {
  const s = ok(await call("flexsim_run_model", {
    model_path: fixture, run_time: 100, include_performance_measures: false, parameters: { Parameter1: true },
    results_script: "return Model.parameters.Parameter1;",
  }));
  assert.equal(Number(s.results), 1, JSON.stringify(s));
});

await step("run_model collects performance measures", async () => {
  const s = ok(await call("flexsim_run_model", { model_path: fixture, run_time: 100 }));
  assert.ok(Object.keys(s.performance_measures ?? {}).length > 0, JSON.stringify(s).slice(0, 500));
  return JSON.stringify(s.performance_measures).slice(0, 90);
});

await step("run_model fails loudly on an unknown parameter and names it", async () => {
  const r = await call("flexsim_run_model", {
    model_path: fixture, run_time: 10, include_performance_measures: false,
    parameters: { Parameter1: 3, NoSuchParameterXyz: 1 },
  });
  const s = r.structuredContent;
  assert.equal(r.isError, true, JSON.stringify(s).slice(0, 400));
  assert.equal(s.ok, false);
  assert.match(s.error, /NoSuchParameterXyz/);
  assert.doesNotMatch(s.error, /Parameter1/);
});

await step("run_model fails loudly when FlexSim substitutes an out-of-range value", async () => {
  const r = await call("flexsim_run_model", {
    model_path: fixture, run_time: 10, include_performance_measures: false,
    parameters: { Parameter1: 1000000000 },
  });
  const s = r.structuredContent;
  assert.equal(r.isError, true, JSON.stringify(s).slice(0, 400));
  assert.match(s.error, /do NOT reflect.*Unable to set Parameter1/s);
});

await step("a very large number reaches FlexScript in a form it accepts", async () => {
  // JavaScript writes this as 1e+21, which FlexScript refuses to compile. It should get as far as
  // FlexSim rejecting the value for being out of range, rather than failing to compile.
  const r = await call("flexsim_run_model", {
    model_path: fixture, run_time: 10, include_performance_measures: false,
    parameters: { Parameter1: 1e21 },
  });
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent).slice(0, 400));
  assert.doesNotMatch(r.structuredContent.error, /could not compile/);
});

await step("run_model fails loudly when a text value doesn't fit the parameter", async () => {
  const r = await call("flexsim_run_model", {
    model_path: fixture, run_time: 10, include_performance_measures: false,
    parameters: { Parameter1: 'a "quoted" value' },
  });
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent).slice(0, 400));
  assert.match(r.structuredContent.error, /Unable to set Parameter1/);
});

// Every call in these steps uses the client library's default 60-second limit, like a real app.
const pollRun = async (runId, label) => {
  for (let i = 0; i < 12; i++) {
    const r = await c.callTool({ name: "flexsim_get_run", arguments: { run_id: runId, wait_seconds: 30 } });
    if (!["queued", "running"].includes(r.structuredContent.status)) return r;
  }
  throw new Error(`${label} did not finish`);
};

await step("a background run returns at once and delivers the same results", async () => {
  const t0 = Date.now();
  const started = ok(await c.callTool({ name: "flexsim_start_run", arguments: { model_path: fixture, run_time: 100, parameters: { Parameter1: 4 }, results_script: "return Model.parameters.Parameter1;" } }));
  assert.ok(Date.now() - t0 < 3000, "start should not wait for FlexSim");
  const s = ok(await pollRun(started.run_id, "the run"));
  assert.equal(s.status, "succeeded");
  assert.equal(Number(s.results), 4);
  assert.ok(Object.keys(s.performance_measures ?? {}).length > 0);
});

await step("a background run outlasts the 60-second limit on a single call", async () => {
  // The server stops this run at 75 s. Reaching that message proves it outlived every limit on a call.
  const started = ok(await c.callTool({ name: "flexsim_start_run", arguments: { model_path: fixture, run_time: 100, setup_script: "while (1) { }", timeout_seconds: 75 } }));
  const r = await pollRun(started.run_id, "the run");
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.status, "failed");
  assert.match(r.structuredContent.error, /did not finish within 75 s/);
  assert.equal(headlessRuns(), 0, "FlexSim is still running");
  return `ended after ${r.structuredContent.elapsed_seconds} s`;
});

await step("a background run reports a bad parameter", async () => {
  const started = ok(await c.callTool({ name: "flexsim_start_run", arguments: { model_path: fixture, run_time: 10, include_performance_measures: false, parameters: { NoSuchParameterXyz: 1 } } }));
  const r = await pollRun(started.run_id, "the run");
  assert.equal(r.isError, true);
  assert.match(r.structuredContent.error, /NoSuchParameterXyz/);
});

await step("direct calls are refused at once during a background run, and cancel stops it", async () => {
  const started = ok(await c.callTool({ name: "flexsim_start_run", arguments: { model_path: fixture, run_time: 100, setup_script: "while (1) { }", timeout_seconds: 300 } }));
  const t0 = Date.now();
  const busy = await c.callTool({ name: "flexsim_run_script", arguments: { script: "return 1;" } });
  assert.equal(busy.isError, true);
  assert.match(busy.structuredContent.error, /Background run/);
  assert.ok(Date.now() - t0 < 3000);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  assert.equal(headlessRuns(), 1, "FlexSim should be running");
  const r = ok(await c.callTool({ name: "flexsim_cancel_run", arguments: { run_id: started.run_id } }));
  assert.equal(r.status, "cancelled");
  assert.equal(headlessRuns(), 0, "FlexSim is still running");
});

await step("two background runs go one at a time, in order", async () => {
  const a = ok(await c.callTool({ name: "flexsim_start_run", arguments: { model_path: fixture, run_time: 10, include_performance_measures: false, results_script: "return 1;" } }));
  const b = ok(await c.callTool({ name: "flexsim_start_run", arguments: { model_path: fixture, run_time: 10, include_performance_measures: false, results_script: "return 2;" } }));
  const second = ok(await pollRun(b.run_id, "the second run"));
  const first = ok(await c.callTool({ name: "flexsim_get_run", arguments: { run_id: a.run_id, wait_seconds: 0 } }));
  assert.equal(first.results, 1);
  assert.equal(second.results, 2);
});

await step("list_models finds the models", async () => {
  const s = ok(await call("flexsim_list_models", { folder: root }));
  assert.ok(s.models.some((m) => m.path === model), JSON.stringify(s));
});

await step("list_models rejects a file given as a folder", async () => {
  assert.equal((await call("flexsim_list_models", { folder: model })).isError, true);
});

await step("run tools never modify the model file", async () => {
  assert.equal(hash(), before);
});

await step("no headless FlexSim is left running", async () => {
  assert.equal(headlessRuns(), 0);
});

await c.close();

await step("a work folder with a space and a hyphen works, and is left empty", async () => {
  const c2 = await connect({ FLEXSIM_MCP_WORKDIR: workDir });
  const s = ok(await c2.callTool({ name: "flexsim_run_script", arguments: { script: "return 7;" } }, { timeout: 180000 }));
  await c2.close();
  assert.equal(s.result, 7);
  assert.deepEqual(readdirSync(workDir), []);
});

await step("closing the connection during a background run stops FlexSim", async () => {
  const c4 = await connect();
  await c4.callTool({ name: "flexsim_start_run", arguments: { model_path: fixture, run_time: 100, setup_script: "while (1) { }", timeout_seconds: 300 } });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  assert.equal(headlessRuns(), 1, "FlexSim should be running");
  await c4.close();
  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.equal(headlessRuns(), 0, "FlexSim is still running");
});

if (openGui) {
  const c3 = await connect();
  await step("open_in_gui opens the normal FlexSim window", async () => {
    ok(await c3.callTool({ name: "flexsim_open_in_gui", arguments: { model_path: fixture } }));
    return "close the window yourself when done";
  });
  await c3.close();
} else {
  skipped++;
  console.log("SKIP  open_in_gui: pass --gui to test it");
}

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // A window opened by --gui can still hold the model; the temp folder is harmless.
}
console.log(failures ? `\n${failures} step(s) FAILED, ${skipped} skipped` : `\nAll steps passed, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
