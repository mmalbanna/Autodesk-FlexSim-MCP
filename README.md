# MCP server for Autodesk FlexSim (unofficial)

Run [Autodesk FlexSim](https://www.autodesk.com/products/flexsim) simulation models from Claude. Ask for a what-if run in plain language, and Claude opens your model without a window, sets its parameters, runs it, and reports the results.

> **Unofficial community project, not affiliated with or endorsed by Autodesk.** Autodesk and FlexSim are trademarks of Autodesk, Inc., used here only to say which product this server works with. You need your own licensed copy of FlexSim, and its licence terms apply to everything you run through this server.

## What you can ask

- "Find the FlexSim models in my Documents folder."
- "Run `Line1.fsm` for an 8-hour shift and show the performance measures."
- "Compare 3 and 4 operators on this model."
- "What's in the `Schedule` table of this model?"
- "List the objects in this model."

Each run is one replication. If your model has randomness, a difference between two single runs may just be chance, so run several seeds before drawing conclusions.

## Tools

| Tool | What it does |
| --- | --- |
| `flexsim_check_installation` | Finds FlexSim installs and runs a headless smoke test. Start here if anything fails. |
| `flexsim_run_model` | Runs a model to a stop time, with optional parameters, and returns performance measures and script results. For runs that finish in well under a minute. |
| `flexsim_start_run` | Starts the same run in the background and returns at once. For anything longer. |
| `flexsim_get_run` | Checks a background run, and returns its results when it finishes. |
| `flexsim_cancel_run` | Stops a background run. |
| `flexsim_run_script` | Runs any FlexScript, with or without a model. |
| `flexsim_read_table` | Reads a Global Table without running the simulation. |
| `flexsim_list_models` | Finds `.fsm` files in a folder. |
| `flexsim_open_in_gui` | Opens the normal FlexSim window so you can watch or edit a model. |

Each server handles one headless run at a time, with a time limit. The server stops FlexSim if it overruns or the call is cancelled.

## Requirements

- Windows
- FlexSim, installed and licensed. Open it normally once to confirm it works.
- [Node.js](https://nodejs.org) 20 or newer, for Options 1 and 3 below. Tested on Node.js 26. Older versions are covered by [automated protocol tests](.github/workflows/ci.yml) only.

## Install

Download `flexsim-mcp.mcpb` from the [latest release](https://github.com/mmalbanna/Autodesk-FlexSim-MCP/releases/latest), then choose **one** option. Using more than one in the same app can make the tools appear twice.

For Options 1 and 3, first unpack the server. A `.mcpb` file is a zip archive, so rename a copy to `.zip` and extract it to a permanent folder such as `C:\Users\YOUR-NAME\.flexsim-mcp`. Then check that `server\index.mjs` is inside that folder. Replace `YOUR-NAME` below with your Windows user name.

### Option 1: Settings file (Claude Desktop)

1. In Claude Desktop, open **Settings > Developer > Edit Config**.
2. Add the `flexsim` entry to `claude_desktop_config.json`. If the file already has an `mcpServers` section, put the entry inside it:

   ```json
   {
     "mcpServers": {
       "flexsim": {
         "command": "C:\\Program Files\\nodejs\\node.exe",
         "args": ["C:\\Users\\YOUR-NAME\\.flexsim-mcp\\server\\index.mjs"],
         "env": { "FLEXSIM_TIMEOUT_SECONDS": "600" }
       }
     }
   }
   ```

3. Quit Claude completely and reopen it.

Use the full path to `node.exe`, because desktop apps don't always inherit your terminal's `PATH`.

### Option 2: Claude Desktop extension

Not yet verified by this project. In Claude Desktop, open **Settings > Extensions > Advanced settings > Install Extension** and choose the `.mcpb` file. You can then set the FlexSim path and time limit in the extension's settings. Reports on how this goes are welcome.

### Option 3: Claude Code CLI

```bash
claude mcp add flexsim --scope user -- "C:\Program Files\nodejs\node.exe" "C:\Users\YOUR-NAME\.flexsim-mcp\server\index.mjs"
```

### Check it works

Ask Claude: **"Run the FlexSim smoke test."** You should get `smoke_test: passed` within about a minute. If not, see [Troubleshooting](docs/TROUBLESHOOTING.md).

## Long runs

**Claude apps stop waiting for a single call after a limit of their own, and when they cancel a call, FlexSim is stopped too.** In Claude Desktop's Code tab, that limit was measured somewhere between 50 and 90 seconds. Raising `timeout_seconds` doesn't change it, because that setting only controls when the server itself stops FlexSim.

So long simulations run in the background. `flexsim_start_run` returns straight away, and `flexsim_get_run` collects the results across as many calls as it takes, so just ask Claude to run the model and tell it the run may be long. A 94-second run was tested this way through the Code tab. A few things to know:

- FlexSim runs one at a time. While a background run is going, other FlexSim calls are refused with a message saying so, and further `flexsim_start_run` calls wait in line.
- Background runs have a default limit of one hour, and up to two hours with `timeout_seconds`.
- A run belongs to its server, which usually means one Claude session. Quitting Claude stops FlexSim and loses the run, so results aren't kept.

## Settings

| Environment variable | Meaning | Default |
| --- | --- | --- |
| `FLEXSIM_EXE` | Path to `flexsim.exe` | Newest installed version |
| `FLEXSIM_TIMEOUT_SECONDS` | Default time limit for a run, 30 to 7200 | `600` |
| `FLEXSIM_MCP_WORKDIR` | Folder for temporary run files | `flexsim-mcp` in your temp folder |

Leave `FLEXSIM_EXE` unset and the server moves to a new FlexSim version automatically when you install one. If it's set to a path that doesn't exist, the server uses the newest install instead; check `exe_in_use` and `exe_source` in the smoke test output.

## Tested with

| Component | Status |
| --- | --- |
| FlexSim 2027 | Unit and real-FlexSim integration tests pass |
| FlexSim 2024 Update 2 | Unit and real-FlexSim integration tests pass, except opening the visible window, which wasn't run on this version |
| Windows 11, Node.js 26 | As above |
| Performance measures | Tested on a default measure only, not yet on one bound to live statistics |
| Claude Code CLI | Connects |
| Claude Desktop, Code tab | Works through the settings file |
| Claude Desktop, Chat | Not yet verified. Anthropic documents that the settings file feeds it too. |
| Claude Desktop extension install, Cowork | Not yet verified. Reports welcome. |

## Security

**FlexScript has full access to your computer**, and this server adds no sandbox. A script can read and write files with your Windows permissions, and opening a model can run code stored in it. Review what Claude proposes to run if your models or data are sensitive. See [SECURITY.md](SECURITY.md).

## Documentation

- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Architecture and FlexSim behaviour notes](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Licence

[MIT](LICENSE). This licence covers this server only, not FlexSim. The release file includes the licences of the code bundled into it.
