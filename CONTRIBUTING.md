# Contributing

Thanks for helping. Bug reports with real FlexSim versions and licence types are especially useful, because they can't be tested automatically.

## Setup

You need Node.js 22.18 or newer for development. The built server declares Node.js 20 as its minimum.

```bash
git clone https://github.com/mmalbanna/Autodesk-FlexSim-MCP.git
cd Autodesk-FlexSim-MCP
npm ci
npm run build
npm test
```

## Project layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | MCP tool definitions |
| `src/flexsim.ts` | Finding, launching and talking to FlexSim |
| `test/unit.test.mjs` | Fast tests with no dependencies |
| `test/smoke.mjs`, `test/fake-flexsim.mjs` | Protocol tests against a stand-in for FlexSim |
| `test/integration.mjs` | End-to-end tests against real FlexSim |
| `bundle/` | `manifest.json` and icon. `bundle/server/` is build output. |
| `docs/` | Architecture, troubleshooting and roadmap |

**Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.** FlexSim has several silent failure modes, and that file explains the ones this code works around.

## Testing

```bash
npm test                                            # unit tests
npm run build                                       # needed before the two below
npm run test:smoke                                  # protocol tests (Linux or macOS)
npm run test:flexsim -- "C:\path\to\model.fsm" --gui   # real FlexSim (Windows)
```

The integration test copies the model, never modifies your original, and works with FlexSim's installed tutorials, such as `StatisticsCollectorTutorialModel.fsm` in your FlexSim projects folder. Use `FLEXSIM_EXE` to test a specific version. It opens a FlexSim window with `--gui`, which you close yourself, and it deliberately force-stops FlexSim a few times.

**If you have FlexSim, run the integration test on any change that touches how FlexSim is launched or any FlexScript.** CI can't do this, and the fake can't catch FlexSim-specific behaviour. Please say in your pull request which FlexSim version you tested. If you don't have FlexSim, say so, and a maintainer will run it.

When you find new FlexSim behaviour, test it rather than assuming, add a regression test, and record it in `docs/ARCHITECTURE.md`.

## Adding a tool

1. Register it in `src/index.ts` with `server.registerTool`. Write the description for Claude: it's how Claude decides when and how to use the tool, so include a working example. **Run every FlexScript example against real FlexSim.**
2. Set the annotations honestly. A tool that accepts scripts isn't read-only.
3. Report failures with `isError: true` and a message that says what to do next. Never return something that could be mistaken for a valid result.
4. Add it to `tools` in `bundle/manifest.json`, the table in `README.md`, the expected list in `test/smoke.mjs` and `test/integration.mjs`, and an integration step.

## Pull requests

Keep each one focused, add a test for each bug fix, and add a line to the `Unreleased` section of `CHANGELOG.md`.

## Releasing

1. Update the version in `package.json` (and with `npm install` in the lockfile), `bundle/manifest.json` and `VERSION` in `src/index.ts`. A unit test checks that they match.
2. Move the `Unreleased` entries in `CHANGELOG.md` under the new version.
3. Run the integration test on real FlexSim, with `--gui`.
4. Commit, then tag and push:

   ```bash
   git tag v1.2.3
   git push origin main v1.2.3
   ```

The release workflow then builds `flexsim-mcp.mcpb` and publishes it on a GitHub release.

## Code of conduct

Be kind and assume good intent. Harassment isn't welcome here.
