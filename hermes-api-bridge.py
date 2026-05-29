#!/usr/bin/env python3
"""
Hermes API bridge — OpenAI-compatible endpoint backed by Hermes CLI with full agent tools.
Used by: Sendblue SMS bridge, Phone agent, and other external integrations.

Provides a /v1/chat/completions endpoint that proxies chat requests to the Hermes
CLI agent, giving external services access to all Hermes tools (web search, memory,
file access, etc.) via a standard API.
"""

import asyncio, json, logging, os, sys, uuid, time, subprocess
from pathlib import Path
from aiohttp import web

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Configuration ───────────────────────────────────────────────────────────

HERMES_API_KEY = os.getenv("HERMES_API_SERVER_KEY", "")

# Auto-detect Hermes Python path
def _find_hermes_python() -> str:
    """Find the Hermes venv python. Checks env var, then default paths."""
    if explicit := os.getenv("HERMES_PYTHON"):
        return explicit

    candidates = [
        Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python",
        Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python3",
    ]
    for p in candidates:
        if p.exists():
            return str(p)

    # Fall back to current interpreter (last resort)
    logger.warning("⚠️  Could not find Hermes venv; falling back to current Python")
    return sys.executable

HERMES_PYTHON = _find_hermes_python()
HERMES_HOME = os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))

# Toolsets to load for API bridge requests
# Adjust to control which tools are available to SMS/phone/API callers
DEFAULT_TOOLSETS = "browser,terminal,file,web,vision,delegation,memory"

if HERMES_API_KEY:
    logger.info(f"✓ HERMES_API_SERVER_KEY loaded ({len(HERMES_API_KEY)} chars)")
else:
    logger.warning("⚠️  HERMES_API_SERVER_KEY not set — auth will fail!")

logger.info(f"🐍 Hermes Python: {HERMES_PYTHON}")
logger.info(f"🏠 Hermes Home:   {HERMES_HOME}")


# ── Auth ────────────────────────────────────────────────────────────────────

def verify_auth(request: web.Request) -> bool:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    return auth[7:] == HERMES_API_KEY


# ── Endpoints ───────────────────────────────────────────────────────────────

async def health(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


async def models(request: web.Request) -> web.Response:
    return web.json_response({
        "object": "list",
        "data": [
            {"id": "deepseek/deepseek-v4-flash", "object": "model", "owned_by": "deepseek"},
            {"id": "anthropic/claude-sonnet-4-5", "object": "model", "owned_by": "anthropic"},
            {"id": "openai/gpt-4o-mini", "object": "model", "owned_by": "openai"},
        ],
    })


async def chat_completions(request: web.Request) -> web.Response:
    if not verify_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401)

    try:
        data = await request.json()
        messages = data.get("messages", [])
        if not messages:
            return web.json_response({"error": "No messages"}, status=400)

        # Extract system prompt
        system_prompt = None
        for msg in messages:
            if msg.get("role") == "system":
                system_prompt = msg.get("content", "")
                break

        # Extract last user message
        user_message = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                user_message = msg.get("content", "")
                break

        if not user_message:
            return web.json_response({"error": "No user message found"}, status=400)

        # Build conversation context for Hermes CLI
        conversation_context = ""
        if system_prompt:
            conversation_context += f"System context:\n{system_prompt}\n\n"

        non_system = [m for m in messages if m.get("role") != "system"][-20:]
        if len(non_system) > 1:
            conversation_context += "Conversation thread:\n"
            for msg in non_system[:-1]:
                role = msg.get("role", "").capitalize()
                content = msg.get("content", "")
                conversation_context += f"{role}: {content}\n\n"

        conversation_context += f"User: {user_message}"

        try:
            model = data.get("model", "deepseek/deepseek-v4-flash")
            toolsets = os.getenv("HERMES_BRIDGE_TOOLSETS", DEFAULT_TOOLSETS)
            logger.info(f"Agent mode: {user_message[:60]}...")

            cmd = [
                HERMES_PYTHON, "-m", "hermes_cli.main", "chat",
                "-q", conversation_context,
                "-t", toolsets,
                "-m", model,
                "-Q",
            ]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "HERMES_HOME": HERMES_HOME},
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=300
                )
                returncode = proc.returncode
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                logger.error("⏱️ Hermes request timeout (>300s)")
                return web.json_response(
                    {
                        "choices": [
                            {
                                "message": {
                                    "role": "assistant",
                                    "content": "Request timed out.",
                                }
                            }
                        ]
                    },
                    status=504,
                )

            if returncode != 0:
                error_msg = stderr.decode().strip()
                logger.error(f"Hermes error (code {returncode}): {error_msg}")
                return web.json_response(
                    {
                        "choices": [
                            {
                                "message": {
                                    "role": "assistant",
                                    "content": f"Error: {error_msg[:100]}",
                                }
                            }
                        ]
                    },
                    status=500,
                )

            response_text = stdout.decode().strip() or "No response generated"
            logger.info(f"Response: {len(response_text)} chars")

        except Exception as e:
            logger.error(f"Hermes call error: {e}", exc_info=True)
            return web.json_response(
                {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": f"Error: {str(e)[:80]}",
                            }
                        }
                    ]
                },
                status=500,
            )

        return web.json_response({
            "id": "chatcmpl-" + str(uuid.uuid4())[:8],
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": response_text},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })

    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return web.json_response({"error": f"Server error: {e}"}, status=500)


# ── Server ──────────────────────────────────────────────────────────────────

async def main():
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/chat/completions", chat_completions)

    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", 5000))

    logger.info(f"🚀 Hermes API bridge on {host}:{port}")
    logger.info(f"📍 Endpoint: http://{host}:{port}/v1/chat/completions")
    logger.info(f"🛠️  Toolsets: {os.getenv('HERMES_BRIDGE_TOOLSETS', DEFAULT_TOOLSETS)}")

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    logger.info("✓ Ready")

    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
