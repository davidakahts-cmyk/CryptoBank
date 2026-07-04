# Mono & DIV Coin Game for Fly.io

This version moves the simulation loop to the Node.js server. That means the game keeps ticking while your browser is closed, as long as the Fly Machine is running.

Pages:

- `/` — main game UI
- `/Journal` — console-style journal of treasury trades, dividends, treasury interest, and peer trades

## Files

- `server.js` — simulation engine, background tick loop, API, static file server
- `public/index.html` — main game page
- `public/journal.html` — journal page
- `public/styles.css` — shared styling
- `public/client.js` — main page client code
- `public/journal.js` — journal page client code
- `Dockerfile` — Fly/Docker deployment
- `fly.toml` — Fly app configuration

## Browser-only setup idea

If you do not want to run terminal commands locally, create a GitHub repository in the browser, upload these files, then connect/deploy the repo on Fly.io. The important part is that Fly must keep at least one Machine running.

This `fly.toml` uses:

```toml
auto_stop_machines = "off"
min_machines_running = 1
```

That is what keeps the simulation running in the background.

## Persistence

The server saves state and journal history to `STATE_FILE`, defaulting to `/data/mono-div-state.json` on Fly. For real persistence on Fly, create a Fly volume named `mono_div_data` in the same region as the app and mount it to `/data`.

If there is no volume, the game still runs, but state can reset after redeploy/restart.
