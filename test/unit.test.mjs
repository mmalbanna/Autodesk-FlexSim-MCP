// Fast tests that need neither FlexSim nor a built bundle. Run with: npm test
// Importing .ts directly relies on Node's built-in type stripping (Node 22.18 or newer).
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { buildWrapper, cleanOutput, configuredExe, flexsimArgs, flexsimEnv, fsLiteral, fsNumber, interpretResult, spawnOptions } from "../src/flexsim.ts";

// Regression: FlexScript rejects 1e+21, which is how JavaScript writes large numbers.
test("fsNumber never produces a positive exponent", () => {
  assert.equal(fsNumber(28800), "28800");
  assert.equal(fsNumber(0.5), "0.5");
  assert.equal(fsNumber(1e21), "1000000000000000000000");
});

test("configuredExe ignores empty values and unsubstituted placeholders", () => {
  assert.equal(configuredExe({}), null);
  assert.equal(configuredExe({ FLEXSIM_EXE: "  " }), null);
  assert.equal(configuredExe({ FLEXSIM_EXE: "${user_config.flexsim_exe}" }), null);
  assert.equal(configuredExe({ FLEXSIM_EXE: "C:\\f.exe" }), "C:\\f.exe");
});

test("a path containing a double quote is refused on Windows, because it could add switches", () => {
  assert.throws(() => flexsimArgs('C:\\a" /maintenance x "b.fsm', "C:\\s.txt", "win32"), /double quote/);
});

test("interpretResult: a step counts as not compiled only if it returned 0 and printed no marker", () => {
  const steps = [{ key: "a", code: "" }, { key: "b", code: "" }, { key: "c", code: "" }];
  const { notCompiled } = interpretResult({ a: 0, b: 0, c: 7, output: "<<flexsim-mcp-step-2>>\n" }, steps);
  assert.deepEqual(notCompiled, ["a"]);
});

test("interpretResult: reports exceptions per step and removes the raw fields", () => {
  const steps = [{ key: "a", code: "" }, { key: "b", code: "" }];
  const { threw, result } = interpretResult(
    { a: 1, b: null, output: "", step_1_errors: "", step_2_errors: "exception: Unable to set X\n" },
    steps,
  );
  assert.deepEqual(threw, [{ key: "b", message: "exception: Unable to set X" }]);
  assert.equal(result.step_2_errors, undefined);
});

test("the version number matches everywhere it is recorded", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const version = JSON.parse(read("package.json")).version;
  assert.equal(JSON.parse(read("bundle/manifest.json")).version, version, "bundle/manifest.json");
  assert.equal(JSON.parse(read("package-lock.json")).version, version, "package-lock.json");
  assert.match(read("src/index.ts"), new RegExp(`const VERSION = "${version}";`), "src/index.ts");
  assert.ok(read("CHANGELOG.md").includes(`## ${version} - `), "CHANGELOG.md");
});

const HYPHEN_MODEL = "C:\\models\\line-1.fsm";
const HYPHEN_SCRIPT = "C:\\Temp\\flexsim-mcp\\281b40a4-90ad\\script.txt";

// Regression: FlexSim treats an unquoted "-" or "/" inside a value as the start of a new
// switch and then silently ignores the script, so every run hung until its timeout.
test("Windows: script path is quoted so hyphens survive FlexSim's parser", () => {
  const args = flexsimArgs(undefined, HYPHEN_SCRIPT, "win32");
  assert.deepEqual(args, ["/maintenance", "nogui_disablemsg_runscript", "/scriptpath", `"${HYPHEN_SCRIPT}"`]);
});

test("Windows: model path is quoted and comes before every switch", () => {
  const args = flexsimArgs(HYPHEN_MODEL, HYPHEN_SCRIPT, "win32");
  assert.equal(args[0], `"${HYPHEN_MODEL}"`);
  assert.equal(args[1], "/maintenance");
});

test("Windows: Node must not re-quote, and the exe path must stay one token", () => {
  const exe = "C:\\Program Files\\Autodesk\\FlexSim 2027\\program\\flexsim.exe";
  const opts = spawnOptions(exe, "win32");
  assert.equal(opts.windowsVerbatimArguments, true);
  assert.equal(opts.argv0, `"${exe}"`);
  assert.equal(opts.windowsHide, true);
});

test("Other platforms: arguments are passed through unquoted", () => {
  const args = flexsimArgs("/models/line-1.fsm", "/tmp/a-b/script.txt", "linux");
  assert.deepEqual(args, ["/models/line-1.fsm", "/maintenance", "nogui_disablemsg_runscript", "/scriptpath", "/tmp/a-b/script.txt"]);
  const opts = spawnOptions("/opt/flexsim", "linux");
  assert.equal(opts.windowsVerbatimArguments, undefined);
  assert.equal(opts.argv0, undefined);
});

test("fsLiteral escapes quotes and backslashes and drops control characters", () => {
  assert.equal(fsLiteral('A "day"'), '"A \\"day\\""');
  assert.equal(fsLiteral("C:\\x"), '"C:\\\\x"');
  assert.equal(fsLiteral("a\u0001b"), '"ab"');
});

test("buildWrapper writes results to a forward-slash path and always exits", () => {
  const w = buildWrapper([{ key: "smoke", code: "return 1 + 1;" }], "C:\\work\\result.json");
  assert.ok(w.includes('return 1 + 1;");'), "the step's code is passed to executestring");
  assert.match(w, /fileopen\("C:\/work\/result\.json", "w"\);/);
  assert.ok(w.trimEnd().endsWith("cmdexit();"));
});

// Regression: FlexSim returns 0 with no error text for code that does not compile, so each step
// prints a marker first. No marker means the step never ran.
test("buildWrapper makes every step print a marker before its code", () => {
  const w = buildWrapper([{ key: "a", code: "return 1;" }, { key: "b", code: "return 2;" }], "C:\\work\\r.json");
  assert.ok(w.includes('print(\\"<<flexsim-mcp-step-1>>\\");\\nreturn 1;'));
  assert.ok(w.includes('print(\\"<<flexsim-mcp-step-2>>\\");\\nreturn 2;'));
});

test("cleanOutput removes markers and FlexSim's model-load messages, and keeps real output", () => {
  const raw = [
    "Searching for substring in data (Replace): popup:ValuesByCase:", "", "found 0 occurrences.", "",
    "<<flexsim-mcp-step-1>>", "hello console", "<<flexsim-mcp-step-2>>", "found 3 widgets", "",
  ].join("\n");
  assert.equal(cleanOutput(raw), "hello console\nfound 3 widgets");
});

test("cleanOutput keeps a user's own line that resembles FlexSim's, and strips a marker mid-line", () => {
  assert.equal(cleanOutput("found 2 occurrences.\nx<<flexsim-mcp-step-2>>"), "found 2 occurrences.\nx");
});

test("buildWrapper reports only Output Console text written after it starts", () => {
  const w = buildWrapper([{ key: "x", code: "return 1;" }], "C:\\work\\result.json");
  assert.ok(w.indexOf("mcpOutStart =") < w.indexOf("executestring"));
  assert.match(w, /mcpres\["output"\] = mcpOutStart > 0 \? mcpOut\.slice\(mcpOutStart\) : mcpOut;/);
});

// Regression: MCP hosts may start a server with a trimmed environment. Without ProgramData and
// ALLUSERSPROFILE, FlexSim 2027 fails during start-up, never runs the script, and can raise an
// Autodesk Error Report window.
test("Windows: ProgramData and ALLUSERSPROFILE are restored when the host strips them", () => {
  const env = flexsimEnv({ SystemDrive: "D:", TEMP: "x" }, "win32");
  assert.equal(env.ProgramData, "D:\\ProgramData");
  assert.equal(env.ALLUSERSPROFILE, "D:\\ProgramData");
  assert.equal(env.TEMP, "x");
});

// "C:ProgramData" (no backslash) is a drive-relative path, not the real folder.
test("Windows: the restored ProgramData is an absolute path", () => {
  assert.ok(win32.isAbsolute(flexsimEnv({}, "win32").ProgramData));
  assert.ok(win32.isAbsolute(flexsimEnv({}, "win32").ALLUSERSPROFILE));
});

test("Windows: existing values are kept, and one fills in the other", () => {
  assert.equal(flexsimEnv({ ProgramData: "E:\\PD", ALLUSERSPROFILE: "F:\\AU" }, "win32").ALLUSERSPROFILE, "F:\\AU");
  assert.equal(flexsimEnv({ ALLUSERSPROFILE: "F:\\AU" }, "win32").ProgramData, "F:\\AU");
  assert.equal(flexsimEnv({}, "win32").ProgramData, "C:\\ProgramData");
});

test("Other platforms: the environment is left alone", () => {
  assert.deepEqual(flexsimEnv({ HOME: "/h" }, "linux"), { HOME: "/h" });
});

test("spawnOptions carries the repaired environment on Windows", () => {
  const opts = spawnOptions("C:\\f.exe", "win32");
  assert.ok(opts.env.ProgramData);
  assert.ok(opts.env.ALLUSERSPROFILE);
});
