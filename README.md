# Agent

An agent scaffolded from the Qure agent template. Under the hood it's **headless
Claude Code** with a system prompt + tools (scripts), wrapped in a streaming web
chat (FastAPI + Vite).

## What's here

| Path | What it is |
|---|---|
| `system_prompt.md` | The agent's instructions — what it does and its rules. |
| `scripts/` | The agent's tools. Each is a small program run via `uv run scripts/<name>.py`. |
| `docs/` | Reference material the agent reads when relevant. |
| `pyproject.toml` | Python deps your `scripts/` need. |
| `app/` | The harness: FastAPI backend (AG-UI streaming) + Vite chat frontend. Don't need to touch it. |

## Run it

1. **Get a Claude token:** run `claude setup-token` where you're logged in (or ask the Agentic AI team).
2. `cp app/.env.example app/.env` and paste the token into `CLAUDE_CODE_OAUTH_TOKEN`.
3. `cd app && docker compose up --build`
4. Open **http://localhost:5175** and chat with your agent.

## Make it yours

- **Instructions:** edit `system_prompt.md`.
- **Tools:** add scripts in `scripts/` (and their deps in `pyproject.toml`). If a tool needs config (DB creds, API keys), add it to `app/.env` and forward it in `app/docker-compose.yml`.
- **Knowledge:** drop `.md` files in `docs/`.

The **`agent-builder`** skill can do all of this for you interactively — scaffold, write the prompt, generate tools, set up the token, and bring it up.
