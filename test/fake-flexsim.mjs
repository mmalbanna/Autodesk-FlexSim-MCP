#!/usr/bin/env node
// Stand-in for flexsim.exe: reads the /scriptpath wrapper, fakes each executestring step, writes results.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const script = readFileSync(args[args.indexOf("/scriptpath") + 1], "utf8");
appendFileSync(process.env.FAKE_LOG, `PID ${process.pid}\n` + JSON.stringify(args) + "\n" + script + "\n----\n");
const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "crash") process.exit(3);
else {
  const out = JSON.parse(script.match(/fileopen\((".*?"), "w"\)/)[1]);
  const res = { wrapper: "flexsim-mcp/1", console: "fake console", output: "" };
  for (const m of script.matchAll(/mcpres\["(\w+)"\] = executestring\((".*")\);/g)) {
    const code = JSON.parse(m[2]);
    // Real FlexSim runs the step's print(marker) first; "does not compile" skips that, returning 0.
    if (code.includes("does not compile")) { res[m[1]] = 0; continue; }
    res.output += code.match(/print\("(<<[^"]+>>)"\)/)[1] + "\n";
    res[m[1]] = code.includes("1 + 1") ? 2 : code.includes("runfunction") ? Number(code.match(/stoptime\(([\d.]+)\)/)[1]) :
      m[1] === "parameters_applied" ? "ok" :
      m[1] === "performance_measures" ? { Throughput: 123 } : m[1] === "table" ? { columns: ["A"], num_rows: 1, rows: [[5]] } : 1;
  }
  res.model_time = res.run_end_time ?? 0;
  writeFileSync(out.replace(/\//g, "/"), JSON.stringify(res));
  if (mode !== "linger") process.exit(0); else setInterval(() => {}, 1000);
}
