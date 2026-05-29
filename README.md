# Hermes Sendblue Bridge

**Text your Hermes Agent from any phone via iMessage.**

This is a polling-based bridge that connects [Sendblue](https://sendblue.co) to your
[Hermes Agent](https://hermes-agent.nousresearch.com), giving you full conversational
access to your agent (with all its tools — web search, memory, file access, etc.)
through standard text messaging.

```
Your Phone ──→ Sendblue API ──→ Hermes API Bridge ──→ Hermes Agent CLI
                                     :5000              (full tool access)
              ←── reply  ←──   /v1/chat/completions
```

## Features

- **iMessage** — works with any phone number via Sendblue
- **Polling mode** — no webhooks, no public endpoints, works behind NAT
- **Per-contact personalities** — different system prompts per phone number
- **Conversation persistence** — SQLite-backed, survives restarts
- **Typing indicators & read receipts** — feels like real iMessage
- **Full Hermes tool access** — web search, file access, memory, browser, etc.
- **systemd services included** — runs as a background daemon

## Prerequisites

| Requirement | How to check |
|---|---|
| **Hermes Agent** installed and configured | `hermes config show` |
| **Node.js 18+** + npm | `node --version` |
| **Sendblue account** with a phone number | [sendblue.co](https://sendblue.co/sign-up) (Free Tier works) |
| Python `aiohttp` in Hermes venv | `pip install aiohttp` |

## Quick Start

```bash
# 1. Clone into a directory alongside your Hermes setup
git clone https://github.com/codebooker/hermes-sendblue-bridge.git
cd hermes-sendblue-bridge

# 2. Run the installer (checks prerequisites, installs deps, sets up .env)
chmod +x install.sh && ./install.sh

# 3. Edit .env with your Sendblue credentials
nano .env
#   SENDBLUE_API_KEY_ID=...       (from sendblue.co → Dashboard → API Keys)
#   SENDBLUE_API_SECRET_KEY=...   (from sendblue.co → Dashboard → API Keys)
#   SENDBLUE_FROM_NUMBER=+1...    (your Sendblue phone number, E.164 format)
#   HERMES_API_SERVER_KEY=...     (generate with: openssl rand -hex 32)

# 4. Start both bridges
./start-sendblue.sh
```

That's it. Text your Sendblue number — your Hermes agent will reply.

## Architecture

Two processes run side by side:

```
┌─────────────────────────────────────────────────────┐
│  hermes-api-bridge.py      (port 5000)              │
│  OpenAI-compatible /v1/chat/completions endpoint     │
│  Proxies requests → hermes_cli.main chat -Q         │
│                                                     │
│  Tools available: web_search, memory, file, etc.    │
└──────────┬──────────────────────────────────────────┘
           │ Bearer auth
┌──────────▼──────────────────────────────────────────┐
│  sendblue-bridge-polling.js                         │
│  Polls Sendblue /api/v2/messages every 2s           │
│  → from_number → personality → Hermes API bridge    │
│  ← reply → Sendblue /api/send-message               │
│                                                     │
│  SQLite DB: conversation-history.db                 │
│  State:     .sendblue-processed-messages            │
└─────────────────────────────────────────────────────┘
```

## Configuration

### `.env` file

| Variable | Required | Description |
|---|---|---|
| `SENDBLUE_API_KEY_ID` | Yes | Sendblue API key ID |
| `SENDBLUE_API_SECRET_KEY` | Yes | Sendblue API secret key |
| `SENDBLUE_FROM_NUMBER` | Yes | Your Sendblue phone number (E.164) |
| `HERMES_API_SERVER_URL` | Yes | URL of the API bridge (default: `http://127.0.0.1:5000/v1`) |
| `HERMES_API_SERVER_KEY` | Yes | Shared secret for bridge ↔ API auth |
| `PORT` | No | API bridge listen port (default: 5000) |
| `HERMES_PYTHON` | No | Path to Hermes venv python (auto-detected) |
| `HERMES_BRIDGE_TOOLSETS` | No | Tools available to the bridge (default: all) |

### Per-contact personalities

Edit the `personalityConfig` object in `sendblue-bridge-polling.js`:

```js
const personalityConfig = {
  // Your spouse — casual, warm
  '+140****1234': {
    name: 'Alice',
    systemPrompt: `You're chatting with Alice, my wife. Be warm and natural.
      Use web_search whenever she asks about anything factual or current.`,
    model: 'anthropic/claude-sonnet-4-5',  // optional model override
  },

  // Default for unknown numbers
  'default': {
    name: 'User',
    systemPrompt: `You're a helpful assistant via text. Be concise and professional.`,
  },
};
```

Each contact entry accepts:
- **`name`** — display name (used in logs only)
- **`systemPrompt`** — injected at the start of every conversation with this contact
- **`model`** — (optional) override the LLM model for this contact

### Tool access

By default, the API bridge gives bridge callers access to all Hermes tools:
`browser,terminal,file,web,vision,delegation,memory`

To restrict this (e.g., text-only with no terminal access), set in `.env`:

```bash
HERMES_BRIDGE_TOOLSETS=web,memory,file
```

## Running as a System Service

The installer can set up systemd user services for you:

```bash
# Enable both services to start on boot
systemctl --user enable hermes-api-bridge.service sendblue-bridge.service

# Start now
systemctl --user start hermes-api-bridge.service sendblue-bridge.service

# Check status
systemctl --user status hermes-api-bridge.service
systemctl --user status sendblue-bridge.service

# View logs
journalctl --user -u sendblue-bridge.service -f
```

## Troubleshooting

| Problem | Check |
|---|---|
| Bridge starts but no replies | `journalctl --user -u sendblue-bridge.service -f` — look for "Invalid API response" |
| "Missing environment variables" | Did you copy `.env.example` → `.env` and fill in all values? |
| "Hermes request timeout" | Is the API bridge running? Check `curl http://localhost:5000/health` |
| Duplicate replies | Normal on first startup — the bridge processes recent messages. Clears up after the first poll cycle. |
| Hermes CLI not found | Set `HERMES_PYTHON` in `.env` to the full path of the Hermes venv python |
| Sendblue API errors | Verify your API keys at [sendblue.co/dashboard](https://sendblue.co/dashboard) |
| Messages not delivering to iMessage | Check your Sendblue number status — iMessage registration can take 24-48h |

## Security

- The API bridge listens on `127.0.0.1` by default (localhost only). Do not expose it to the public internet.
- The `HERMES_API_SERVER_KEY` is a shared secret between the bridge and API. Generate a strong random key.
- Sendblue API keys provide full account access — keep `.env` out of version control (it's in `.gitignore`).

## How It Differs from the Sendblue Webhook Approach

This bridge uses **polling** (hitting the Sendblue API every 2 seconds) instead of webhooks.
Why:

- **No public endpoint needed** — works behind NAT, no port forwarding, no domain
- **Simpler setup** — no SSL certs, no webhook registration
- **Sendblue Free Tier compatible** — webhooks aren't available on free accounts
- **Only 2s latency** — negligible for text messaging

The trade-off is ~720 API calls/hour, well within Sendblue's rate limits.

## License

GPLv3 — see [LICENSE](LICENSE)