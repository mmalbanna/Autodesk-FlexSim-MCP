# Security

## What this server can do

This server runs on your computer with your Windows permissions, and there is **no sandbox**.

- **FlexScript can read and write files** with your full permissions. `flexsim_run_script` and the `setup_script` and `results_script` options of `flexsim_run_model` run whatever script they are given.
- **Models contain code.** FlexSim's documentation describes triggers that run when a model opens, so every tool that takes a model path can run code stored in that model. Only open models you trust.
- **An AI model writes the scripts.** Content that Claude reads elsewhere, such as a document or web page, could try to influence what it runs. Review scripts before approving them if your data is sensitive, and be careful about auto-approving these tools.
- **Paths can reach the network.** The server's own code makes no network requests, but a folder or model path like `\\server\share` makes Windows contact that machine, normally sending your Windows credentials to authenticate. FlexSim itself contacts Autodesk for licensing, and scripts can use the network.
- `flexsim_list_models` can search any folder you can read, and it returns file names, dates and sizes.

Temporary run files, which hold scripts and results, go in your own temp folder and are deleted after each run. A run killed from outside can leave them behind.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/mmalbanna/Autodesk-FlexSim-MCP/security/advisories/new) rather than a public issue. This is a volunteer project, so there's no guaranteed response time.

Report vulnerabilities in FlexSim itself to Autodesk.
