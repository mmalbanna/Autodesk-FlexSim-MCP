// FlexSim MCP server (stdio). Drives Autodesk FlexSim headless through its documented
// command line: flexsim.exe model.fsm /maintenance nogui_disablemsg_runscript /scriptpath x.txt
// Author: Motasem Albanna
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  configuredExe,
  findInstallations,
  fsLiteral,
  fsNumber,
  openInGui,
  resolveExe,
  runHeadless,
  type RunOutcome,
  type Step,
} from "./flexsim.js";

const VERSION = "1.0.1";
const DEFAULT_TIMEOUT_S = Math.min(7200, Math.max(30, Number(process.env.FLEXSIM_TIMEOUT_SECONDS) || 600));
const CHARACTER_LIMIT = 40000;

const timeoutField = z
  .number()
  .int()
  .min(10)
  .max(7200)
  .optional()
  .describe(`Seconds before the server stops FlexSim. Default ${DEFAULT_TIMEOUT_S}. The MCP client may stop waiting sooner, which also stops FlexSim.`);
const modelPathField = z
  .string()
  .min(5)
  .describe('Full path to a FlexSim model, e.g. "C:\\\\Users\\\\me\\\\Documents\\\\Autodesk FlexSim 2027 Projects\\\\Line1.fsm"')
  .refine((p) => extname(p).toLowerCase() === ".fsm", "model_path must point to a .fsm file")
  .refine((p) => !p.includes('"'), "model_path must not contain a double quote");

function reply(payload: Record<string, unknown>, isError = false) {
  // Status fields first, so that truncation can never hide an error or warning.
  const { ok, error, warning, note, flexsim_console, flexsim_output, ...rest } = payload;
  const status = { ok, error, warning, note, flexsim_console, flexsim_output };
  const ordered = { ...status, ...rest };
  const text = JSON.stringify(ordered, null, 2);
  if (text.length <= CHARACTER_LIMIT) {
    return { content: [{ type: "text" as const, text }], structuredContent: ordered, isError };
  }
  const message = "Result truncated: narrow the query or return less data from the script.";
  return {
    content: [{ type: "text" as const, text: `${text.slice(0, CHARACTER_LIMIT)}\n... [${message}]` }],
    structuredContent: { ...status, truncated: true, message, total_characters: text.length },
    isError,
  };
}

const STEP_LABELS: Record<string, string> = {
  result: "your script",
  setup_result: "setup_script",
  results: "results_script",
};

/** Error text if any step failed to compile. FlexSim itself reports nothing in that case. */
function compileError(o: RunOutcome): string | undefined {
  if (!o.notCompiled?.length) return undefined;
  const names = o.notCompiled.map((k) => STEP_LABELS[k] ?? k).join(", ");
  return (
    `FlexSim could not compile ${names}, so it did not run. FlexSim gives no details: ` +
    "look for a syntax error or a misspelled command, class or property."
  );
}

/** Error text for steps that raised a FlexScript exception, leaving out the given keys. */
function exceptionError(o: RunOutcome, except: string[] = []): string | undefined {
  const failed = (o.threw ?? []).filter((t) => !except.includes(t.key));
  if (!failed.length) return undefined;
  return failed.map((t) => `${STEP_LABELS[t.key] ?? t.key} raised an exception: ${t.message}`).join(" ");
}

/** Shape a run outcome for the model, keeping console text short. */
function outcomePayload(o: RunOutcome, extra: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { ok: o.ok, duration_seconds: +(o.durationMs / 1000).toFixed(1), flexsim_exe: o.exe };
  if (!o.ok) return { ...base, error: o.error, exit_code: o.exitCode ?? null, ...extra };
  const r = { ...(o.result ?? {}) };
  const consoleText = typeof r.console === "string" ? r.console.trim() : "";
  const outputText = typeof r.output === "string" ? r.output.trim() : "";
  delete r.console;
  delete r.output;
  delete r.wrapper;
  for (const k of Object.keys(r)) if (/^step_\d+_done$/.test(k)) delete r[k];
  return {
    ...base,
    ...r,
    ...extra,
    ...(consoleText ? { flexsim_console: consoleText.slice(-4000) } : {}),
    ...(outputText ? { flexsim_output: outputText.slice(-4000) } : {}),
  };
}

function createServer(): McpServer {
  const server = new McpServer({ name: "flexsim-mcp", version: VERSION });

  server.registerTool(
    "flexsim_check_installation",
    {
      title: "Check FlexSim installation",
      description: `Report which FlexSim installs exist on this PC and which flexsim.exe the server will use.
Set smoke_test=true to launch FlexSim headless and evaluate 1+1, proving the whole pipeline works (takes 10-60 s).
Run this first whenever another FlexSim tool fails.`,
      inputSchema: z.strictObject({
        smoke_test: z.boolean().default(false).describe("Launch FlexSim headless to prove it can run scripts"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ smoke_test }, ctx) => {
      const resolved = resolveExe();
      const payload: Record<string, unknown> = {
        server_version: VERSION,
        platform: process.platform,
        node: process.version,
        configured_exe: configuredExe(),
        exe_in_use: resolved.exe,
        exe_source: resolved.source,
        installations: findInstallations(),
        default_timeout_seconds: DEFAULT_TIMEOUT_S,
      };
      if (!smoke_test) return reply(payload, !resolved.exe);
      const o = await runHeadless({
        steps: [{ key: "smoke", code: "return 1 + 1;" }],
        timeoutMs: 120000,
        signal: ctx.mcpReq.signal,
      });
      const passed = o.ok && Number(o.result?.smoke) === 2;
      return reply({ ...payload, smoke_test: passed ? "passed" : "failed", run: outcomePayload(o) }, !passed);
    },
  );

  server.registerTool(
    "flexsim_run_model",
    {
      title: "Run a FlexSim model",
      description: `Open a .fsm model headless, optionally set Model Parameters, reset, run to run_time, and return results.
The server never saves the model file. Scripts you pass run with full FlexScript access, so they could.

Returns model_time reached, all Performance Measures (if the model has any), and whatever results_script returns.
If a parameter cannot be applied, or a script raises an exception, the call fails, because the results may not reflect the requested scenario.
Each call is one replication. For models with randomness, don't treat a difference between single runs as conclusive.
Scripts are FlexScript bodies; end them with "return <value>;" using numbers, strings, Array or Map.

Examples:
  - Baseline run for 8 h (seconds model units): run_time=28800
  - What-if: parameters={"NumOperators": 4, "ArrivalRate": 30}
  - Custom output: results_script='Object s = Model.find("Sink1"); return s.stats.input.value;'`,
      inputSchema: z.strictObject({
        model_path: modelPathField,
        run_time: z.number().positive().describe("Simulation stop time in model time units"),
        parameters: z
          .record(z.string().min(1), z.union([z.number(), z.string(), z.boolean()]))
          .optional()
          .describe("Model Parameter values by name, applied before reset"),
        setup_script: z.string().max(20000).optional().describe("FlexScript run after reset, before the run"),
        results_script: z.string().max(20000).optional().describe("FlexScript run after the run; its return value is reported"),
        include_performance_measures: z.boolean().default(true).describe("Collect Performance Measure tables"),
        timeout_seconds: timeoutField,
      }),
      // setup_script and results_script run arbitrary FlexScript, so this has the same power as flexsim_run_script.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a, ctx) => {
      const steps: Step[] = [];
      const hasParameters = !!a.parameters && Object.keys(a.parameters).length > 0;
      if (hasParameters) {
        const sets = Object.entries(a.parameters!).map(([k, v]) => {
          const val = typeof v === "string" ? fsLiteral(v) : typeof v === "boolean" ? (v ? "1" : "0") : fsNumber(v);
          const name = fsLiteral(k);
          return `if (Model.parameters[${name}]) Model.parameters[${name}].value = ${val}; else missing += ${fsLiteral(`${k}, `)};`;
        });
        steps.push({
          key: "parameters_applied",
          code: ['string missing = "";', ...sets, 'if (missing.length > 0) return "missing: " + missing;', 'return "ok";'].join("\n"),
        });
      }
      steps.push({ key: "reset_done", code: "resetmodel();\nreturn 1;" });
      if (a.setup_script) steps.push({ key: "setup_result", code: a.setup_script });
      steps.push({
        key: "run_end_time",
        code: `stoptime(${fsNumber(a.run_time)});\nrunspeed(1000000000);\nrunfunction(1);\nreturn Model.time;`,
      });
      if (a.include_performance_measures) {
        steps.push({
          key: "performance_measures",
          code: [
            "Map m;",
            'treenode tables = Model.find("Tools/PerformanceMeasureTables");',
            "if (!tables) return m;",
            "for (int k = 1; k <= tables.subnodes.length; k++) {",
            '  Array pfms = function_s(tables.subnodes[k], "getAllPFMs");',
            "  for (int i = 1; i <= pfms.length; i++) {",
            "    treenode p = pfms[i];",
            "    string name = p.up.first.value;",
            "    m[name] = p.value;",
            "  }",
            "}",
            "return m;",
          ].join("\n"),
        });
      }
      if (a.results_script) steps.push({ key: "results", code: a.results_script });

      const o = await runHeadless({
        steps,
        modelPath: a.model_path,
        timeoutMs: (a.timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000,
        signal: ctx.mcpReq.signal,
      });
      const extra: Record<string, unknown> = { model_path: a.model_path, requested_run_time: a.run_time };
      let failed = !o.ok;
      if (o.ok) {
        const t = Number(o.result?.model_time);
        const applied = o.result?.parameters_applied;
        // An exception raised during the run usually comes from the model's own logic, so the results are still reported.
        const duringRun = o.threw?.find((f) => f.key === "run_end_time");
        const parameterProblem = o.threw?.find((f) => f.key === "parameters_applied");
        const notFound = typeof applied === "string" && applied.startsWith("missing: ");
        const scenarioWrong = hasParameters && (applied !== "ok" || !!parameterProblem);
        let error = compileError(o);
        if (!error && scenarioWrong) {
          // A what-if that silently used other values would look like a valid answer, so this is an error.
          error =
            "These results do NOT reflect the requested scenario. " +
            (notFound
              ? `Parameters not found in the model (${String(applied).replace(/^missing: /, "").replace(/, $/, "")}). Names are case sensitive.`
              : (parameterProblem?.message ?? "Setting the parameters failed; see flexsim_console."));
        }
        error ??= exceptionError(o, ["run_end_time"]);
        if (error) {
          failed = true;
          extra.ok = false;
          extra.error = error;
        }
        const warnings: string[] = [];
        if (duringRun) warnings.push(`An exception was raised during the run, so check the results: ${duringRun.message}`);
        if (Number.isFinite(t) && t < a.run_time * 0.999) {
          warnings.push(
            `Model stopped at ${t}, before run_time ${a.run_time}. The model may have run out of events, have an earlier stop time, or the run did not complete.`,
          );
        }
        if (warnings.length) extra.warning = warnings.join(" ");
      }
      return reply(outcomePayload(o, extra), failed);
    },
  );

  server.registerTool(
    "flexsim_run_script",
    {
      title: "Run FlexScript",
      description: `Run any FlexScript headless, optionally against a model, and return its value.
Anything the script print()s comes back as flexsim_output; FlexScript errors come back as flexsim_console.
Use for inspecting a model (objects, labels, tables, parameters) or anything the other tools do not cover.
End the script with "return <value>;" (number, string, Array or Map). Without a return statement the result is 0. Division by zero gives null. The model file is not saved unless your script saves it.

Examples:
  - List top-level objects: 'Array a = []; treenode m = model(); for (int i = 1; i <= m.subnodes.length; i++) a.push(m.subnodes[i].name); return a;'
  - Read one parameter: 'return Model.parameters["NumOperators"].evaluate();'`,
      inputSchema: z.strictObject({
        script: z.string().min(1).max(50000).describe("FlexScript body ending in return <value>;"),
        model_path: modelPathField.optional(),
        timeout_seconds: timeoutField,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ script, model_path, timeout_seconds }, ctx) => {
      const o = await runHeadless({
        steps: [{ key: "result", code: script }],
        modelPath: model_path,
        timeoutMs: (timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000,
        signal: ctx.mcpReq.signal,
      });
      const extra: Record<string, unknown> = {};
      const compile = compileError(o);
      const raised = exceptionError(o);
      if (compile) {
        // The 0 that executestring() returned here is not a result.
        extra.ok = false;
        extra.error = compile;
        extra.result = null;
      } else if (raised) {
        extra.ok = false;
        extra.error = raised;
      } else if (o.ok && o.result?.result === null) {
        extra.note = "The script returned null, which can come from a non-finite value such as division by zero.";
      }
      return reply(outcomePayload(o, extra), !o.ok || !!compile || !!raised);
    },
  );

  server.registerTool(
    "flexsim_read_table",
    {
      title: "Read a Global Table",
      description: "Read a Global Table from a model (column headers and rows) without running the simulation.",
      inputSchema: z.strictObject({
        model_path: modelPathField,
        table_name: z.string().min(1).describe('Global Table name, e.g. "Schedule"'),
        max_rows: z.number().int().min(1).max(5000).default(500).describe("Maximum rows to return"),
        timeout_seconds: timeoutField,
      }),
      // Not read-only: opening a model can run triggers stored in it.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ model_path, table_name, max_rows, timeout_seconds }, ctx) => {
      const code = [
        // Table() on a missing name is not an error in FlexScript; it just looks empty.
        `if (!Tools.get("GlobalTable", ${fsLiteral(table_name)})) return 0;`,
        `Table t = Table(${fsLiteral(table_name)});`,
        "Map m;",
        "Array cols = [];",
        "for (int j = 1; j <= t.numCols; j++) cols.push(t.getColHeader(j));",
        'm["columns"] = cols;',
        'm["num_rows"] = t.numRows;',
        "Array rows = [];",
        `int n = t.numRows;`,
        `if (n > ${max_rows}) n = ${max_rows};`,
        "for (int i = 1; i <= n; i++) {",
        "  Array r = [];",
        "  for (int j = 1; j <= t.numCols; j++) r.push(t[i][j]);",
        "  rows.push(r);",
        "}",
        'm["rows"] = rows;',
        "return m;",
      ].join("\n");
      const o = await runHeadless({
        steps: [{ key: "table", code }],
        modelPath: model_path,
        timeoutMs: (timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000,
        signal: ctx.mcpReq.signal,
      });
      const extra: Record<string, unknown> = { table_name };
      if (o.ok && !o.result?.table) {
        extra.ok = false;
        extra.error =
          compileError(o) ??
          (o.result?.table === 0
            ? `Global Table "${table_name}" was not found in this model. Names are case sensitive.`
            : `Global Table "${table_name}" could not be read. ${exceptionError(o) ?? "See flexsim_console."}`);
      }
      return reply(outcomePayload(o, extra), !o.ok || !o.result?.table);
    },
  );

  server.registerTool(
    "flexsim_list_models",
    {
      title: "List FlexSim models",
      description: "Find .fsm model files in a folder (searches up to 4 levels deep, newest first).",
      inputSchema: z.strictObject({
        folder: z.string().min(3).describe('Folder to search, e.g. "C:\\\\Users\\\\me\\\\Documents"'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ folder, limit }, ctx) => {
      const MAX_HITS = 5000;
      const MAX_MS = 60000;
      const deadline = Date.now() + MAX_MS;
      const hits: { path: string; modified: string; size_kb: number }[] = [];
      let truncated = false;
      let unreadable = 0;
      // Asynchronous, so a big or slow folder can't block the timers of a FlexSim run in progress.
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 4) return;
        if (hits.length >= MAX_HITS || Date.now() > deadline || ctx.mcpReq.signal.aborted) {
          truncated = true;
          return;
        }
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          unreadable++;
          return;
        }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) {
            if (!e.name.startsWith(".") && e.name !== "node_modules") await walk(p, depth + 1);
          } else if (extname(e.name).toLowerCase() === ".fsm") {
            try {
              const s = await stat(p);
              hits.push({ path: p, modified: s.mtime.toISOString(), size_kb: Math.round(s.size / 1024) });
            } catch {
              unreadable++;
            }
          }
        }
      };
      try {
        const s = await stat(folder);
        if (!s.isDirectory()) return reply({ ok: false, error: `Not a folder: ${folder}` }, true);
        await readdir(folder);
      } catch {
        return reply({ ok: false, error: `Folder not found or not readable: ${folder}` }, true);
      }
      await walk(folder, 0);
      hits.sort((a, b) => b.modified.localeCompare(a.modified));
      return reply({
        ok: true,
        folder,
        total: hits.length,
        ...(truncated ? { truncated: true, warning: "The search stopped early, so this list may be incomplete and may not include the newest models." } : {}),
        ...(unreadable ? { unreadable_items: unreadable } : {}),
        models: hits.slice(0, limit),
      });
    },
  );

  server.registerTool(
    "flexsim_open_in_gui",
    {
      title: "Open FlexSim window",
      description: "Open the normal FlexSim window, optionally with a model, so the user can watch or edit it. Separate from headless runs.",
      inputSchema: z.strictObject({ model_path: modelPathField.optional() }),
      // Not read-only: it starts a program that outlives the call, and opening a model can run triggers stored in it.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ model_path }) => {
      const r = openInGui(model_path);
      return reply(r, !r.ok);
    },
  );

  return server;
}

serveStdio(createServer);
console.error(`flexsim-mcp ${VERSION} running on stdio`);
