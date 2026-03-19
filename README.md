# Clawdio — OpenClaw Discord Voice Plugin

**Clawdio** lets you talk to your OpenClaw AI agent in Discord voice channels — just like a real conversation. Speak, get audio replies, and keep your full session context.

## How it works
You (speak in Discord voice) → Clawdio → STT (speech-to-text) → OpenClaw Gateway → Agent → TTS (text-to-speech) → Clawdio → Discord (play audio)

Your agent sees the same conversation history as when you type — memory, tools, and context are preserved.

## Key Feature: Zero Config if OpenClaw is Already Set Up
Clawdio automatically reads your existing OpenClaw configuration from `~/.openclaw/openclaw.json`, including:
- Discord bot token (from `channels.discord.token`)
- Gateway URL and port
- Gateway auth token (if configured)
- STT/TTS preferences

You only need to provide missing pieces (like OpenAI API key for Whisper STT) via environment variables.

## Features
- 🎙️ **Real-time voice chat** in Discord voice channels
- 🔤 **STT**: OpenAI Whisper API (default) or local fallback
- 🔊 **TTS**: Microsoft Edge TTS (free, no API key) or ElevenLabs
- 💾 **Full context** — uses session `main`, same as your text chats
- 🔐 **Secure** — connects to your gateway via WebSocket, credentials from your existing OpenClaw config
- ⚙️ **Zero config needed** if OpenClaw is already running — reads `~/.openclaw/openclaw.json` automatically

## Quick Start

### 1. Install
```bash
git clone https://github.com/serverul/clawdio.git
cd clawdio
npm install
```

### 2. Run (often no config needed!)
```bash
npm start
```

Clawdio will automatically read:
- Your Discord bot token from `~/.openclaw/openclaw.json` (`channels.discord.token`)
- Gateway URL from `gateway.bind` + `gateway.port`
- Gateway token from `gateway.auth.token` or `gateway.token`
- Other settings as fallbacks

### 3. Manual config (override via .env)
Create `.env` to override any setting:
```env
# Only needed if not in OpenClaw config or to override
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=123456789012345678
OPENCLAW_GATEWAY_URL=ws://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your_gateway_token_if_needed
OPENCLAW_TRANSPORT=gateway
STT_BACKEND=openai
OPENAI_API_KEY=sk-...
TTS_BACKEND=edge
ELEVENLABS_API_KEY=
LANGUAGE=ro
```

`DISCORD_GUILD_ID` is recommended for instant slash-command updates in one server.
If gateway client auth rejects the socket connection, set `OPENCLAW_TRANSPORT=cli` to run through the local `openclaw` CLI.

### 4. Use in Discord
1. Invite your bot to the server (needs `Connect` + `Speak` perms in voice channels)
2. Join a voice channel
3. Type `/voice join`
4. Speak — you’ll hear the agent reply in audio
5. Type `/voice leave` when done

## How It Works With Your Existing Setup
- Clawdio connects as an **operator** client to your OpenClaw Gateway
- It uses session key `main` — the same one you use when you type via Telegram, WhatsApp, webchat, etc.
- Your agent sees the full conversation history, can use tools, memories, skills
- **Zero changes needed** to your current OpenClaw setup

## Requirements
- Node.js 18+
- OpenClaw Gateway running (local or remote)
- Discord bot with:
  - `Message Content Intent` enabled
  - `Server Members Intent` enabled
  - Bot invited to server with `Connect` and `Speak` permissions in voice channels
- (Optional) OpenAI API key for STT ($0.006/min) — needed if not using local STT
- (Optional) ElevenLabs API key for premium voices

## STT / TTS Backends

### Speech-to-Text (STT)
| Backend | How to Enable | Notes |
|---------|---------------|-------|
| **OpenAI Whisper API** | `STT_BACKEND=openai` + `OPENAI_API_KEY` | $0.006/min, high accuracy |
| **Local Whisper** | `STT_BACKEND=local` | Runs locally, no API cost (placeholder) |

### Text-to-Speech (TTS)
| Backend | How to Enable | Notes |
|---------|---------------|-------|
| **Microsoft Edge TTS** | `TTS_BACKEND=edge` | **Free**, no API key, multiple languages |
| **ElevenLabs** | `TTS_BACKEND=elevenlabs` + `ELEVENLABS_API_KEY` | Premium voices, voice cloning |
| **Local TTS** | `TTS_BACKEND=local` | Placeholder for local TTS (Piper, Coqui, etc.) |

## Troubleshooting

**"Not connected to OpenClaw Gateway"**
- Verify your OpenClaw Gateway is running and accessible
- Check that `gateway.bind` is set to `loopback` or `0.0.0.0` (not a specific IP)
- Ensure no firewall is blocking port 18789
- The bot converts `http://`/`https://` to `ws://`/`wss://` automatically

**Bot doesn't join voice channel**
- Ensure the bot has `Connect` and `Speak` permissions in that voice channel
- Make sure you're in a voice channel before running `/voice join`
- Check that the bot has the required Discord intents enabled

**Empty transcription / no response**
- For OpenAI STT: verify your `OPENAI_API_KEY` is valid and has credit
- Check console logs for detailed error messages
- Try speaking closer to your microphone

## Architecture

```
clawdio/
├── index.js          # Main bot entry point
├── src/
│   ├── stt.js        # Speech-to-text (OpenAI/local)
│   └── tts.js        # Text-to-speech (Edge/Elevenlabs/local)
├── .env.example      # Environment variables template
└── README.md
```

## License
MIT — feel free to fork and customize for your needs.

## Support
For issues and questions:
- Open an issue on GitHub
- Join the OpenClaw Discord community
