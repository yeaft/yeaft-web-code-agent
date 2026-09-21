# FAQ

## Connection & Auth

### Agent connection failed "Invalid agent secret"

Make sure the Agent's `AGENT_SECRET` (or `--secret` flag) matches the value configured in the server's `.env` file. If you're using a per-user agent secret (visible in **Settings → Security**), that one takes precedence over the global `AGENT_SECRET` for that user's sessions.

### Server startup failed "SECURITY CONFIGURATION ERROR"

In production mode, the JWT secret must be changed from default:

```ini
JWT_SECRET=your-random-string-at-least-32-chars
```

Generate one with: `openssl rand -base64 32`

### 502 Bad Gateway after Docker deployment

1. Check if the container is running: `docker compose logs webchat`
2. Reload Nginx DNS cache: `docker exec nginx nginx -s reload`

### SQLite read-only error (SQLITE_READONLY)

Ensure data directory permissions are correct:

```bash
sudo chown -R root:root ./data
```

### Cannot login after TOTP setup

TOTP codes have a time window (default ±30 seconds). Make sure the server and your phone clocks are in sync.

## Picking a Backend

### "Claude Code" / "Copilot" missing from the new-session dialog

The Agent capability-detects each backend at startup. A backend doesn't appear if the corresponding CLI isn't on PATH or isn't authenticated on the agent machine:

- **Claude Code missing** → run `claude --version` on the agent machine; if it fails, install `@anthropic-ai/claude-code` and run `claude login`
- **Copilot missing** → run `copilot --version`; if it fails, install GitHub Copilot CLI and run `copilot auth login`
- **Yeaft Code Agent missing** → very unusual; the engine is bundled. Update the agent with `yeaft-agent upgrade`.

Restart the agent after installing/authing a new CLI — capability detection only runs at startup.

### Claude Code vs Copilot vs Yeaft Code Agent — which should I use?

See [Choose a Code Agent Path](./user/choose-backend.md). Short version:

- **Claude Code** for 1:1 chat with the full Claude tool set
- **Copilot** for 1:1 chat where you want to compare Claude vs GPT models or you already pay for Copilot
- **Yeaft Code Agent** for multi-VP parallel collaboration with cross-session memory

## Copilot Mode

### "Permission required" dialog keeps popping up

Copilot CLI runs in `--acp` mode and asks for permission per session before it can run shell commands or edit files. Choose **Always allow this session** to suppress the dialog for the rest of the session, or **Always allow** to remember for future sessions on the same agent machine.

### Can I pick a non-Claude/non-GPT model in Copilot Mode?

Only what Copilot CLI exposes. If you need another vendor, use Yeaft Code Agent and add the provider to the selected Agent instance's resolved `config.json`.

### Copilot says "not authenticated" but I'm logged into VS Code Copilot

The CLI uses a separate OAuth token from the IDE plugin. Run `copilot auth login` on the agent machine to authenticate the CLI specifically.

## Yeaft Code Agent

### Does an empty Plugins page mean the Agent has no tools or Skills?

Not necessarily. Earlier versions depended on an initialized native Session, so an online Agent could return an empty inventory before its native runtime started. Inventory discovery now reads built-in tools and bundled/user Skills directly. When the selected Agent matches the current Session, it also reads project Skills from that Session's working directory. You do not need to send a message first, and discovery does not start inference or connect to MCP servers.

Loading, errors, and empty inventory have distinct states; an empty inventory is no longer labeled as having all available capabilities enabled. Older Agents can still return empty inventories and need an Agent-side upgrade. Zero MCP servers can be normal: Plugins lists only the Agent's own MCP configuration, not the complete runtime set merged with external user and project configurations. Plugin selections apply to the Yeaft native engine, not to Claude Code or Copilot CLI permissions.

### "No LLM provider configured" when sending a message

Edit the selected Agent instance's resolved `config.json` and add at least one provider entry — see [Yeaft Engine Config](./yeaft-config.md) for paths and schema. Pick a `primaryModel` that exists in one of your `providers[].models` lists.

### VP doesn't seem to remember what I said last session

Dream/H2-AMS persistent recall is retired. A native turn receives a bounded window from the current Session transcript, not legacy memory segments or sibling Session summaries. Existing memory files remain on the Agent but are not read or injected. See [Retired H2-AMS implementation](./tech/yeaft-memory.md).

### `@mention` doesn't fan out to multiple VPs

Mention each VP explicitly: `@designer @dev please review this layout`. Mentions are parsed before fan-out — VPs that aren't mentioned won't respond. If you don't mention anyone, the group's default routing rule decides who answers.

### How do I check what's in a VP's memory?

The memory segments live at `<resolvedYeaftDir>/memory/<scope>/memory.md` on the Agent machine (one `memory.md` per scope, containing multiple segments). The default instance resolves this to `~/.yeaft/memory/...`; named `<name>` resolves it to `~/.yeaft/instances/<name>/memory/...`; an explicit `YEAFT_DIR` / `--yeaft-dir` uses that custom root. Each file is plain markdown you can read directly.

## Yeaft Engine Config

### Where does the Yeaft `config.json` live?

On the Agent machine, not the Server. The default service instance uses `~/.yeaft/config.json`; named `<name>` uses `~/.yeaft/instances/<name>/config.json` unless its Yeaft directory is overridden. `yeaft-agent llm` needs an explicit `--config` for named/custom instances.

### Can I have both Claude and GPT models behind one provider?

Yes — use per-model `protocol` overrides:

```json
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
```

See [Yeaft Engine Config → Per-Model Protocol](./yeaft-config.md#protocol-resolution-order).

### Hot reload — do I need to restart the agent after editing `config.json`?

The Agent re-reads its resolved instance config on the next turn, so model/provider changes typically take effect without a restart. Language, debug, and global-limit changes may require one.

## Agent Auto-Upgrade

```bash
# Upgrade the package; Unix named services must then be restarted explicitly
yeaft-agent upgrade --name worker-a
yeaft-agent restart --name worker-a

# Check at startup
yeaft-agent --auto-upgrade --server wss://...
```

The server can also push an upgrade notification via `AGENT_LATEST_VERSION` env var.
