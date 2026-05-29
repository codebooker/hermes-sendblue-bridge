# Contributing

Pull requests are welcome. Before opening one:

1. **Don't commit secrets.** `.env`, `*.db`, and `.sendblue-processed-messages` are gitignored. If you add new secret-bearing files, add them to `.gitignore`.

2. **Test your changes locally** before pushing. At minimum:
   ```bash
   node --check sendblue-bridge-polling.js
   python3 -m py_compile hermes-api-bridge.py
   ```

3. **Keep dependencies minimal.** The bridge only needs `dotenv` and `sql.js`. Add new deps only if they serve a clear purpose.

4. **Systemd services** should use `%h` for home-directory paths so they're portable. The `install.sh` script expands these at install time.

## Architecture decisions

- **Polling over webhooks** — chosen because Sendblue Free Tier doesn't support webhooks, and polling adds only 2s latency.
- **SQLite over in-memory** — persistence across restarts matters for conversation context.
- **Separate API bridge process** — keeps the SMS bridge simple (just HTTP calls) while the API bridge handles the heavy Hermes CLI subprocess.