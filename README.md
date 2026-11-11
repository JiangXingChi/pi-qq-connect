# pi-qq-connect

[![npm](https://img.shields.io/npm/v/pi-qq-connect)](https://www.npmjs.com/package/pi-qq-connect)
[![license](https://img.shields.io/npm/l/pi-qq-connect)](LICENSE)

> **Platform: Linux only.** The background service is a systemd *user* unit
> (`systemctl --user`). macOS and Windows are neither tested nor supported.

Bridge the **official QQ bot platform** to the **current Pi session**. Messages sent in QQ
reach your Pi session; the final answer is sent back as a passive reply. Zero runtime
dependencies (Node built-ins only).

## Features

- Private chats and group @-mentions; images, voice transcripts, quoted messages, typing
- Serial queue, deduplication, passive-reply budget, single-instance lock
- Long replies split on code fences; failures retry with a fresh `msg_seq`
- Outbound images/files via `[[file:/absolute/path]]` in a reply (max 3)
- Session switches keep the gateway up; the next session instance adopts the bridge
- Background service under systemd; startup is silent, errors carry a stable `[QQ_E_*]` code
- In chat only `/new` is mapped; skills, prompt templates and other extensions still work

## Requirements

- A QQ bot on the [official platform](https://q.qq.com/) (appId + clientSecret)
- Node.js >= 22.19
- Pi >= 1.4
- Linux with systemd (user units)

## Install

```bash
pi install npm:pi-qq-connect
# or from a checkout
pi install .
```

Restart Pi after installing.

## Configure

Create `~/.pi/agent/pi-qq-connect.json` (mode `0600`):

```json
{
  "appId": "your-app-id",
  "clientSecret": "your-app-secret",
  "sandbox": false,
  "allowAll": true
}
```

See `examples/config.json` for every option. `allowAll: true` is fine for a personal bot;
otherwise list `allowUsers` / `allowGroups`.

## Commands

Terminal:

| Command | Purpose |
|---|---|
| `/qq status` | gateway, queue, last inbound, service |
| `/qq start` / `/qq stop [--force]` | manage the background service |
| `/qq log [n]` | last n log lines (default 20) |
| `/qq help` | this list |
| `/qq login` | validate appId/clientSecret, restart the service |
| `/qq logout` | stop the service, back up the config and remove clientSecret |

In the QQ chat window only `/new` is mapped: send `/new` or `/new name` to start a new
session. Control commands answer with a terminal hint. Skills, prompt templates and other
extension commands are forwarded to Pi unchanged.

## Background service

```bash
cp packaging/pi-qq-connect.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-qq-connect
```

The plugin starts the service with `systemctl --user start` when a unit exists, and falls
back to a detached process otherwise. Logs: `journalctl --user -u pi-qq-connect -n 50`.

## Limits

- Passive replies only: 4 per message in private chat (60 min window), 5 in groups
- QQ drops the WebSocket after roughly 30 minutes of inactivity; the client reconnects
- No Markdown rendering on the QQ side

## License

MIT
