require('dotenv').config();

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  EndBehaviorType,
  StreamType,
  entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');

const STTEngine = require('./src/stt');
const TTSEngine = require('./src/tts');

function loadOpenClawConfig() {
  const configPaths = [
    path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    path.join(os.homedir(), '.openclaw', 'config.json'),
    process.env.OPENCLAW_CONFIG_PATH,
  ].filter(Boolean);

  for (const filePath of configPaths) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        console.log(`Loaded OpenClaw config from: ${filePath}`);
        return parsed;
      }
    } catch (error) {
      console.warn(`Failed to read ${filePath}: ${error.message}`);
    }
  }

  console.warn('No OpenClaw config found, using environment variables only');
  return {};
}

const openclawConfig = loadOpenClawConfig();

let sttBackend = process.env.STT_BACKEND || openclawConfig?.sttBackend;
if (!sttBackend) {
  sttBackend = process.env.OPENAI_API_KEY || openclawConfig?.models?.openai?.apiKey ? 'openai' : 'local';
}

const gatewayPort = openclawConfig?.gateway?.port || 18789;
const gatewayBind = openclawConfig?.gateway?.bind || 'localhost';
const bindHost = gatewayBind === 'loopback' ? 'localhost' : gatewayBind;

const CONFIG = {
  discordToken: process.env.DISCORD_BOT_TOKEN || openclawConfig?.channels?.discord?.token || '',
  discordGuildId: process.env.DISCORD_GUILD_ID || '',
  openclawGatewayUrl:
    process.env.OPENCLAW_GATEWAY_URL || `ws://${bindHost}:${gatewayPort}`,
  openclawGatewayToken:
    process.env.OPENCLAW_GATEWAY_TOKEN ||
    openclawConfig?.gateway?.auth?.token ||
    openclawConfig?.gateway?.token ||
    '',
  sessionKey: process.env.OPENCLAW_SESSION_KEY || 'main',
  sttBackend,
  openaiApiKey: process.env.OPENAI_API_KEY || openclawConfig?.models?.openai?.apiKey || '',
  ttsBackend: process.env.TTS_BACKEND || openclawConfig?.messages?.tts?.backend || 'edge',
  elevenLabsApiKey:
    process.env.ELEVENLABS_API_KEY || openclawConfig?.messages?.tts?.elevenlabs?.apiKey || '',
  elevenLabsVoiceId:
    process.env.ELEVENLABS_VOICE_ID || openclawConfig?.messages?.tts?.elevenlabs?.voiceId || '',
  language: process.env.LANGUAGE || 'ro',
  minUtteranceMs: Number(process.env.MIN_UTTERANCE_MS || 350),
  maxUtteranceMs: Number(process.env.MAX_UTTERANCE_MS || 12000),
};

function validateConfig() {
  const missing = [];
  if (!CONFIG.discordToken) missing.push('DISCORD_BOT_TOKEN or channels.discord.token');
  if (CONFIG.sttBackend === 'openai' && !CONFIG.openaiApiKey) {
    missing.push('OPENAI_API_KEY or models.openai.apiKey');
  }

  if (missing.length > 0) {
    console.error('\nMissing configuration:');
    for (const entry of missing) console.error(`- ${entry}`);
    process.exit(1);
  }

  console.log('\nConfiguration:');
  console.log(`- STT: ${CONFIG.sttBackend}`);
  console.log(`- TTS: ${CONFIG.ttsBackend}`);
  console.log(`- Gateway: ${CONFIG.openclawGatewayUrl}`);
  console.log(`- Session: ${CONFIG.sessionKey}`);
  if (CONFIG.discordGuildId) {
    console.log(`- Slash scope: guild ${CONFIG.discordGuildId}`);
  } else {
    console.log('- Slash scope: global');
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const sttEngine = new STTEngine(CONFIG);
const ttsEngine = new TTSEngine(CONFIG);

let gatewayWs = null;
let gatewayConnected = false;
let gatewayChallengeNonce = null;

const voiceConnections = new Map();
const audioPlayers = new Map();
const collectors = new Map();
const pendingByRequestId = new Map();
const pendingQueue = [];
const playbackQueues = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Voice commands for OpenClaw')
    .addSubcommand((sub) => sub.setName('join').setDescription('Join your current voice channel'))
    .addSubcommand((sub) => sub.setName('leave').setDescription('Leave voice channel'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show voice status')),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.discordToken);
  const body = commands.map((c) => c.toJSON());

  if (CONFIG.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, CONFIG.discordGuildId), { body });
    console.log(`Slash commands registered in guild ${CONFIG.discordGuildId}`);
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body });
    console.log('Global slash commands registered');
  }
}

function connectGateway() {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) return;

  gatewayWs = new WebSocket(CONFIG.openclawGatewayUrl);

  gatewayWs.on('open', () => {
    console.log('Gateway socket open, waiting for challenge');
  });

  gatewayWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void handleGatewayMessage(msg);
  });

  gatewayWs.on('close', () => {
    gatewayConnected = false;
    gatewayChallengeNonce = null;
    console.log('Gateway disconnected, retrying in 5s');
    setTimeout(connectGateway, 5000);
  });

  gatewayWs.on('error', (err) => {
    console.error(`Gateway error: ${err.message}`);
  });
}

function sendGatewayFrame(frame) {
  if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) return;
  gatewayWs.send(JSON.stringify(frame));
}

function sendGatewayConnect() {
  sendGatewayFrame({
    type: 'req',
    id: `connect-${Date.now()}`,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: 'clawdio', version: '1.1.0', platform: 'node', mode: 'operator' },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token: CONFIG.openclawGatewayToken },
      device: {
        id: 'clawdio-device',
        nonce: gatewayChallengeNonce || '',
        publicKey: '',
        signature: '',
        signedAt: Date.now(),
      },
    },
  });
}

function enqueuePending(guildId, requestId, idempotencyKey) {
  const item = {
    guildId,
    requestId,
    idempotencyKey,
    sentAt: Date.now(),
  };
  pendingByRequestId.set(requestId, item);
  pendingQueue.push(item);
}

function popPendingForResponse(responseRequestId) {
  const now = Date.now();

  if (responseRequestId && pendingByRequestId.has(responseRequestId)) {
    const exact = pendingByRequestId.get(responseRequestId);
    pendingByRequestId.delete(responseRequestId);
    const idx = pendingQueue.findIndex((x) => x.requestId === responseRequestId);
    if (idx >= 0) pendingQueue.splice(idx, 1);
    return exact;
  }

  while (pendingQueue.length > 0) {
    const first = pendingQueue.shift();
    pendingByRequestId.delete(first.requestId);
    if (now - first.sentAt <= 120000) {
      return first;
    }
  }

  return null;
}

function extractTextFromPayload(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.content === 'string') return payload.content;

  if (Array.isArray(payload.content)) {
    const textParts = payload.content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block.text === 'string') return block.text;
        if (block && typeof block.content === 'string') return block.content;
        return '';
      })
      .filter(Boolean);
    return textParts.join('\n').trim();
  }

  return '';
}

async function handleGatewayMessage(msg) {
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    gatewayChallengeNonce = msg.payload?.nonce || '';
    sendGatewayConnect();
    return;
  }

  if (msg.type === 'res' && String(msg.id || '').startsWith('connect-')) {
    gatewayConnected = !!msg.ok;
    console.log(gatewayConnected ? 'Gateway authenticated' : 'Gateway auth failed');
    return;
  }

  if (!gatewayConnected) return;

  let responseText = '';
  let responseRequestId = null;

  if (msg.type === 'res' && String(msg.id || '').startsWith('send-')) {
    responseRequestId = msg.id;
    responseText = extractTextFromPayload(msg.payload);
  }

  if (msg.type === 'event' && (msg.event === 'chat.response' || msg.event === 'agent')) {
    responseText = extractTextFromPayload(msg.payload);
    responseRequestId = msg.payload?.requestId || msg.payload?.replyTo || null;
  }

  if (!responseText) return;

  const pending = popPendingForResponse(responseRequestId);
  if (!pending) {
    return;
  }

  await speakInGuild(pending.guildId, responseText);
}

function downmixStereoToMono16le(stereoBuffer) {
  const sampleCount = Math.floor(stereoBuffer.length / 4);
  const mono = Buffer.alloc(sampleCount * 2);

  for (let i = 0; i < sampleCount; i += 1) {
    const left = stereoBuffer.readInt16LE(i * 4);
    const right = stereoBuffer.readInt16LE(i * 4 + 2);
    const mixed = Math.max(-32768, Math.min(32767, Math.trunc((left + right) / 2)));
    mono.writeInt16LE(mixed, i * 2);
  }

  return mono;
}

function collectorKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function setupReceiver(guildId, connection) {
  const receiver = connection.receiver;
  if (!receiver) return;

  receiver.speaking.on('start', (userId) => {
    const key = collectorKey(guildId, userId);
    if (collectors.has(key)) return;

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 700,
      },
    });

    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const state = {
      guildId,
      userId,
      chunks: [],
      startedAt: Date.now(),
      bytes: 0,
    };
    collectors.set(key, state);

    opusStream.on('error', () => {
      collectors.delete(key);
    });

    decoder.on('data', (pcmStereo) => {
      const mono = downmixStereoToMono16le(pcmStereo);
      state.chunks.push(mono);
      state.bytes += mono.length;
      const elapsed = Date.now() - state.startedAt;
      if (elapsed > CONFIG.maxUtteranceMs) {
        opusStream.destroy();
      }
    });

    decoder.on('error', () => {
      collectors.delete(key);
    });

    decoder.on('end', async () => {
      collectors.delete(key);
      const elapsed = Date.now() - state.startedAt;
      if (elapsed < CONFIG.minUtteranceMs) return;
      if (state.bytes < 16000) return;

      const pcmMono = Buffer.concat(state.chunks);
      await processUtterance(guildId, pcmMono);
    });

    opusStream.pipe(decoder);
  });
}

async function processUtterance(guildId, pcmMonoBuffer) {
  try {
    const text = (await sttEngine.transcribe(pcmMonoBuffer, CONFIG.language)).trim();
    if (!text) return;

    console.log(`Heard (${guildId}): ${text}`);
    sendTextToGateway(guildId, text);
  } catch (error) {
    console.error(`STT failed: ${error.message}`);
  }
}

function sendTextToGateway(guildId, text) {
  if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN || !gatewayConnected) {
    console.warn('Gateway unavailable, dropping utterance');
    return;
  }

  const requestId = `send-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const idempotencyKey = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  enqueuePending(guildId, requestId, idempotencyKey);

  sendGatewayFrame({
    type: 'req',
    id: requestId,
    method: 'chat.send',
    params: {
      sessionKey: CONFIG.sessionKey,
      message: text,
      idempotencyKey,
    },
  });
}

async function enqueuePlayback(guildId, task) {
  const prev = playbackQueues.get(guildId) || Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(task)
    .catch((err) => {
      console.error(`Playback error (${guildId}): ${err.message}`);
    });
  playbackQueues.set(guildId, next);
  await next;
}

async function speakInGuild(guildId, text) {
  const connection = voiceConnections.get(guildId);
  if (!connection) return;

  await enqueuePlayback(guildId, async () => {
    const tts = await ttsEngine.synthesize(text, CONFIG.language);
    if (!tts.audio || tts.audio.length === 0) return;

    const player =
      audioPlayers.get(guildId) ||
      (() => {
        const p = createAudioPlayer();
        audioPlayers.set(guildId, p);
        connection.subscribe(p);
        return p;
      })();

    const stream = Readable.from(tts.audio);
    const resource = createAudioResource(stream, {
      inputType: tts.format === 'webmOpus' ? StreamType.WebmOpus : StreamType.Arbitrary,
    });

    await new Promise((resolve, reject) => {
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onErr = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        player.off(AudioPlayerStatus.Idle, onIdle);
        player.off('error', onErr);
      };

      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once('error', onErr);
      player.play(resource);
    });
  });
}

function cleanupGuild(guildId) {
  const conn = voiceConnections.get(guildId);
  if (conn) {
    try {
      conn.destroy();
    } catch {
      // ignore
    }
  }
  voiceConnections.delete(guildId);

  const player = audioPlayers.get(guildId);
  if (player) {
    try {
      player.stop();
    } catch {
      // ignore
    }
  }
  audioPlayers.delete(guildId);
  playbackQueues.delete(guildId);

  for (let i = pendingQueue.length - 1; i >= 0; i -= 1) {
    if (pendingQueue[i].guildId === guildId) {
      pendingByRequestId.delete(pendingQueue[i].requestId);
      pendingQueue.splice(i, 1);
    }
  }
}

async function onVoiceJoin(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Server-only command', ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const channel = member.voice?.channel;
  if (!channel) {
    await interaction.reply({ content: 'Join a voice channel first', ephemeral: true });
    return;
  }

  if (voiceConnections.has(interaction.guild.id)) {
    await interaction.reply({ content: 'Already connected', ephemeral: true });
    return;
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  voiceConnections.set(interaction.guild.id, connection);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      cleanupGuild(interaction.guild.id);
    }
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log(`Voice ready in guild ${interaction.guild.id}`);
    setupReceiver(interaction.guild.id, connection);
  });

  await interaction.reply({ content: `Joined ${channel.name}`, ephemeral: false });
}

async function onVoiceLeave(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Server-only command', ephemeral: true });
    return;
  }

  if (!voiceConnections.has(interaction.guild.id)) {
    await interaction.reply({ content: 'Not connected', ephemeral: true });
    return;
  }

  cleanupGuild(interaction.guild.id);
  await interaction.reply({ content: 'Left voice channel', ephemeral: false });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'voice') return;

  try {
    const sub = interaction.options.getSubcommand();
    if (sub === 'join') {
      await onVoiceJoin(interaction);
      return;
    }
    if (sub === 'leave') {
      await onVoiceLeave(interaction);
      return;
    }
    if (sub === 'status') {
      const status = interaction.guild && voiceConnections.has(interaction.guild.id) ? 'connected' : 'idle';
      await interaction.reply({
        content: `Voice: ${status}, Gateway: ${gatewayConnected ? 'connected' : 'disconnected'}, Pending: ${pendingQueue.length}`,
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error(`Interaction failed: ${error.message}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Command failed', ephemeral: true });
    }
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  connectGateway();
});

function shutdown() {
  console.log('Shutting down');
  for (const guildId of Array.from(voiceConnections.keys())) {
    cleanupGuild(guildId);
  }
  collectors.clear();
  pendingByRequestId.clear();
  pendingQueue.length = 0;

  if (gatewayWs) {
    try {
      gatewayWs.close();
    } catch {
      // ignore
    }
  }

  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

validateConfig();
client.login(CONFIG.discordToken).catch((error) => {
  console.error(`Discord login failed: ${error.message}`);
  process.exit(1);
});
