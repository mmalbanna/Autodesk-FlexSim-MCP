# Troubleshooting

Start by asking Claude to **run the FlexSim smoke test**, or call `flexsim_check_installation` with `smoke_test: true`. It shows which FlexSim is in use and whether scripts run.

## The tools don't appear in Claude

1. Quit Claude completely, including from the system tray, and reopen it. Config changes only load at start-up.
2. Check **Settings > Developer** in Claude Desktop for the server's status.
3. Confirm the two paths in your config exist. Use the full path to `node.exe`, with doubled backslashes in JSON.
4. Test the server directly. It should print `flexsim-mcp … running on stdio` and wait, so press Ctrl+C to stop it. In PowerShell:

   ```powershell
   & "C:\Program Files\nodejs\node.exe" "C:\Users\YOUR-NAME\.flexsim-mcp\server\index.mjs"
   ```

5. For the Claude Code CLI, run `claude mcp get flexsim`.

## A call stops after about a minute, or says it was cancelled

The Claude app may have stopped waiting, which also stops FlexSim. Raising `timeout_seconds` doesn't change this. See [Long runs](../README.md#long-runs).

## "FlexSim did not finish within … s"

The server's own time limit was reached.

1. If the model is just slow, shorten `run_time` or raise `timeout_seconds` (up to 7200). `FLEXSIM_TIMEOUT_SECONDS` sets the default. The smoke test's limit is fixed at 120 seconds.
2. Check that FlexSim is signed in and licensed by opening it normally.
3. Open the model with `flexsim_open_in_gui` and look for prompts or errors.

## An Autodesk Error Report window appears

FlexSim itself crashed, and you can close the window. Check whether the same model opens normally with `flexsim_open_in_gui`. If it does and the problem repeats, please [report it](https://github.com/mmalbanna/Autodesk-FlexSim-MCP/issues).

## "FlexSim exited … without writing results"

Run the smoke test. If it passes, the problem is specific to that model, so open it with `flexsim_open_in_gui`. If it fails:

- **Licence:** open FlexSim normally and confirm that you're signed in and it's licensed. How a headless run behaves when signed out hasn't been tested.
- **Wrong version:** the server uses the newest install. Set `FLEXSIM_EXE` to choose another. A model saved in a newer version generally won't open in an older one.

## "FlexSim executable not found"

Your FlexSim may be installed somewhere other than `C:\Program Files`. Set the `FLEXSIM_EXE` environment variable in your config, or the **FlexSim executable** setting if you use the extension, to the full path of `flexsim.exe`.

## "FlexSim could not compile your script"

The script has a syntax error or a misspelled command, class or property. FlexSim gives no further detail through this route, so try the script in FlexSim's **Script Console**.

## "These results do NOT reflect the requested scenario"

A parameter value wasn't applied, so the results would be misleading. Either the name doesn't exist in the model, or FlexSim refused the value and substituted another, for example because it's out of range. Parameter names are case sensitive. They're defined in the model's **Model Parameter Tables**.

## "raised an exception"

The script threw an error while running, and `flexsim_console` has FlexSim's message.

## A run stops early, with a warning

`Model stopped at …` means the model ran out of events or has an earlier stop time. Check that the model produces work for the whole run.

## A script's result is `0` or `null`

A script with no `return` statement gives `0`. A result of `null` can come from a value that isn't a real number, such as a division by zero.

## Asking for help

Please [open an issue](https://github.com/mmalbanna/Autodesk-FlexSim-MCP/issues) with the smoke test output and your FlexSim and Windows versions. **Check for private paths and model names before posting**, and don't attach a model you can't share.
