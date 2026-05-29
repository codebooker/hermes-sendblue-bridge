#!/bin/bash
# Clean launcher for the Sendblue bridge.
# Unsets any lingering env vars, then loads fresh from .env before starting.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Clear any stale env vars that might be cached from a previous run
unset SENDBLUE_API_KEY_ID SENDBLUE_API_SECRET_KEY SENDBLUE_FROM_NUMBER
unset SENDBLUE_WEBHOOK_SECRET HERMES_API_SERVER_URL HERMES_API_SERVER_KEY PORT

# Source the .env file
set -a
source .env
set +a

exec node sendblue-bridge-polling.js