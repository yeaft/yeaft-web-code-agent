# Yeaft Web Code Agent

[![CI](https://github.com/yeaft/yeaft-web-code-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/yeaft/yeaft-web-code-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@yeaft/webchat-agent)](https://www.npmjs.com/package/@yeaft/webchat-agent)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://ghcr.io/yeaft/yeaft-web-code-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-green)](package.json)

[English](README.md) | [中文](README.zh-CN.md) | [Documentation](https://yeaft.github.io/yeaft-web-code-agent/)

Yeaft is a web control plane for code agents running on your own machines. One browser can connect to multiple Agents, open Claude Code or GitHub Copilot CLI conversations, and run Yeaft's native multi-provider engine with durable Sessions, reusable Virtual Persons (VPs), scoped memory, Projects, and Work Center.

**Try the hosted service:** [cc.yeaft.com](https://cc.yeaft.com)

![A Yeaft Session with an implementation and independent review handoff](docs/images/session.png)

## Why Yeaft

- **Keep execution near the code.** Shell commands, files, Git operations, providers, credentials, Session data, and Work Center state stay on the connected Agent machine. The server authenticates users and relays browser-to-Agent traffic.
- **Use the right runtime for each task.** Claude Code CLI, GitHub Copilot CLI over ACP, and the native Yeaft engine share one Web UI without pretending they have identical behavior.
- **Scale a Session from one VP to many.** A native Yeaft Session is the only collaboration unit: use one VP for focused work, or address several VPs for parallel implementation, review, research, or design.
- **Carry context deliberately.** Native Sessions use a bounded window of their own persisted turns; Project instructions remain separate and sibling transcripts are not injected automatically.
- **Move long work out of a chat turn.** Work Center persists a goal as a WorkItem, lets an AI planner create a validated Action graph, assigns Actions to VPs, records Runs and tool evidence, and can continue after a browser disconnect or Agent restart.

## Product model

| Concept | What it means |
| --- | --- |
| **Agent** | A Node.js worker on a laptop, VM, server, or container. It owns execution, local configuration, and native Yeaft runtime data. |
| **Session** | A durable native Yeaft conversation with 1..N VPs, one message timeline, a working directory, model override, and announcement. |
| **VP (Virtual Person)** | A reusable persona with localized metadata, traits, prompt, and a primary/fast model hint. A VP is a role, not a separate machine. |
| **Project** | A browser-visible grouping of native Sessions. It carries a shared Project instruction without merging or automatically injecting sibling Session transcripts. |
| **Work Center** | An Agent-level durable task system. A WorkItem has a contract and conversation; planned Actions are executed as fenced Runs with status, evidence, retries, human input, and review outcomes. |

Some internal wire types and storage paths retain historical names such as `group`, `unify_*`, or `claude_output` for compatibility. They are not current product terminology.

## Three execution paths

| Path | Runtime and strengths | Important boundary |
| --- | --- | --- |
| **Claude Code** | One Claude Code CLI process per conversation; Claude Code tools, skills, MCP, compact/clear, sub-agent events, and resume behavior | Requires a locally installed and authenticated Claude Code CLI |
| **GitHub Copilot** | One `copilot --acp` process per conversation; Copilot model catalog and explicit tool-permission prompts | Requires the Copilot CLI and an eligible GitHub Copilot account |
| **Yeaft Code Agent** | Native engine inside `yeaft-agent`; 1..N VPs, 33 built-in tools, provider routing, bounded Session history, Projects, sub-agents, and Work Center handoff | Does not emulate every Claude Code or Copilot CLI command |

The Web UI also includes a terminal, Git status/diff, file browser/editor, port proxy, split-screen CLI conversations, an Expert Panel for Claude Code conversations, usage administration, light/dark themes, and English/Chinese localization.

### Math in Markdown messages

Markdown messages render LaTeX formulas locally with KaTeX: use `$E=mc^2$` or `\(E=mc^2\)` inline, and `$$...$$` or `\[...\]` for display equations (including multiple lines). Code spans and code blocks stay literal. Unsupported formulas remain readable source text; long equations scroll horizontally on narrow screens. This supports KaTeX's math syntax, not complete LaTeX documents, and requires no runtime CDN.

## Current native Yeaft capabilities

### Sessions and Projects

- Create a Session with an Agent, working directory, roster, and default VP. After creation, choose model/effort in the composer and edit the announcement in Session settings.
- Address one or more VPs with `@mentions`; selected VPs execute the same turn independently and can hand work to a peer with `RouteForward`.
- Search and page durable Session history, and inspect per-VP turns, running background tasks, model choice, tool calls, token usage, and stop reasons.
- Organize native Sessions into Projects, drag them between Project and Recents sections, and attach a Project instruction to all member Sessions.
- Start a persistent WorkItem from the current Session; origin identity is stamped by the runtime.

### Providers, tools, and context

- Native adapters support Anthropic Messages and OpenAI Responses protocols.
- A configured provider can use a static API key or a dynamic GitHub Copilot credential provider. Per-model protocol, context window, output limit, and reasoning-effort metadata are supported.
- The current native registry exposes **33 built-in tools** for files/patches, shell and background jobs, Git worktrees, search, Web access, images, notebooks, planning, persistent work creation, and sub-agent/VP orchestration. Skills and MCP can extend that registry.
- Provider context uses a bounded, disposable window of the current Session’s persisted turns. Post-turn compact remains a separate history-window optimization; it does not reactivate Dream or H2-AMS memory.

### Digital Person (experimental)

The sidebar **Digital Person** entry opens an independent message/input page with **Think**, explicit **Dream**, cancellation, and paginated application-level **Trace**. It has no Session list and creates neither a hidden Session nor a WorkItem. Think recalls messages/concepts, reorganizes experiences, proposes associations, and records self-checks and versioned conclusions. Trace shows explicit inputs, outputs and revisions, not a provider's hidden reasoning. Sending a new message aligns the waiting state and the start of its AI reply at the top of the message pane, leaving older messages above the viewport. Growing replies do not chase the bottom; scrolling lets you freely read history or a long reply.

**Outputs** opens a lightweight, read-only preview beside the conversation: view delivered Markdown, images, text/code and isolated static HTML, download PDFs, or preview a web link with an always-available external-open action. The reader shows only opened file/web tabs, never thought/task/memory tabs; delivery history is available on demand. Resize the panel, expand it to full screen, or close it without deleting results or stopping tasks; narrow screens use a full-screen preview. Files are explicitly delivered through `Output.publish`, snapshotted in owner-scoped SQLite, and remain available after source changes or restart. There is no directory tree, editor, Terminal or Git in this view. See [output preview and delivery boundaries](docs/person-outputs.md).

Try it on a **new, isolated Agent instance**: SQLite is the only storage backend and needs no separate database service. SQLite at `<yeaftDir>/person/person.db` owns messages, concepts, episodes, state and Trace; `<yeaftDir>/person/recall.db` is a separate, rebuildable search index, not another memory authority. Agent-managed workers share the Agent lifecycle; exiting stops computation, not persistent memory. Data is isolated by authenticated owner and deployment namespace. Scenes are views/scopes within that authority, not separate databases. Configure a native API model in the instance's `<yeaftDir>/config.json` with `yeaft-agent llm setup --config <path>`; keep credentials out of the browser and chat.

Recall on SQLite combines Chinese/English keyword FTS5 with local vector cosine ranking and RRF. The default embedding model is **multilingual-e5-small**, pinned q8 ONNX via `@huggingface/transformers` on CPU, cached in `<yeaftDir>/person/models`. Only the first explicit, nonempty Recall may download model files; opening the page, ordinary startup and empty Recall do not. Use `YEAFT_PERSON_EMBEDDING=off` to disable embeddings, or `YEAFT_PERSON_EMBEDDING_DOWNLOAD=0` to prohibit downloads (an already cached model can still run). Embedding inference and search stay local; model-file downloads contact Hugging Face, and the cognitive LLM still uses the configured provider, which may be remote. Missing model/index support reports fallback metadata, not fake semantic results. Vector search is bounded exact scanning, not ANN or a million-record performance promise; Trace is not vector-indexed. Node 24 is recommended for full FTS5/hybrid recall. Early supported Node 22 builds without FTS5 keep SQLite authority and literal recall, report `FTS_UNAVAILABLE`, and do not start embeddings. Model artifacts are size/SHA-256 verified and atomically published; interrupted downloads are retried on a later explicit Recall. Ignored `.partial` files may remain after a forced process exit.

**Storage is instance-local only.** The service always uses SQLite under the instance's `yeaftDir`; storage-backend selection and external database configuration are no longer supported. Existing external database data is neither migrated nor deleted; a new local SQLite database is not a migration result. Back up `person.db` consistently, including uncheckpointed WAL writes rather than copying only the active main file. Environment changes on an existing service require an explicitly authorized restart; this feature does not restart it automatically.

The feature remains **manual only**: no idle timer, event Connector, VP delegation or Rust desktop body yet. Its default capability catalog includes **14 real Session-native tools** for file reading/writing/editing, search, directories, patches, Git inspection, foreground Bash, Web search/fetch, the existing Skill library and notebooks. They reuse native schemas and executors on the Agent's configured work directory; they are host operations, **not a filesystem or shell sandbox**. Tools are discovered/prepared within the existing bounded capability layers rather than inserting every full schema into every prompt. No Session TaskManager, background Bash or Session-specific orchestration is registered. Cancellation joins local execution but does not undo completed effects. The directory also has four cognitive methods plus a foundational `Capability.create`: it writes parameterized JSON-to-JSON JavaScript, runs supplied tests in limited QuickJS/WASM workers, and atomically publishes passing private `Script.*` versions for discovery and reuse after restart. Failed tests do not publish; generated scripts still get no host files, network, Shell or credentials. A published version remains durable independently of the later cognitive commit; passing self-authored tests is not proof of general correctness. Each activity allows at most 16 model calls / 120 seconds by default; the Person may choose subsequent models from up to eight configured native models. Dynamic effort requires `YEAFT_THINKING_V1=1` and supported model metadata. Persistent memory and bounded model context remain distinct. See the [design and implementation boundary](docs/notes/2026-09-24-digital-person-design.md#本轮实现边界显式认知首版) for transaction, retrieval and remaining-work details.

### Work Center

![Work Center showing a persistent WorkItem, its conversation, and Action graph](docs/images/work-center.png)

Work Center is for goals that must survive beyond one interactive turn. Its current implementation provides:

- a durable WorkItem contract (`goal`, acceptance criteria, working directory, attachments, and memory-reuse policy); attachment storage supports Linux, macOS, and Windows with Agent-local type, size, ownership, path, symlink, and content-integrity checks;
- a WorkItem-level Coordinator conversation for status questions, guidance, contract changes, and replanning;
- AI-planned Action graphs with validated dependencies, one final acceptance gate, and up to the configured concurrent Action limit;
- automatic/pool/fixed VP assignment, model and effort policies, review separation, retry/waiting/failed states, and explicit human recovery input;
- shared, read-only, isolated-write, and integrate workspace policies, with fenced Runs and retained tool evidence;
- Agent-local SQLite persistence and restart recovery. WorkItems are linked to their source Session but are not stored inside that Session.

Work Center does **not** mean arbitrary unattended deployment. Side effects still depend on the tools, repository policy, credentials, and delivery instructions available to the selected Agent and VP.

## Quick start

### Local, single-machine evaluation

Install the published Agent package, then start its bundled local Web UI, Server, and Agent on loopback. On Linux / macOS (POSIX shell):

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g @yeaft/webchat-agent
```

On Windows PowerShell, use a temporary environment variable and restore it after installation:

```powershell
$previousCuda = $env:ONNXRUNTIME_NODE_INSTALL_CUDA
try {
  $env:ONNXRUNTIME_NODE_INSTALL_CUDA = 'skip'
  npm install -g @yeaft/webchat-agent
} finally {
  $env:ONNXRUNTIME_NODE_INSTALL_CUDA = $previousCuda
}
```

The recommended install defaults to CPU: `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` skips ONNX Runtime's extra CUDA binary download, not npm lifecycle scripts. Installation still downloads the optional `@huggingface/transformers` npm package and native dependencies such as ONNX Runtime; Recall model files may download only on the first explicit, nonempty Recall. Do not substitute `--ignore-scripts`, which can break native dependencies. If optional dependencies fail to install or are omitted, Recall reports a fallback. `YEAFT_PERSON_EMBEDDING_DOWNLOAD=0` controls model downloads, not npm installation.

`yeaft-agent local` uses a named Agent instance. Without `--name`, the name is the sanitized computer hostname; this example makes it explicit:

```bash
yeaft-agent local --name local
```

Open `http://127.0.0.1:6868`. Local mode disables Web authentication and binds to loopback, so use it for a trusted workstation rather than as a public deployment.

In another shell, configure the same instance. The `llm` subcommand does not infer it, so pass the config path explicitly:

```bash
YEAFT_CONFIG="$HOME/.yeaft/instances/local/config.json"
yeaft-agent llm setup --config "$YEAFT_CONFIG"
```

A GitHub Copilot-backed native provider can use local `gh auth` / device credentials without writing the token itself into the instance config:

```bash
yeaft-agent llm use github-copilot --config "$YEAFT_CONFIG" \
  --model claude-sonnet-4.5 \
  --fast gpt-4.1
```

The default service instance is the exception: it uses `~/.yeaft/config.json`. A custom `YEAFT_DIR` / `--yeaft-dir` requires the matching `<yeaftDir>/config.json` path.

Claude Code and Copilot CLI conversations require their corresponding CLI to be installed and authenticated separately.

### Connect an Agent to an existing server

Recommended: open **Settings → Security**, choose **Linux / macOS** or **Windows PowerShell**, and copy the one-line installer command. It checks Node.js/npm, installs the Agent in an isolated user directory, and starts a new instance named `<hostname>-<four random digits>` with your server address and Secret. Existing Node installations and running Agents are not replaced. Only the npm install step defaults `ONNXRUNTIME_NODE_INSTALL_CUDA` to `skip`; an explicit nonempty caller value is preserved (it may download GPU binaries but does not change Recall CPU inference). See [Agent Setup](docs/guide/deploy-agent.md) for platform requirements, security notes and management commands.

Manual alternative (Linux / macOS; for PowerShell, use the temporary environment variable above):

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g @yeaft/webchat-agent
yeaft-agent --server wss://your-server.example --name my-worker --secret your-agent-secret
```

Install it as a managed system service when the machine should reconnect after reboot:

```bash
yeaft-agent install --server wss://your-server.example --name my-worker --secret your-agent-secret
yeaft-agent status --name my-worker
```

### Workbench Browser

Workbench Browser opens HTTP/HTTPS pages directly in a client-side iframe, including links from responses, Markdown previews, and WorkItem outputs. It does not install or stream an Agent browser, use WebRTC, or proxy pages through the Server. No Agent browser capability is required.

Use the address bar, **Refresh**, or **Open in new tab**. `localhost` refers to your device, not the Agent. Some websites block iframe embedding; sandbox restrictions may also limit sign-in or interactions, and HTTPS may block HTTP pages. Yeaft does not bypass these browser restrictions. Ctrl/Cmd-click keeps the native new-tab behavior.

Legacy Agent Browser Runtime CLI/configuration is retained for compatibility, but this Workbench view does not use it. See [Workbench: Browser](docs/guide/user/workbench.md#browser).

### Run from source

```bash
git clone https://github.com/yeaft/yeaft-web-code-agent.git
cd yeaft-web-code-agent
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
npm run dev
```

Then open `http://localhost:3456`.

## CLI surfaces

The npm package installs two primary commands:

- `yeaft-agent` runs or manages the Web-connected worker and local mode. Its `llm` subcommand edits the explicit `--config` path, or `~/.yeaft/config.json` by default; it does not infer a named running instance.
- `yeaft` runs the native engine directly from a terminal. One-shot/interactive text mode can target an **existing** formal Web Session with `--session-id`. `stream-json` can also use a new validated ID as an ad-hoc CLI conversation key. Its first JSONL user prompt may opt into a formal Session by supplying `roster` (or the identical `vps` alias) and an optional `defaultVpId`; the CLI then writes canonical `session.json` metadata and emits aggregate VP results. Later prompts cannot change that roster.

Example machine-readable ad-hoc CLI conversation:

```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Inspect this repository and report the test command."}}' \
  | yeaft --session-id session_docs \
      --cwd "$PWD" \
      --input-format stream-json \
      --output-format stream-json
```

The ID scopes persisted CLI messages; it is not a newly created Web Session. To execute an existing multi-VP Session, pass its existing Session ID. See the [Agent and native CLI reference](docs/guide/agent-cli.md) for the exact current commands and JSONL boundary.

## Architecture and ownership

```text
Browser (Vue 3 + Pinia)
        │ authenticated WebSocket relay (WSS in production)
        ▼
Server (Express + ws + SQLite)
        │ owner-checked relay and browser-facing catalog
        ▼
Agent (Node.js on the code machine)
        ├── Claude Code CLI provider
        ├── GitHub Copilot CLI provider (ACP)
        ├── Native Yeaft engine
        │   ├── Session + VP orchestration
        │   ├── Anthropic / OpenAI Responses adapters
        │   ├── 33 built-in tools + Skills + MCP
        │   ├── bounded Session history + post-turn compact
        │   └── Work Center (WorkItem → Action → Run)
        └── Workbench (terminal, Git, files, port proxy)
```

The server owns authentication, user-visible catalog metadata, and relay state. The Agent owns code execution and Agent-local Yeaft runtime data. A Session `workDir` selects project context; it does not become the storage root for Session transcripts, memory, tasks, or Work Center records.

## Configuration and deployment

- **Runtime requirement:** Node.js `>=22.5.0`; release CI uses Node.js 24.
- **Agent config:** each Agent instance resolves its own Yeaft directory and `config.json`. Provider credentials are not a server-global setting.
- **Server:** Docker is the recommended production path. Set non-default authentication secrets, create the first administrator, terminate TLS at a reverse proxy, and persist the server data directory.
- **Registration:** the current production route accepts open registration. Invitation administration remains in the codebase, but an invitation code is not currently required by `server/auth/register.js`.
- **Security boundary:** the product supports password/JWT authentication, optional TOTP and email verification, per-user Agent secrets, and owner-checked relay. Current Web/Agent peers negotiate plaintext JSON payloads, so production deployments must use HTTPS/WSS; TweetNaCl payload encryption remains only as a compatibility fallback for legacy peers. Treat raw debug traces, tool outputs, attachments, and local provider credentials as sensitive Agent data.

Detailed guides:

- [Getting started](docs/guide/getting-started.md)
- [Yeaft Sessions and Projects](docs/guide/user/yeaft-session.md)
- [Work Center](docs/guide/user/work-center.md)
- [Provider and model configuration](docs/guide/yeaft-config.md)
- [Architecture](docs/guide/tech/architecture.md)
- [Security](docs/guide/security.md)
- [Server deployment](docs/guide/deploy-server.md)
- [Agent installation](docs/guide/deploy-agent.md)

## Development and verification

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
npm test                 # core Vitest suite
npm run test:e2e         # Playwright browser suite
npm run release:guard    # server/Agent import guard + startup smoke
npm run build            # production Web assets
npm run docs:build       # bilingual VitePress site
```

At this revision, the core manifest contains 49 Vitest files / 499 listed tests, and the E2E tree contains 11 Playwright spec files. These counts are descriptive, not a compatibility promise.

The repository uses ES modules, Node.js 22.5+, plain JavaScript with JSDoc, Vue 3 + Pinia, Express + `ws`, SQLite, esbuild, Vitest, Playwright, and VitePress.

## Documentation and compatibility

Published user documentation is bilingual. English pages live under `docs/guide/`; Chinese counterparts live under `docs/zh-CN/guide/`. Internal design notes under `docs/notes/` and `docs/work-center/` may describe migrations or historical decisions and should not be treated as the public feature contract.

The canonical repository is [github.com/yeaft/yeaft-web-code-agent](https://github.com/yeaft/yeaft-web-code-agent). Historical package names and image aliases remain where changing them would break installations.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Keep changes small, preserve compatibility boundaries, add focused tests, and verify documentation claims against the current implementation.

## Disclaimer

Yeaft is an independent open-source project. It is not affiliated with or endorsed by Anthropic, OpenAI, GitHub, or any other model provider. Provider and model names are trademarks of their respective owners.

## License

[MIT](LICENSE)
