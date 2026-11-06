// FlexSim process runner: generates a FlexScript wrapper, launches flexsim.exe headless,
// waits for the JSON result file, and cleans up the process and its temp files.
// Author: Motasem Albanna
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";

export const EXAMPLE_EXE = "C:\\Program Files\\Autodesk\\FlexSim 2027\\program\\flexsim.exe";

export interface Installation {
  exe: string;
  label: string;
  year: number;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Find FlexSim installs in the usual Windows locations, newest first. */
export function findInstallations(): Installation[] {
  const roots = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Autodesk"),
    process.env.ProgramFiles ?? "C:\\Program Files",
  ];
  const found: Installation[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^FlexSim/i.test(name)) continue;
      const exe = join(root, name, "program", "flexsim.exe");
      if (existsSync(exe)) {
        const year = Number(name.match(/(20\d\d)/)?.[1] ?? 0);
        found.push({ exe, label: name, year });
      }
    }
  }
  return found.sort((a, b) => b.year - a.year || b.label.localeCompare(a.label));
}

/** FLEXSIM_EXE if really set. Extension hosts can pass an empty value or an unsubstituted placeholder. */
export function configuredExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.FLEXSIM_EXE?.trim();
  return value && !value.includes("${") ? value : null;
}

/** Configured exe if it exists, else the newest detected install. */
export function resolveExe(): { exe: string | null; source: string } {
  const configured = configuredExe();
  if (configured && isFile(configured)) return { exe: configured, source: "configured" };
  const missing = configured ? `configured path not found: ${configured}` : null;
  const installs = findInstallations();
  if (installs.length > 0) {
    const detected = `auto-detected (${installs[0].label})`;
    return { exe: installs[0].exe, source: missing ? `${detected}; ${missing}` : detected };
  }
  return { exe: null, source: missing ?? "none found" };
}

/** Per-user work folder, so run files holding scripts and results aren't readable by other local users. */
function workRoot(): string {
  const fromEnv = process.env.FLEXSIM_MCP_WORKDIR?.trim();
  if (fromEnv && !fromEnv.includes("${")) return fromEnv;
  return join(tmpdir(), "flexsim-mcp");
}

/** FlexScript string literal. JSON escaping (\" \\ \n \t) matches FlexScript's C-style escapes. */
export function fsLiteral(s: string): string {
  // Drop control characters JSON would emit as \u00XX, which FlexScript does not parse.
  const clean = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return JSON.stringify(clean);
}

/** FlexScript number literal. FlexScript rejects forms like 1e+21, which JavaScript produces for large numbers. */
export function fsNumber(n: number): string {
  const text = String(n);
  return text.includes("e+") ? BigInt(Math.trunc(n)).toString() : text;
}

/**
 * A FlexScript step run through executestring(), so a compile or runtime error in one
 * step cannot stop the wrapper from writing its results file and exiting.
 */
export interface Step {
  key: string; // result key in the output map
  code: string; // FlexScript body; use `return <value>;` to return data
}

/**
 * Printed first by each step. FlexSim gives no error text when executestring() cannot compile
 * code: it just returns 0, which looks like a real answer. A step that returned 0 and whose
 * marker never reached the Output Console did not compile, so it did not run.
 */
function stepMarker(index: number): string {
  return `<<flexsim-mcp-step-${index + 1}>>`;
}

/** Output Console text without our step markers or the messages FlexSim prints when loading a model. */
export function cleanOutput(text: string): string {
  const kept: string[] = [];
  let afterSearch = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*<<flexsim-mcp-step-\d+>>\s*$/.test(raw)) continue;
    const line = raw.replace(/<<flexsim-mcp-step-\d+>>/g, "");
    if (/^Searching for substring in data /.test(line)) {
      afterSearch = true;
      continue;
    }
    if (afterSearch && line.trim() === "") continue;
    if (afterSearch && /^found \d+ occurrences\.?$/.test(line.trim())) {
      afterSearch = false;
      continue;
    }
    afterSearch = false;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildWrapper(steps: Step[], outPath: string): string {
  const out = fsLiteral(outPath.replace(/\\/g, "/"));
  const lines = [
    "Map mcpres;",
    'mcpres["wrapper"] = "flexsim-mcp/1";',
    // Output Console text from here on. Anything earlier is FlexSim's own start-up noise.
    'int mcpOutStart = applicationcommand("getconsoletext", 1).length;',
    // System Console text is tracked per step, to tell which step raised an exception.
    'string mcpErr = applicationcommand("getconsoletext", 2);',
    "int mcpErrStart = mcpErr.length;",
  ];
  steps.forEach((s, i) => {
    const code = `print(${fsLiteral(stepMarker(i))});\n${s.code}`;
    lines.push(`mcpres["${s.key}"] = executestring(${fsLiteral(code)});`);
    lines.push(`mcpres["step_${i + 1}_done"] = 1;`);
    lines.push('mcpErr = applicationcommand("getconsoletext", 2);');
    // slice(0) returns nothing in FlexScript, so the start of the text needs its own case.
    lines.push(`mcpres["step_${i + 1}_errors"] = mcpErrStart > 0 ? mcpErr.slice(mcpErrStart) : mcpErr;`);
    lines.push("mcpErrStart = mcpErr.length;");
  });
  lines.push(
    'mcpres["model_time"] = Model.time;',
    'mcpres["console"] = applicationcommand("getconsoletext", 2);',
    'string mcpOut = applicationcommand("getconsoletext", 1);',
    'mcpres["output"] = mcpOutStart > 0 ? mcpOut.slice(mcpOutStart) : mcpOut;',
    `fileopen(${out}, "w");`,
    "fpt(JSON.stringify(mcpres));",
    "fileclose();",
    "cmdexit();",
  );
  return lines.join("\n") + "\n";
}

export interface StepFailure {
  key: string;
  message: string;
}

/** Turn the wrapper's raw result into a clean result plus the steps that failed. */
export function interpretResult(
  parsed: Record<string, unknown>,
  steps: Step[],
): { result: Record<string, unknown>; notCompiled: string[]; threw: StepFailure[] } {
  const output = typeof parsed.output === "string" ? parsed.output : "";
  const result: Record<string, unknown> = { ...parsed, output: cleanOutput(output) };
  const notCompiled: string[] = [];
  const threw: StepFailure[] = [];
  steps.forEach((s, i) => {
    if (parsed[s.key] === 0 && !output.includes(stepMarker(i))) notCompiled.push(s.key);
    const errors = parsed[`step_${i + 1}_errors`];
    if (typeof errors === "string" && /exception/i.test(errors)) threw.push({ key: s.key, message: errors.trim().slice(-1000) });
    delete result[`step_${i + 1}_errors`];
  });
  return { result, notCompiled, threw };
}

export interface RunOptions {
  steps: Step[];
  modelPath?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  /** Keys of the steps FlexSim could not compile, which therefore did not run. */
  notCompiled?: string[];
  /** Steps that raised a FlexScript exception. */
  threw?: StepFailure[];
  error?: string;
  exitCode?: number | null;
  /** FlexSim ended by itself but wrote no results. */
  exitedWithoutResults?: boolean;
  durationMs: number;
  exe: string;
}

/**
 * FlexSim parses its own command line and treats an unquoted "-" or "/" inside a value as the
 * start of a new switch. A /scriptpath containing either is dropped with no error: FlexSim
 * starts, never runs the script, and idles until it is killed. Paths are therefore always
 * quoted on Windows. Node quotes only arguments containing spaces, so spawnOptions() turns
 * that off and these strings reach FlexSim exactly as written here. That also means an embedded
 * quote could add switches of its own, so it is refused. No real Windows path contains one.
 */
function quotedPath(path: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return path;
  if (path.includes('"')) throw new Error(`Path contains a double quote: ${path}`);
  return `"${path}"`;
}

/** Arguments for a headless run. FlexSim requires the model path before every switch. */
export function flexsimArgs(
  modelPath: string | undefined,
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    ...(modelPath ? [quotedPath(modelPath, platform)] : []),
    "/maintenance",
    "nogui_disablemsg_runscript",
    "/scriptpath",
    quotedPath(scriptPath, platform),
  ];
}

/**
 * MCP hosts may start a server with a trimmed environment. With ProgramData and ALLUSERSPROFILE
 * missing, FlexSim 2027 crashes during start-up: it never runs the script, exits with code 0 after
 * about 35 s, and can raise an Autodesk Error Report window. Restore them so it behaves the same
 * under any host.
 */
export function flexsimEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const fallback = `${env.SystemDrive ?? env.SYSTEMDRIVE ?? "C:"}\\ProgramData`;
  return {
    ...env,
    ProgramData: env.ProgramData ?? env.ALLUSERSPROFILE ?? fallback,
    ALLUSERSPROFILE: env.ALLUSERSPROFILE ?? env.ProgramData ?? fallback,
  };
}

/** Spawn options matching flexsimArgs(): no re-quoting, and the exe path stays a single token. */
export function spawnOptions(exe: string, platform: NodeJS.Platform = process.platform): SpawnOptions {
  const base: SpawnOptions = { windowsHide: true, stdio: "ignore" };
  if (platform !== "win32") return base;
  return { ...base, windowsVerbatimArguments: true, argv0: `"${exe}"`, env: flexsimEnv(process.env, platform) };
}

// One FlexSim run at a time within this server: avoids license contention and runaway processes.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    child.kill("SIGKILL");
  }
}

// The first run after a force-stopped FlexSim exits with code 0 and no results, about 48 s after the
// stopped run began. The cause is unknown, but an immediate second attempt works, so retry once.
let lastRunForceStopped = false;

export function runHeadless(opts: RunOptions): Promise<RunOutcome> {
  return serialize(async () => {
    const mayRetry = lastRunForceStopped;
    lastRunForceStopped = false;
    const first = await runOnce(opts);
    if (mayRetry && first.exitedWithoutResults && !opts.signal?.aborted) return runOnce(opts);
    return first;
  });
}

const STOP_GRACE_MS = 10000;

function failureMessage(reason: string, code: number | null, timeoutMs: number): string {
  const stillRunning = reason.endsWith(":still-running");
  const stopped = stillRunning ? "could not be confirmed as stopped, so check Task Manager" : "was stopped";
  if (reason.startsWith("timeout")) {
    return (
      `FlexSim did not finish within ${Math.round(timeoutMs / 1000)} s and ${stopped}. If the model is just slow, ` +
      "shorten run_time or allow more time where the tool accepts timeout_seconds. Otherwise check FlexSim is signed in " +
      "and licensed, and open the model with flexsim_open_in_gui to look for prompts."
    );
  }
  if (reason.startsWith("cancelled")) return `The run was cancelled and FlexSim ${stopped}.`;
  if (reason.startsWith("spawn error")) return `FlexSim could not be started: ${reason.slice("spawn error: ".length)}`;
  return (
    `FlexSim exited (code ${code}) without writing results. Likely causes: a crash (look for an Autodesk Error Report ` +
    "window), a licence problem, or a model that fails to open. Run flexsim_check_installation with smoke_test=true, " +
    "then open the model with flexsim_open_in_gui to see messages."
  );
}

async function runOnce({ steps, modelPath, timeoutMs, signal }: RunOptions): Promise<RunOutcome> {
  const started = Date.now();
  const { exe, source } = resolveExe();
  if (!exe) {
    return {
      ok: false,
      durationMs: 0,
      exe: "",
      error:
        `FlexSim executable not found (${source}). Set the FLEXSIM_EXE environment variable, or "FlexSim executable" ` +
        `in the extension settings, to your flexsim.exe, e.g. ${EXAMPLE_EXE}.`,
    };
  }
  // A call can be cancelled while it waits in the queue, and an already-aborted signal never fires its event.
  if (signal?.aborted) return { ok: false, durationMs: 0, exe, error: "The run was cancelled before it started." };
  const model = modelPath ? resolvePath(modelPath) : undefined;
  if (model && !isFile(model)) {
    return { ok: false, durationMs: 0, exe, error: `Model file not found: ${modelPath}. Use flexsim_list_models to find .fsm files.` };
  }

  const dir = join(workRoot(), randomUUID());
  const scriptPath = join(dir, "script.txt");
  const outPath = join(dir, "result.json");

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(scriptPath, buildWrapper(steps, outPath), "utf8");
    if (signal?.aborted) return { ok: false, durationMs: 0, exe, error: "The run was cancelled before it started." };

    const child = spawn(exe, flexsimArgs(model, scriptPath), spawnOptions(exe));
    const exit = await new Promise<{ code: number | null; reason: string }>((resolve) => {
      let settled = false;
      let stopReason: string | undefined;
      let grace: NodeJS.Timeout | undefined;
      const done = (code: number | null, reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        clearInterval(poll);
        signal?.removeEventListener("abort", onAbort);
        resolve({ code, reason });
      };
      // Wait for the process to really exit, so the next queued run can't overlap this one.
      const stop = (reason: string) => {
        if (stopReason) return;
        stopReason = reason;
        killTree(child);
        grace = setTimeout(() => done(null, `${reason}:still-running`), STOP_GRACE_MS);
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      // If results exist but FlexSim lingers (cmdexit ignored), give it 15 s then kill it.
      let seenAt = 0;
      const poll = setInterval(() => {
        if (!existsSync(outPath)) return;
        if (!seenAt) seenAt = Date.now();
        else if (Date.now() - seenAt > 15000) stop("results-written");
      }, 1000);
      const onAbort = () => stop("cancelled");
      signal?.addEventListener("abort", onAbort);
      child.on("error", (e) => done(null, `spawn error: ${e.message}`));
      child.on("exit", (code) => done(code, stopReason ?? "exited"));
    });

    const durationMs = Date.now() - started;
    if (exit.reason !== "exited" && !exit.reason.startsWith("spawn error")) lastRunForceStopped = true;
    if (existsSync(outPath) && statSync(outPath).size > 0) {
      const raw = await readFile(outPath, "utf8");
      try {
        const { result, notCompiled, threw } = interpretResult(JSON.parse(raw), steps);
        return { ok: true, result, notCompiled, threw, exitCode: exit.code, durationMs, exe };
      } catch {
        return { ok: false, error: `FlexSim wrote unreadable results: ${raw.slice(0, 2000)}`, exitCode: exit.code, durationMs, exe };
      }
    }
    return {
      ok: false,
      exitCode: exit.code,
      exitedWithoutResults: exit.reason === "exited",
      durationMs,
      exe,
      error: failureMessage(exit.reason, exit.code, timeoutMs),
    };
  } catch (e) {
    return { ok: false, durationMs: Date.now() - started, exe, error: `Could not run FlexSim: ${(e as Error).message}` };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }).catch(() => undefined);
  }
}

/** Launch the normal FlexSim window (detached) so the user can watch or edit the model. */
export function openInGui(modelPath?: string): { ok: boolean; message: string } {
  const { exe, source } = resolveExe();
  if (!exe) return { ok: false, message: `FlexSim executable not found (${source}).` };
  const model = modelPath ? resolvePath(modelPath) : undefined;
  if (model && !isFile(model)) return { ok: false, message: `Model file not found: ${modelPath}` };
  try {
    const args = model ? [flexsimArgs(model, "")[0]] : [];
    // windowsHide would hide FlexSim's main window here, unlike in a headless run.
    const child = spawn(exe, args, { ...spawnOptions(exe), windowsHide: false, detached: true });
    child.on("error", () => undefined);
    child.unref();
    return { ok: true, message: `Opened FlexSim (${exe})${model ? ` with ${model}` : ""}.` };
  } catch (e) {
    return { ok: false, message: `FlexSim could not be started: ${(e as Error).message}` };
  }
}
