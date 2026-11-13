# YakkBot

**Your own team of AI agents, in a texting-style app that runs on your phone.**

Give a bot a job and follow its work in chat. Each bot has a name, a look, its own memory and soul
file, and its own model. Bots message each other, run on a schedule, and ask before they do anything
risky. It runs in Termux on Android, and the same code runs on Linux, a Chromebook, macOS and Windows.

YakkBot is built from [Bot HQ](https://github.com/nickvasilescu/bot-hq) by Nick Vasilescu (MIT), which
puts the best part of several agent products behind one chat interface. Bot HQ needs a cloud computer
and three paid services before it answers a message. YakkBot keeps its interface and server and adds
a built-in agent engine, so **one model key on one phone is a complete install**; everything else is
an add-on.

| From | The idea | In YakkBot |
|---|---|---|
| Grok Bot | Texting-style interface, several bots, voice, research on X | The chat UI; voice and `x_search` switch on with an xAI key |
| Muse | A soul file and a memory file you can edit | `SOUL.md`, `MEMORY.md`, `USER.md` per bot, editable in the app |
| Dots | The agent's computer, the thinking indicator, many sessions | The phone itself (shell, files, Termux:API), a live "what it is doing" line, one thread per bot |
| Hermes Agent | Open harness, bring any model | A built-in engine for Claude or any OpenAI-compatible model; Hermes gateways still work |
| Instinct | Reach your agent by text message | A Telegram bridge with approval buttons; bots can send SMS through Termux:API |
| Duet | Claude models | Claude through the Anthropic API is the first-listed provider |

## What you get

- **Chat that shows the work.** While a bot works you see what it is doing and each step it took.
- **A built-in engine.** No Hermes, no cloud VM. Claude (Anthropic API), OpenAI, OpenRouter, Grok,
  Gemini, Groq, a local Ollama, or any OpenAI-compatible endpoint. Paste a key in the app.
- **The phone is the bot's computer.** Shell, files, web search and fetch, and through Termux:API:
  notifications, clipboard, location, SMS, calls, contacts, camera, text-to-speech.
- **Approvals.** Destructive or outward-facing shell commands, texts and calls, and reads of private
  phone data wait for your OK on a card (Allow / Always allow / Don't allow).
- **Soul and memory you can read and edit.** Plain files per bot, with an editor in Bot settings.
- **A team.** Bots hand work to each other, share group chats, keep task lists, and run routines on a
  cron schedule.
- **A Library** per bot for the files it makes, downloadable from the app.
- **Installs as an app.** Add to Home screen from Chrome for a full-screen icon.
- **Add-ons when you want them:** Telegram bridge, voice calls and X research (xAI), connected apps
  with approvals (Composio), a live desktop the bots can drive and you can watch (VNC), Hermes Agent
  as the engine, an Orgo cloud computer.

## Install

### Android (Termux)

Install [Termux](https://f-droid.org/packages/com.termux/) from F-Droid (the Play Store build is out
of date). For the phone tools also install [Termux:API](https://f-droid.org/packages/com.termux.api/),
and [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) if you want it to start on boot.

```bash
pkg install -y curl
curl -fsSL https://raw.githubusercontent.com/deezi74/YakkBot/main/install.sh | bash
```

The installer prints your sign-in passphrase and the address (`http://localhost:8787`). Open it in
Chrome, sign in, open your bot's details, and under **Engine** pick a provider and paste a key.
Then: Chrome menu > **Add to Home screen**.

Android stops background apps aggressively. Two settings keep YakkBot alive: in Android Settings set
Termux's battery use to **Unrestricted**, and run `yakkbot boot` so it comes back after a restart.
On Android 12+ also disable the phantom process killer once from a computer:
`adb shell "settings put global settings_enable_monitor_phantom_procs false"`.

### Linux and Chromebook (Crostini)

```bash
curl -fsSL https://raw.githubusercontent.com/deezi74/YakkBot/main/install.sh | bash
```

Works on x86_64 and ARM64. If Node 22.13+ is missing, the installer puts a private copy under
`~/.yakkbot/node` and leaves the system alone. On a Chromebook, enable Linux first (Settings >
Advanced > Developers); the app is then at `http://localhost:8787` in ChromeOS's own Chrome.

### Windows

In PowerShell, with [Node.js 22.13+](https://nodejs.org) and [Git](https://git-scm.com) installed:

```powershell
git clone https://github.com/deezi74/YakkBot.git; cd YakkBot
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Or use WSL2 and the Linux line above, which gives the bots a real bash shell.

### From a clone (any platform)

```bash
git clone https://github.com/deezi74/YakkBot.git && cd YakkBot && bash install.sh
```

## Use it

```text
yakkbot start | stop | restart | status
yakkbot open                    open the app
yakkbot key anthropic sk-ant-…  save a model key (also: openai, openrouter, gemini, groq, xai)
yakkbot password                new sign-in passphrase
yakkbot lan on                  open the app to your Wi-Fi (use it from your PC at http://<phone-ip>:8787)
yakkbot boot                    start on boot
yakkbot update                  fetch the latest version and rebuild
yakkbot backup                  save settings, bots, memories and files
yakkbot doctor                  check the install
```

Things to try once a model is connected:

- "Check my battery and notify me if it drops under 20%, every 30 minutes." (creates a routine)
- "Clone https://github.com/… into your Library, run the tests and tell me what fails."
- "Remember that I want answers in two sentences unless I ask for more."
- Create a second bot called Scout with the label Research, then tell your main bot: "Ask Scout to
  compare the three cheapest ARM64 mini PCs and report back."

### Telegram

1. Message [@BotFather](https://t.me/BotFather), create a bot, copy the token.
2. `yakkbot set TELEGRAM_BOT_TOKEN <token> && yakkbot restart`
3. Message your new bot. It replies with your chat id.
4. `yakkbot set TELEGRAM_ALLOWED_CHATS <id> && yakkbot restart`

Now text it from anywhere. `/bots`, `/bot <name>`, `/new`, `/stop`. Approval and question cards
arrive as buttons. It uses long polling, so the phone needs no open port.

### A desktop the bots can use

```bash
yakkbot desktop setup && yakkbot desktop start && yakkbot restart
```

This installs XFCE with a VNC server (a large download on a phone), and the app gains a live view of
the screen with a take-control mode. Bots get a `screen` tool (screenshot, click, type) that works
with models that accept images.

## Settings

Everything lives in `~/.yakkbot/` (mode 700): `.env` (settings and keys), `yakkbot.db` (bots,
conversations), `engines/<bot>/` (soul and memory files), `files/<bot>/` (each bot's Library).
`.env.example` documents every setting.

| Setting | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` | `0.0.0.0` opens the app to your network |
| `YAKK_PASSWORD` | generated | Sign-in passphrase |
| `YAKK_SHELL_APPROVAL` | `risky` | `always` asks before every command, `off` never asks |
| `YAKK_ENGINE` | `native` | `hermes` runs bots on Hermes Agent gateways instead |
| `YAKK_COMPUTER` | auto | `none`, `local` (VNC on this device) or `orgo` |
| `YAKK_CONTEXT_CHARS` | `400000` | Conversation size at which older turns are summarised |
| `MAX_BOTS` | `12` | Team size |

## Security

- The app listens on this device only until you run `yakkbot lan on`. Sign-in is a passphrase with
  slowed retries; sessions are HTTP-only cookies.
- Model keys entered in the app are stored unencrypted in `~/.yakkbot/yakkbot.db`; keys in `.env`
  are plain text too. Both are readable only by your user. A rooted phone, or anything running as
  your Termux user, can read them.
- A bot has a shell with your permissions. The approval rules catch common destructive and
  outward-facing commands by pattern; they are a seat belt, not a sandbox. Use
  `YAKK_SHELL_APPROVAL=always` if you want to see every command, and never point a bot at content
  you do not trust (a web page can try to talk a model into running something) with approvals off.
- Shell commands run without the server's own secrets in their environment.
- For access away from home, prefer Telegram or a private network (Tailscale, WireGuard) over
  exposing the port. There is no TLS built in.
- This is experimental software with no security audit.

## Develop

```bash
npm ci
npm run dev          # API on :8787, web on :5173 (set DEV_LOGIN=1 or YAKK_PASSWORD in the environment)
npm run typecheck
npm run build && npm test    # end-to-end checks against a mock model server; no real provider is called
```

```text
server/src/native/    the built-in engine: providers, model adapters, agent loop, device tools
server/src/agent/     turns, approvals, the app's own tools (tasks, routines, bot-to-bot)
server/src/channels/  Telegram
server/src/           API, MCP endpoint, engines, computer modes, VNC relay, voice
web/src/              the app
scripts/yakkbot.sh    the yakkbot command
tests/                smoke test and mock model server
docs/ARCHITECTURE.md  how it fits together
```

## Status and limits

- Tested here: the server, both model protocols against a mock server, and the web app in a
  phone-sized Chromium. **Not yet run on a real phone or against a real model provider**; expect to
  shake out a few things on first install.
- Voice, connected apps, Hermes and Orgo paths are Bot HQ's code, kept working by type but not
  exercised here.
- One owner per install. No attachments in chat yet.

## Next: the PC edition

The same server already runs on a PC. What the house PC adds is planned as: a screen per bot
(one virtual display each instead of one shared desktop), a browser per bot, local models through
Ollama as the default provider, and pairing so the phone app can hand heavy jobs to the PC.

## License and credits

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). Built on
[Bot HQ](https://github.com/nickvasilescu/bot-hq) (c) 2026 Nick Vasilescu, MIT. YakkBot's avatars and
icon are original; none of Bot HQ's bundled Grok Bot artwork is included. Independent project, not
affiliated with xAI, Meta, OpenAI, Anthropic, Nous Research, Orgo or Composio.
