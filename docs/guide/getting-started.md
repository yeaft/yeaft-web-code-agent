# Getting Started

Yeaft has a browser/server control plane and one or more Agents. The Agent runs where the code lives and owns execution. The native Yeaft engine is bundled with the npm package; Claude Code and GitHub Copilot CLIs are optional runtimes.

## Requirements

- Node.js `>=22.5.0` on the server and Agent machine
- a modern browser
- at least one native LLM provider for Yeaft Sessions, or an installed/authenticated vendor CLI for that conversation path
- Docker for the recommended production server deployment

The install commands below use a POSIX shell and explicitly skip extra ONNX Runtime CUDA downloads while keeping CPU native dependencies and lifecycle scripts. Direct npm installation does not inherit the one-line installer policy. On Windows, use the [temporary PowerShell environment block](./deploy-agent.md#manual-npm-installation), which restores the previous setting. Node 24 is recommended for full digital-person hybrid recall.

## Fastest path: local mode

Local mode starts the bundled Web UI, Server, and Agent on `127.0.0.1`:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g @yeaft/webchat-agent
yeaft-agent local --name local
```

Open `http://127.0.0.1:6868`.

Local mode uses no Web authentication and listens on loopback. It is intended for a trusted single-machine evaluation, not direct public exposure. The explicit `--name local` selects the Agent instance and its default Yeaft directory, `~/.yeaft/instances/local/`.

In another shell, configure the same instance. The `llm` subcommand does not infer a named instance, so pass its config file:

```bash
YEAFT_CONFIG="$HOME/.yeaft/instances/local/config.json"
yeaft-agent llm setup --config "$YEAFT_CONFIG"
```

For GitHub Copilot-backed native models:

```bash
yeaft-agent llm use github-copilot --config "$YEAFT_CONFIG" \
  --model claude-sonnet-4.5 \
  --fast gpt-4.1
```

The native credential provider uses the local device/`gh auth` credential flow and does not write the token itself to config. The default service instance uses `~/.yeaft/config.json`; a custom `YEAFT_DIR` / `--yeaft-dir` uses `<yeaftDir>/config.json`.

## Connect to an existing server

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g @yeaft/webchat-agent
yeaft-agent --server wss://your-server.example --name my-worker --secret your-agent-secret
```

Install a managed service for reboot persistence:

```bash
yeaft-agent install --server wss://your-server.example --name my-worker --secret your-agent-secret
yeaft-agent status --name my-worker
```

Each `--name` is also the Agent instance identity. Separate instances resolve separate Agent-local Yeaft directories unless explicitly configured otherwise.

## Run from source

```bash
git clone https://github.com/yeaft/yeaft-web-code-agent.git
cd yeaft-web-code-agent
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
npm run dev
```

Open `http://localhost:3456`.

Useful verification commands:

```bash
npm test
npm run test:e2e
npm run release:guard
npm run build
npm run docs:build
```

## Create your first native Session

1. Confirm the Agent is online.
2. Choose **New chat** in the unified sidebar.
3. Select **Yeaft** and the target Agent.
4. Choose a working directory.
5. Select one or more VPs and a default VP.
6. Create the Session.
7. After creation, choose model/effort in the composer and edit the announcement in Session settings, then send a message.

Use one VP for a conventional coding-assistant workflow. Add more VPs only when independent roles are useful; use `@mentions` to select who handles each turn.

## Try Work Center

Open **Work Center** from the sidebar, or create a WorkItem from the Yeaft Session composer. Give it a concrete goal, acceptance criteria, and working directory. Work Center persists its own Coordinator conversation and planned Action graph on the selected Agent.

## Optional CLI runtimes

To create Claude Code or GitHub Copilot conversations, install and authenticate the matching CLI on the Agent machine. The Agent detects supported runtimes and exposes them in the creation UI. Native Yeaft Sessions do not require either vendor CLI.

## Next steps

- [Choose a code agent path](./user/choose-backend.md)
- [Yeaft Sessions and Projects](./user/yeaft-session.md)
- [Work Center](./user/work-center.md)
- [Agent and native CLI reference](./agent-cli.md)
- [Provider/model configuration](./yeaft-config.md)
- [Deploy the server](./deploy-server.md)
- [Install Agents](./deploy-agent.md)
