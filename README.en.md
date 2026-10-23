# pi-qqbot

[![npm](https://img.shields.io/npm/v/pi-qqbot)](https://www.npmjs.com/package/pi-qqbot)
[![license](https://img.shields.io/npm/l/pi-qqbot)](LICENSE)
[中文](README.md)

Bridge the **official QQ bot platform** to the **current Pi session**. Zero runtime dependencies
(Node >= 22.19 built-ins only).

- QQ messages are injected into the active Pi session with `pi.sendUserMessage()`; the final
  answer is sent back as a passive reply.
- Private chats and group @-mentions; images, voice transcripts, quoted messages, typing.
- Long replies are split on code fences; failures retry with a fresh `msg_seq`.
- Outbound images/files: end a reply with `[[file:/absolute/path]]` (max 3).
- Dedup, serial queue, passive-reply budget, single-instance lock, detached service mode.

## Install

```bash
pi install npm:pi-qqbot
```

Or from a checkout:

```bash
git clone https://github.com/<you>/pi-qqbot.git
cd pi-qqbot
pi install .
```

Create `~/.pi/agent/pi-qqbot.json` (chmod 600) with your AppID/AppSecret; see
[`examples/config.json`](examples/config.json). `sandbox: true` while testing, then add your
openid to `allowUsers` and turn `allowAll` off.

## Commands

| Command | Purpose |
|---|---|
| `/qq status` | gateway, queue, last inbound, background service |
| `/qq start` | start the detached service |
| `/qq stop` | stop the service (or disconnect this process) |
| `/qq new [name]` | new Pi session, gateway stays connected (also works from QQ) |
| `/qq log [n]` | tail the log |
| `/qq take` | take over the gateway lock (only on lock conflicts) |

When the background service is online, terminal `/qq new` is refused (use it from QQ); terminal
`/new` only changes the local TUI session. The QQ session belongs to the service process.

## Limits

- Passive replies only: 4 per message in private chat (60 min window), 5 per message in groups
  (5 min window).
- One shared Pi session for all QQ chats, unless you send `/qq new`.
- File uploads are validated (regular file, <= 200 MB, sensitive paths such as `~/.ssh` denied).

## Development

```bash
npm test
npm run e2e
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
MIT licensed.
