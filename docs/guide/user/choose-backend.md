# Choose a Code Agent Path

Yeaft exposes three execution paths in one browser. A connected Agent may run all three, but each path keeps its own runtime and compatibility boundary.

| Path | Best when you need | Runtime / boundary |
| --- | --- | --- |
| **Claude Code** | Exact Claude Code tools, skills, MCP, compact/clear commands, sub-agent events, and resume behavior | One locally installed and authenticated Claude Code CLI process per conversation |
| **GitHub Copilot** | Copilot entitlement, ACP tool-permission prompts, and Copilot's model catalog | One locally installed and authenticated `copilot --acp` process per conversation |
| **Yeaft Code Agent** | Native provider routing, 1..N VPs, 33 built-in tools, scoped memory, Projects, sub-agents, and Work Center | Native engine inside `yeaft-agent`; it does not emulate every vendor CLI command |

## Claude Code

Choose Claude Code when compatibility with the Claude Code CLI matters more than provider neutrality.

- The Agent starts a CLI conversation and normalizes its stream-json events for the Web UI.
- Claude Code owns its CLI session and command semantics.
- The Yeaft Web UI can display streaming text, tools, files, sub-agents, context actions, and resume history exposed by that provider.
- The Expert Panel is a Claude Code conversation helper; it is not the native multi-VP Session system.

## GitHub Copilot

Choose Copilot when the Agent machine already has an eligible Copilot setup and you want ACP behavior.

- The Agent starts `copilot --acp` and translates ACP events to the shared browser renderer.
- Available models follow the live Copilot catalog and the local account entitlement.
- Tool calls can require an allow-once, allow-always, or deny response.
- Copilot persistence and unsupported commands follow the installed CLI, not Claude Code behavior.

## Yeaft Code Agent

Choose the native engine when you need product-level orchestration rather than exact CLI compatibility.

- A Session has 1..N reusable VPs and one durable timeline.
- `@mentions` can fan one turn out to several VPs; `RouteForward` records explicit peer handoffs.
- Native turns use a bounded window of their own Session history; legacy Dream/H2-AMS memory and sibling Session summaries are not injected.
- Native providers route through Anthropic Messages or OpenAI Responses adapters, including supported GitHub Copilot dynamic credentials and compatible gateways.
- The current built-in registry has 33 tools; Skills and MCP may add more.
- A Session can create an Agent-level WorkItem for durable, planned, recoverable work.

## How to create each one

Use **New chat** in the unified sidebar:

1. Select the Agent that owns the target directory.
2. Select **Claude Code**, **Copilot**, or **Yeaft**.
3. Enter the working directory and runtime-specific options.
4. For Yeaft, choose the Session roster/default VP. After creation, choose model/effort in the composer and edit the announcement in Session settings.

The sidebar catalog can show conversations from multiple Agents. Runtime identity always includes the Agent; the same Session ID on two Agents is not the same Session.

## Common choices

- Exact Claude Code workflow or Claude-specific skills → **Claude Code**.
- Existing Copilot subscription and ACP permission flow → **GitHub Copilot**.
- One provider-neutral coding assistant with memory → **Yeaft Session with one VP**.
- Parallel developer/reviewer/research roles → **Yeaft Session with several VPs**.
- Persistent goal with Action planning, waiting, retry, or recovery → **Work Center**, often created from a Yeaft Session.

## Related pages

- [Claude Code conversation](./chat-mode.md)
- [GitHub Copilot conversation](./copilot-mode.md)
- [Yeaft Sessions and Projects](./yeaft-session.md)
- [Work Center](./work-center.md)
