# Yeaft Code Agent

**Yeaft Code Agent** is Yeaft's native web-first coding agent experience. It runs inside the local `yeaft-agent`, does not require Claude Code CLI or GitHub Copilot CLI, and is built around **Sessions**: one workspace can host one or many VPs (Virtual Persons), each with its own persona, model, memory, and tool permissions.

The historical page name is `yeaft-group.md` for URL compatibility, but the product concept is now **Yeaft Code Agent**. In the engine, the orchestration unit is still called a **Session**.

## What it is for

Yeaft Code Agent is designed for code work that benefits from a browser control plane and a local execution agent:

- **Implement and review code** with file, shell, git/worktree, notebook, search, and patch tools.
- **Run multi-perspective thinking** by adding VPs such as product, architect, developer, reviewer, tester, or designer.
- **Keep long-lived project context** through H2-AMS memory, so a VP can recall decisions, preferences, and prior work across sessions.
- **Mix providers and models** in the same product surface: Anthropic, OpenAI Responses, GitHub Copilot API credentials, Azure/OpenAI-compatible gateways, or local proxies.
- **Use one web UI for many machines**: each `yeaft-agent` connects a laptop, VM, or container to the server and exposes its workspace safely through WebSocket.

## How it differs from the other backends

| Path | Execution model | Best for |
| --- | --- | --- |
| **Claude Code Chat** | One Claude Code CLI subprocess per 1:1 chat | Maximum Claude Code compatibility, Claude skills/MCP ecosystem |
| **Copilot Mode** | One `copilot --acp` subprocess per 1:1 chat | Existing GitHub Copilot entitlement, ACP permissions, quick model switching |
| **Yeaft Code Agent** | Native Yeaft engine inside `yeaft-agent`, one Session with 1..N VPs | Multi-provider code agents, persistent memory, multi-VP collaboration, custom tool policy |

Yeaft Code Agent is not a wrapper around a vendor CLI. It owns the query loop, tool registry, memory recall, provider routing, and VP orchestration. That makes it the best place to integrate non-Claude providers or specialized proxies.

## Mental model: Session, VP, turn, tool

- A **Session** is the durable collaboration space. It has a title, announcement, roster, default VP, message history, debug state, and memory scope.
- A **VP** is a configurable virtual person. A VP has a persona, model reference, tool allowlist, memory, and optional sub-agents.
- A **turn** is a user message routed to one or more VPs. If multiple VPs are addressed, they run in parallel.
- A **tool** is an explicit capability exposed by the Yeaft engine, such as file editing, shell execution, web search, or spawning sub-agents.

A Session with one VP behaves like a focused code assistant. Add more VPs when you want parallel design review, test planning, product critique, or implementation/review separation.

## First-time setup

### 1. Install and connect an Agent

```bash
npm install -g @yeaft/webchat-agent
yeaft-agent --server wss://your-server.com --name worker-1 --secret your-secret
```

The Agent runs on the machine that owns the code. The browser talks to the server; the server relays encrypted traffic to the Agent; the Agent reads files, runs commands, talks to providers, and streams events back.

### 2. Configure at least one LLM provider

Yeaft Code Agent reads provider config from `~/.yeaft/config.json`. The quickest path is the Agent CLI:

```bash
yeaft-agent llm setup
```

Use GitHub Copilot credentials without storing an API token:

```bash
yeaft-agent llm use github-copilot --model claude-sonnet-4.5 --fast gpt-4.1
```

Or add an OpenAI-compatible provider:

```bash
OPENAI_KEY=sk-... yeaft-agent llm use openai-compatible \
  --name openai \
  --base-url https://api.openai.com/v1 \
  --api-key-env OPENAI_KEY \
  --model gpt-5
```

See [Yeaft Engine Config](../yeaft-config.md) for complete examples, including Anthropic, Azure OpenAI, GitHub Copilot dynamic credentials, and self-hosted OpenAI-compatible gateways.

### 3. Open the Yeaft page

In the web UI, click the **Yeaft** tab in the sidebar tab bar. If no Agent is online, the onboarding panel points you to the Agent setup page. Once the Agent is connected and has a provider, create a Session.

## Create and use a Session

1. Go to **Yeaft → + New Session**.
2. Give it a name, for example `Refactor auth flow` or `Release review`.
3. Pick one or more VPs from the roster.
4. Choose the default VP. When a message has no `@mention`, this VP receives the turn.
5. Send a message. Use `@VPName` to target a subset of VPs.

Example prompts:

```text
@Architect @Reviewer Review this migration plan before I implement it.
```

```text
@Dev Implement the smallest safe fix, add tests, and open a PR.
```

```text
@Tester Find regression risks in this diff and suggest targeted tests.
```

When several VPs are mentioned, the coordinator fans out the same user turn. Each VP builds its own prompt, recalls its own memory, calls its configured provider/model, executes allowed tools, and streams its result back into the shared Session timeline.

## Tools available to Yeaft Code Agent

Yeaft ships with 30+ built-in tools. Availability is controlled by the VP config and by engine mode.

- **Files and edits**: `file_read`, `file_write`, `file_edit`, `apply_patch`, `notebook_edit`
- **Search and discovery**: `grep`, `glob`, `list_dir`, `history_search`
- **Execution**: `bash`, `js_repl`, `enter_worktree`, `exit_worktree`
- **Network and media**: `web_fetch`, `web_search`, `image_generation`, `view_image`
- **Planning and tasks**: `start_plan`, `todo_write`
- **Agent orchestration**: `agent`, `send_message`, `wait_agent`, `list_agents`, `close_agent`, `route_forward`
- **External integration**: `ask_user`, `skill`, `mcp_tools`

For code work, the typical loop is: inspect files, plan, edit, run targeted tests, run broader tests, summarize risk, then hand off for review. Multi-VP Sessions let you make that loop explicit: one VP implements, another reviews, another focuses on tests.

## Provider integration model

Yeaft Code Agent has two provider layers:

1. **ChatProvider layer** for 1:1 chat backends such as Claude Code CLI and Copilot CLI. Those drivers normalize their output into the shared web rendering protocol.
2. **Yeaft LLM adapter layer** for the native engine. This is what Yeaft Code Agent uses. It routes each VP/model request through `AdapterRouter` to an Anthropic or OpenAI Responses compatible adapter.

For native Yeaft models, configure providers like this:

```json
{
  "providers": [
    {
      "name": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "protocol": "anthropic",
      "models": ["claude-sonnet-4-20250514"]
    },
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "protocol": "openai-responses",
      "models": ["gpt-5", "gpt-5-mini"]
    },
    {
      "name": "github-copilot",
      "baseUrl": "https://api.githubcopilot.com",
      "credentialProvider": "github-copilot",
      "protocol": "openai-responses",
      "models": [
        { "id": "claude-sonnet-4.5", "protocol": "anthropic" },
        "gpt-5"
      ]
    }
  ],
  "primaryModel": "anthropic/claude-sonnet-4-20250514",
  "fastModel": "openai/gpt-5-mini"
}
```

A VP can use `anthropic/claude-sonnet-4-20250514` while another uses `openai/gpt-5` and a third uses `github-copilot/claude-sonnet-4.5`. Per-model protocol overrides let a single provider expose both Claude-family and GPT-family models safely.

## Memory design

Yeaft Code Agent uses **H2-AMS** memory:

1. **Pre-turn recall**: full-text search over relevant scopes injects memory into the system prompt.
2. **Active Memory Set**: resident summaries, recent context, and on-demand memory are budgeted per turn.
3. **Post-turn adjustment**: the engine can update the active set after a turn.
4. **Dream maintenance**: background jobs break conversation history into atomic markdown memory segments.

Memory is scoped, not global by accident:

- `user/<userId>` stores user preferences and profile.
- `vp/<vpId>` stores a VP's own long-lived knowledge.
- `session/<sessionId>` stores Session-shared context.
- `feature/<featureId>` stores project/feature-level collaboration memory.
- `global` stores global facts.

This design is why a reviewer VP can remember your review standards, while a product VP remembers product constraints, and both can share Session-level facts for the current task.

## Recommended workflows

### Single-VP coding assistant

Create a Session with one default VP. Use it like a conventional coding agent, but with Yeaft memory and provider routing. This is best for focused implementation, bug fixes, documentation changes, and repeated work on one repo.

### PM + Developer + Reviewer

Create a Session with three VPs:

- PM VP clarifies user intent and acceptance criteria.
- Developer VP implements the smallest safe change.
- Reviewer VP checks architecture, edge cases, and tests.

Mention all three for design discussion; mention only `@Dev` for implementation; mention `@Reviewer` after the diff is ready.

### Provider comparison

Give two VPs the same persona but different models. Ask both to review the same design or bug. This is a practical way to compare Anthropic, OpenAI, Copilot, or a local gateway on your own tasks.

### Long-lived project memory

Keep one Session per important project. Add project-specific VPs and let memory accumulate decisions, naming rules, deployment constraints, and review preferences.

## Debugging and observability

The Yeaft page includes a debug panel for native engine turns. Use it to inspect:

- which provider/model handled a turn;
- which memory segments were recalled;
- what messages and tools were sent to the model;
- tool call inputs/outputs;
- token and stop-reason metadata.

If a VP gives a surprising answer, debug memory recall and model routing first. If a provider fails, check `~/.yeaft/config.json`, the Agent logs, and the Yeaft LLM layer error.

## Design principles

Yeaft Code Agent follows a few product and engineering rules:

- **Local execution, web control**: code runs on your Agent machine; the browser is the control plane.
- **Session-first collaboration**: the product no longer has separate chat/group modes in the native engine. A Session can have one VP or many VPs.
- **Provider-neutral core**: providers are routing targets, not product identity. Model references are explicit: `<provider>/<model-id>`.
- **Memory by scope**: VPs and users own memory scopes; sharing is deliberate through Session/feature scopes.
- **Tools are explicit**: every file edit, shell command, or network request goes through a named tool and can be logged, rendered, tested, and reviewed.
- **Compatibility without leaking old names**: some wire fields and disk paths keep historical `group`/`unify` aliases, but new documentation and code should use Yeaft and Session terminology.

## Going deeper

- Configure custom providers and models: [Yeaft Engine Config](../yeaft-config.md)
- Native engine architecture: [Yeaft Engine](../tech/yeaft-engine.md)
- LLM routing and protocol selection: [Yeaft LLM Layer](../tech/yeaft-llm.md)
- Memory internals: [Yeaft Memory (H2-AMS)](../tech/yeaft-memory.md)
- ChatProvider integration for CLI backends: [Provider System](../tech/providers.md)
