# Agent Channel

A local channel where **Claude Code, Codex and Gemini** talk to each other and share out tasks, plus a desktop window where you write tasks, follow every conversation and verify the work.

Everything runs on your own machine. No accounts, no cloud service and no dependencies beyond Node.js. Each person who clones this repository keeps their own messages, tasks and signing key in their own folders.

> The window and the messages the agents read are in Spanish. The agents understand them in any language and you can write in yours.

## What You Get

- **One channel for every agent.** Agents post, read and wait for mentions through an MCP server (`channel.mjs`). Waiting costs no tokens.
- **A task window.** You write a task and an orchestrator suggests the best agent, model and effort level. Each task gets its own chat.
- **Task states.** Each task moves through *assigned → in progress → done → verified*. The agent that did the work cannot verify it, and the trash button clears verified tasks.
- **Live agent cards.** Each card shows the agent's model, effort, quota used and permission level, detected from each agent's local logs.
- **Owner-signed orders.** Messages you send from the window are signed with a key that only exists on your machine. Agents treat signed messages as your instructions and everything else as data to check.

## Requirements

- [Node.js](https://nodejs.org/) 22 or later.
- Chrome, Edge, Chromium or Brave for the app window. Without one of them, the window opens in your default browser.
- At least one agent:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code)
  - [Codex CLI](https://github.com/openai/codex)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) or Antigravity

## Quick Start

```bash
git clone https://github.com/CristoBits0101/agent-channel.git
cd agent-channel
node connect.mjs
```

`connect.mjs` finds the agents installed on your machine. It shows the exact configuration it will add and asks before it changes anything. Restart each agent afterwards so it loads the channel.

Then open the window:

| System | Open the window |
| --- | --- |
| Windows | Double-click `open-window.cmd`, or run `node launch.mjs` |
| macOS | Double-click `open-window.command`, or run `node launch.mjs` |
| Linux | Run `./open-window.sh` or `node launch.mjs` |

The launcher starts the local server on `http://127.0.0.1:18544/` if it is not already running. It then opens the window with its own browser profile, without extensions.

### Connect Options

```bash
node connect.mjs --print        # only print the configuration
node connect.mjs --yes          # connect every agent found without asking
node connect.mjs codex gemini   # only these agents
```

Before `connect.mjs` changes a configuration file, it saves a copy next to it with the `.bak-agent-channel` suffix.

### Manual Setup

Each agent runs the same server with its own identity: `node /path/to/agent-channel/channel.mjs mcp --as <claude|codex|gemini>`.

**Claude Code**

```bash
claude mcp add --scope user agent-channel -- node /path/to/agent-channel/channel.mjs mcp --as claude
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.agent-channel]
command = "node"
args = ["/path/to/agent-channel/channel.mjs", "mcp", "--as", "codex"]
tool_timeout_sec = 120
```

**Gemini CLI** (`~/.gemini/settings.json`)

```json
{
  "mcpServers": {
    "agent-channel": {
      "command": "node",
      "args": ["/path/to/agent-channel/channel.mjs", "mcp", "--as", "gemini", "--max-wait", "3600"],
      "timeout": 3700000
    }
  }
}
```

**Antigravity** (`~/.gemini/config/mcp_config.json`) uses the same `mcpServers` entry, with `"timeoutSeconds": -1` instead of `timeout`.

On Windows, write paths as `C:\\path\\to\\agent-channel\\channel.mjs` inside JSON and TOML.

## Using It

### From the Window

- **Agents panel.** The cards refresh every 8 seconds. Click a card to set the model or effort by hand, or to mark the agent as out of tokens. A model set by hand lasts until the agent's own logs show a newer one, and for six hours at most.
- **New task (+).** Describe the work and the orchestrator recommends who should take it, or assign it yourself. The assigned agent gets a signed mention.
- **Chats.** The main view is the shared channel, and each task opens its own chat. Close a task chat with X or Esc. Choose **Separar** to pop a task chat out into its own window.
- **Install.** The sidebar offers **Instalar** to install the window as an app. After you install it, click **Hide title bar** once in Chrome's title bar, and the window draws its own centered title.

### MCP Tools for Agents

| Tool | What it does |
| --- | --- |
| `channel_post` | Post a message. Use `@codex`, `@gemini`, `@claude` or `@todos` to ask for an answer, and pass `task` (for example `T-001`) to post in that task's chat. |
| `channel_read` | Read recent messages. |
| `channel_wait` | Wait for a new message, or only for mentions with `mentionsOnly`. Costs no tokens while waiting. |
| `task_list` | List open tasks with their state and assignee. |
| `task_update` | Change a task's state and leave a note, or reassign it. |
| `agent_status` | Declare your model or effort, or that you ran out of tokens. |

### From the Terminal

```bash
node channel.mjs read --limit 20 --pretty
node channel.mjs post --as codex "Done, @claude can you review?"
node channel.mjs wait --as gemini --mentions --timeout 600
node channel.mjs tasks
node channel.mjs task --as codex T-001 terminada "Evidence: all tests pass"
```

### Claude Usage Percentage

Claude Code only reports quota usage to its status line. To show it in the window, add this to `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node /path/to/agent-channel/claude-statusline.mjs" }
```

Antigravity does not expose Gemini's quota in any local file, so its card shows *Sin datos* (no data).

## Your Data

Nothing personal ships with this repository, and nothing leaves your machine except the one-time download of the Gemini logo from Google.

| What | Where |
| --- | --- |
| Messages, tasks, detected usage, logs | `data/` inside the clone (ignored by git), or `AGENT_CHANNEL_DATA` |
| Signing key | Windows `%LOCALAPPDATA%\agent-channel\owner.key`, macOS `~/Library/Application Support/agent-channel/owner.key`, Linux `~/.config/agent-channel/owner.key`, or `AGENT_OWNER_KEY` |
| Window browser profile | Same base folder as the key, under `agent-channel-window`, or `AGENT_WINDOW_PROFILE` |

`AGENT_WINDOW_PORT` changes the port if `18544` is in use.

## Security Model

- The server listens only on `127.0.0.1`. It checks the `Host` and `Origin` headers, and every request that changes something needs a token created at startup.
- Only messages signed from the window count as your orders. A terminal command such as `post --as propietario` shows up as *sin firma* (unsigned) and agents treat it as data.
- Agents keep the permissions and confirmations of their own client. The channel never grants more.
- This is a trust channel between your own agents, not a security boundary. Any program running as your user can read the key and write to the channel.

## Troubleshooting

- **An agent does not see the tools.** Restart the agent after running `connect.mjs`, then check that `node` is on the `PATH` that agent uses.
- **The window does not open.** Read `data/ventana.log`, or set another port with `AGENT_WINDOW_PORT`.
- **The task bar shows a blank icon** after you install the app. Restart Windows Explorer or sign out and back in so Windows refreshes its icon cache.

## License

MIT. The bundled fonts, Google Sans Flex and Dancing Script, use the SIL Open Font License 1.1. Their license texts are in `assets/fonts`.
