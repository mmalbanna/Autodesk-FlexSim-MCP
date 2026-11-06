# Roadmap

Ideas for future work, roughly in priority order. Open an issue before starting on anything large.

## Reliability

- **Keep background results across restarts.** Runs and their results live in the server's memory, so they're lost when it restarts. Measure the time limit in Chat, Cowork and the CLI too.
- **Background scripts.** `flexsim_run_script` has no background form yet.
- **Find out why the run after a force-stopped FlexSim fails.** The server retries once, but the cause is unknown, and the retry doesn't help if the server has restarted.
- **Stop before the run when a parameter can't be applied.** Today the error comes after the simulation finishes, which wastes time on a long run. The wrapper could skip its remaining steps.
- **Detect an ignored script quickly.** A marker written at the start of the wrapper would let the server fail within seconds if FlexSim never runs the script, rather than waiting for the time limit.
- **Clean up old run folders.** A run killed from outside leaves its temp folder behind. Sweep stale ones when the server starts.
- **Run the smoke test on Windows in CI.** Windows can't spawn a `.mjs` file as an executable, so this needs a small compiled stand-in for `flexsim.exe`.
- **Test performance measures bound to live statistics,** and consider the documented `Model.performanceMeasures` API.
- **Find out how a run behaves when FlexSim is signed out, or already open.**

## New capabilities

- **List parameters and performance measures.** A tool to discover what a model exposes, so what-if requests use the right names first time.
- **Replications.** Run a scenario with several random seeds and return the mean and spread, because a single stochastic run can mislead.
- **Scenario comparison.** Run a list of parameter sets and return a side-by-side table.
- **Experimenter and Optimizer access** through FlexSim's own tools.
- **Progress updates** during long runs, through MCP progress notifications.

## Distribution

- Verify and document the extension install and Cowork.
- Sign the `.mcpb` release file.
- Submit to the Claude extension directory.
- Test on more FlexSim versions and licence types.

## Security

- An optional read-only mode that disables arbitrary scripts.
- An optional allowlist of folders that models can be opened from.
