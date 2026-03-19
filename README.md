# Clawdio — OpenClaw Discord Voice Plugin

**Clawdio** is a Discord bot plugin that brings real-time voice conversations to OpenClaw. Join a Discord voice channel and talk to your OpenClaw AI agent using speech-to-text and text-to-speech — no typing required.

## Features

- **Real-time voice conversations** — Speak directly to your OpenClaw agent from any Discord voice channel
- **Multiple STT backends** — OpenAI Whisper API (default) or local Whisper
- **Multiple TTS backends** — Microsoft Edge TTS (free, no API key), ElevenLabs, or local TTS
- **OpenClaw Gateway integration** — Your agent retains full context and memory across conversations
- **Interrupt support** — Speak while the agent is talking to interrupt and redirect
- **Self-contained** — Works with free cloud APIs or fully local if you prefer

## How it works

```
You (voice) → Discord → Audio Capture → VAD → STT → OpenClaw Gateway → Agent
                                                                              ↓
You (voice) ← Discord ← Audio Playback ← TTS ← Agent Response ←──────────────
```

## Prerequisites

- Node.js 18+
- A Discord bot with **Message Content Intent** and **Server Members Intent** enabled
- An OpenClaw Gateway running locally or accessible via WebSocket
- (Optional) OpenAI API key for Whisper STT
- (Optional) ElevenLabs API key for premium TTS voices

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/serverul/clawdio.git
cd clawdio
npm install
```

### 2. Configure your environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
OPENCLAW_GATEWAY_URL=ws://localhost:18789
OPENCLAW_GATEWAY_TOKEN=           # only if your gateway requires auth
STT_BACKEND=openai                # 'openai' or 'local'
OPENAI_API_KEY=sk-...             # required for OpenAI STT
TTS_BACKEND=edge                   # 'edge' or 'elevenlabs'
ELEVENLABS_API_KEY=               # required for ElevenLabs TTS
LANGUAGE=ro                        # 'ro' for Romanian, 'en' for English
```

### 3. Create and invite your Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → **Bot**
3. Enable **Message Content Intent** and **Server Members Intent**
4. Copy the **Bot Token**
5. Under **OAuth2 → URL Generator**, select:
   - `bot` scope
   - Permissions: `Send Messages`, `Use Slash Commands`, `Connect`, `Speak`
6. Use the generated URL to invite the bot to your server

### 4. Run

```bash
npm start
```

### 5. Use

In Discord, use the slash commands:

| Command | Description |
|---------|-------------|
| `/voice join` | Join your current voice channel and start a voice conversation |
| `/voice leave` | Leave the voice channel and stop the conversation |
| `/voice status` | Check if the bot is connected to a voice channel |

Join a voice channel, say something, and the bot will transcribe your speech, send it to the OpenClaw agent, convert the response to audio, and play it back to you.

## Architecture

```
clawdio/
├── index.js          # Main bot entry point
├── src/
│   ├── stt.js       # Speech-to-text engine (OpenAI / local)
│   └── tts.js       # Text-to-speech engine (Edge / ElevenLabs / local)
├── .env.example      # Environment variables template
└── README.md
```

## STT / TTS Backends

### Speech-to-Text (STT)

| Backend | Config | Notes |
|---------|--------|-------|
| **OpenAI Whisper API** | `STT_BACKEND=openai`, `OPENAI_API_KEY` | $0.006/min, high accuracy, low latency |
| **Local Whisper** | `STT_BACKEND=local` | Runs locally, no API cost |

### Text-to-Speech (TTS)

| Backend | Config | Notes |
|---------|--------|-------|
| **Microsoft Edge TTS** | `TTS_BACKEND=edge` | **Free**, no API key, multiple languages |
| **ElevenLabs** | `TTS_BACKEND=elevenlabs`, `ELEVENLABS_API_KEY` | Premium voices, voice cloning |
| **Local TTS** | `TTS_BACKEND=local` | Placeholder for local TTS (Piper, Coqui, etc.) |

## Gateway Connection

The bot connects to the OpenClaw Gateway via WebSocket as an **operator** client using the `chat.send` method on session key `main`. This means:

- The bot shares the same conversation history as your other OpenClaw clients
- Agent tools, memory, and context are all preserved
- Works with any OpenClaw channel (Telegram, WhatsApp, Discord text, etc.) in the same session

If the gateway is unavailable, the bot logs an error and attempts to reconnect every 5 seconds.

## Troubleshooting

**Bot doesn't join the voice channel**
- Ensure the bot has `Connect` and `Speak` permissions in that channel
- Make sure you're in a voice channel before running `/voice join`

**"Not connected to OpenClaw Gateway"**
- Verify `OPENCLAW_GATEWAY_URL` is correct (default: `ws://localhost:18789`)
- Make sure the OpenClaw Gateway is running
- Check the gateway token if `OPENCLAW_GATEWAY_TOKEN` is set

**Empty transcription / no response**
- Ensure your microphone is working and loud enough
- For OpenAI STT, verify your `OPENAI_API_KEY` is valid
- Check console logs for detailed error messages

## License

MIT
