# Changelog

This project follows [Semantic Versioning](https://semver.org).

## Unreleased

## 1.1.0 - 2026-11-06

### Added

- **Background runs, so long simulations survive client time limits.** `flexsim_start_run` returns at once, `flexsim_get_run` collects the results, and `flexsim_cancel_run` stops a run. Claude Desktop's Code tab was measured stopping calls somewhere between 50 and 90 seconds.

### Changed

- While a background run is going, direct FlexSim calls are refused at once with a clear message, rather than waiting behind it until the client gives up.
- FlexSim is stopped when the client closes the connection or the server is asked to stop, rather than being left running.

## 1.0.1 - 2026-11-06

The first published version, and the first that works with real FlexSim.

### Fixed

- **Every run timed out.** The server's temp path contains hyphens, and FlexSim silently ignores an unquoted `/scriptpath` containing a hyphen. Paths are now always quoted.
- **FlexSim crashed at start-up under some hosts, opening an Autodesk Error Report window.** FlexSim 2027 crashes when `ProgramData` and `ALLUSERSPROFILE` are both missing, and MCP hosts may strip them. The server now restores them.
- **What-if runs could silently use the wrong values.** A misspelled parameter, or a value FlexSim refuses and replaces, is now an error.
- **A script that didn't compile returned `0`, which looked like a real answer.** It's now an error.
- **Exceptions in scripts returned success.** `flexsim_run_script` and `flexsim_run_model` now report them as errors. An exception during the simulation itself is a warning, with the results kept.
- **A missing Global Table returned an empty table.** It's now an error.
- **The run after a force-stopped FlexSim failed.** The server now retries it once.
- **A call cancelled while queued still launched FlexSim.** It now returns without starting.
- **`print()` output was lost.** It now comes back as `flexsim_output`.
- **Two documented FlexScript examples didn't work.** Both are corrected and tested.
- **Very large numbers produced FlexScript that didn't compile.**
- **Truncation could hide errors, and didn't limit structured results.** Status fields now come first, and truncation applies to both forms.
- A path containing a double quote could add switches to FlexSim's command line. It's now refused.
- Run files could go to a machine-wide folder when the temp path contained a space. They now always go to your own temp folder.
- `flexsim_list_models` could block the server, and reported success for a file or an incomplete search.
- A failure to start `taskkill` or FlexSim's window could crash the server.

### Changed

- Tool annotations now reflect what the tools can do. `flexsim_run_model` is marked as destructive and open-world, like `flexsim_run_script`. `flexsim_read_table` and `flexsim_open_in_gui` are no longer marked read-only.
- The extension is named "FlexSim MCP (unofficial)", and its FlexSim path no longer defaults to one version.
- The release file now includes licence texts.
- Removed the author's email address from the manifest.

### Added

- An integration test suite that runs every tool against real FlexSim.
- Documentation, continuous integration, and an automated release workflow.

### Known limits

- Claude apps may stop waiting for a call well before `timeout_seconds`, which also stops FlexSim. See [Long runs](README.md#long-runs).

## 1.0.0 - 2026-11-06

Initial version, not published.
