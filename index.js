require('dotenv').config();

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const STTEngine = require('./src/stt');
const TTSEngine = require('./src/tts');

// ── OpenClaw Config Loader ────────────────────────────────────

function loadOpenClawConfig() {
  const configPaths = [
    path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    path.join(os.homedir(), '.openclaw', 'config.json'),
    process.env.OPENCLAW_CONFIG_PATH,
  ].filter(Boolean);

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(content);
        console.log(`Loaded OpenClaw config from: ${configPath}`);
        return config;
      }
    } catch (error) {
      console.warn(`Failed to load config from ${configPath}:`, error.message);
    }
  }

  console.warn('No OpenClaw config found, using environment variables only');
  return {};
}

// ── Configuration ──────────────────────────────────────────────

const openclawConfig = loadOpenClawConfig();

const CONFIG = {
  // Discord - from env or OpenClaw config
  discordToken: process.env.DISCORD_BOT_TOKEN || openclawConfig?.channels?.discord?.token || '',

  // Gateway - from env or OpenClaw config
  openclawGatewayUrl: process.env.OPENCLAW_GATEWAY_URL
    || (openclawConfig?.gateway?.bind?.replace('loopback', 'localhost') || 'ws://localhost:18789')
    .replace('http://', 'ws://')
    .replace('https://', 'wss://')
    + (openclawConfig?.gateway?.port ? `:${openclawConfig.gateway.port}` : ':18789'),

  openclawGatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN
    || process.env.OPENCLAW_GATEWAY_TOKEN
    || openclawConfig?.gateway?.auth?.token
    || openclawConfig?.gateway?.token
    || '',

  // STT
  sttBackend: process.env.STT_BACKEND || 'openai',
  openaiApiKey: process.env.OPENAI_API_KEY || openclawConfig?.models?.openai?.apiKey || '',

  // TTS
  ttsBackend: process.env.TTS_BACKEND || 'edge',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || openclawConfig?.messages?.tts?.elevenlabs?.apiKey || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || openclawConfig?.messages?.tts?.elevenlabs?.voiceId || '',

  // Language
  language: process.env.LANGUAGE || 'ro',
};

// Validate required config
function validateConfig() {
  const missing = [];

  if (!CONFIG.discordToken) {
    missing.push('DISCORD_BOT_TOKEN (or channels.discord.token in OpenClaw config)');
  }
  if (!CONFIG.openaiApiKey && CONFIG.sttBackend === 'openai') {
    missing.push('OPENAI_API_KEY (or models.openai.apiKey in OpenClaw config)');
  }

  if (missing.length > 0) {
    console.error('\n❌ Missing required configuration:');
    missing.forEach(m => console.error(`   - ${m}`));
    console.error('\nYou can either:');
    console.error('   1. Set environment variables in .env');
    console.error('   2. Ensure ~/.openclaw/openclaw.json has the required fields');
    console.error('\nConfig search order:');
    console.error('   - Environment variables (highest priority)');
    console.error('   - ~/.openclaw/openclaw.json');
    console.error('');
    process.exit(1);
  }

  console.log('\n✅ Configuration loaded:');
  console.log(`   STT Backend: ${CONFIG.sttBackend}`);
  console.log(`   TTS Backend: ${CONFIG.ttsBackend}`);
  console.log(`   Gateway: ${CONFIG.openclawGatewayUrl}`);
  console.log(`   Language: ${CONFIG.language}`);
}

// ── State ──────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const sttEngine = new STTEngine(CONFIG);
const ttsEngine = new TTSEngine(CONFIG);

let gatewayWs = null;
let gatewayConnected = false;
let pendingChallenge = null;
const voiceConnections = new Map();
const audioPlayers = new Map();
const isRecording = new Map();

// ── Slash Commands ─────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Voice commands for OpenClaw')
    .addSubcommand(sub =>
      sub.setName('join').setDescription('Join your voice channel and start voice conversation')
    )
    .addSubcommand(sub =>
      sub.setName('leave').setDescription('Leave voice channel and stop voice conversation')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Check voice status')
    ),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.discordToken);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map(cmd => cmd.toJSON()),
    });
    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// ── OpenClaw Gateway ───────────────────────────────────────────

function connectToGateway() {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
    console.log('Already connected to OpenClaw Gateway');
    return;
  }

  const wsUrl = CONFIG.openclawGatewayUrl;
  console.log(`Connecting to OpenClaw Gateway at ${wsUrl}...`);

  gatewayWs = new WebSocket(wsUrl);

  gatewayWs.on('open', () => {
    console.log('WebSocket connected, waiting for challenge...');
  });

  gatewayWs.on('message', (rawData) => {
    try {
      const data = rawData.toString();
      const message = JSON.parse(data);
      handleGatewayMessage(message);
    } catch (error) {
      console.error('Error parsing gateway message:', error.message);
    }
  });

  gatewayWs.on('close', (code) => {
    console.log(`Disconnected from OpenClaw Gateway (code: ${code})`);
    gatewayConnected = false;
    pendingChallenge = null;
    setTimeout(connectToGateway, 5000);
  });

  gatewayWs.on('error', (error) => {
    console.error('Gateway WebSocket error:', error.message);
  });
}

function handleGatewayMessage(message) {
  if (message.type === 'event' && message.event === 'connect.challenge') {
    pendingChallenge = message.payload.nonce;
    console.log('Received challenge, sending connect request...');
    sendConnectRequest();
    return;
  }

  if (message.type === 'res' && message.id?.startsWith('connect-')) {
    if (message.ok) {
      console.log('✅ Successfully connected to OpenClaw Gateway');
      gatewayConnected = true;
    } else {
      console.error('❌ Failed to connect to OpenClaw Gateway:', message.error);
      gatewayConnected = false;
    }
    return;
  }

  if (message.type === 'event') {
    console.log(`Gateway event: ${message.event}`);

    if (message.event === 'agent' && message.payload) {
      handleAgentResponse(message.payload);
    }
  }
}

function sendConnectRequest() {
  if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) return;

  const connectRequest = {
    type: 'req',
    id: `connect-${Date.now()}`,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'clawdio',
        version: '1.0.0',
        platform: 'node',
        mode: 'operator',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token: CONFIG.openclawGatewayToken },
      device: {
        id: 'clawdio-device',
        nonce: pendingChallenge || '',
        publicKey: '',
        signature: '',
        signedAt: Date.now(),
      },
    },
  };

  gatewayWs.send(JSON.stringify(connectRequest));
}

function sendToGateway(text) {
  if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
    console.error('Not connected to OpenClaw Gateway');
    return;
  }

  if (!gatewayConnected) {
    console.error('Gateway not authenticated yet');
    return;
  }

  const request = {
    type: 'req',
    id: `send-${Date.now()}`,
    method: 'chat.send',
    params: {
      sessionKey: 'main',
      message: text,
      idempotencyKey: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  };

  gatewayWs.send(JSON.stringify(request));
}

async function handleAgentResponse(payload) {
  let text = '';
  if (typeof payload === 'string') {
    text = payload;
  } else if (payload?.message) {
    text = payload.message;
  } else if (payload?.text) {
    text = payload.text;
  } else if (payload?.content) {
    text = payload.content;
  }

  if (!text || text.trim() === '') return;

  console.log(`Agent: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

  for (const [guildId, connection] of voiceConnections) {
    try {
      const ttsResult = await ttsEngine.synthesize(text, CONFIG.language);
      if (ttsResult.audio && ttsResult.audio.length > 0) {
        await playAudioInConnection(connection, ttsResult.audio, ttsResult.format);
      }
    } catch (error) {
      console.error(`TTS error for guild ${guildId}:`, error.message);
    }
  }
}

// ── Voice Connection ───────────────────────────────────────────

async function handleJoinVoiceChannel(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command only works in servers.', ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: 'You must be in a voice channel first!', ephemeral: true });
    return;
  }

  if (voiceConnections.has(interaction.guild.id)) {
    await interaction.reply({ content: 'Already connected to a voice channel!', ephemeral: true });
    return;
  }

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    voiceConnections.set(interaction.guild.id, connection);
    isRecording.set(interaction.guild.id, true);

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`Connected to voice channel: ${voiceChannel.name}`);
      setupAudioReceiver(interaction.guild.id, connection);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        cleanupGuild(interaction.guild.id);
      }
    });

    await interaction.reply({
      content: `🎙️ Joined **${voiceChannel.name}** — speak and I'll listen!`,
      ephemeral: false,
    });
  } catch (error) {
    console.error('Error joining voice channel:', error.message);
    await interaction.reply({ content: `Failed to join: ${error.message}`, ephemeral: true });
  }
}

async function handleLeaveVoiceChannel(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command only works in servers.', ephemeral: true });
    return;
  }

  const connection = voiceConnections.get(interaction.guild.id);
  if (!connection) {
    await interaction.reply({ content: 'Not connected to a voice channel!', ephemeral: true });
    return;
  }

  connection.destroy();
  cleanupGuild(interaction.guild.id);
  await interaction.reply({ content: '👋 Left the voice channel.', ephemeral: false });
}

function cleanupGuild(guildId) {
  voiceConnections.delete(guildId);
  const player = audioPlayers.get(guildId);
  if (player) {
    player.stop();
    audioPlayers.delete(guildId);
  }
  isRecording.delete(guildId);
  console.log(`Cleaned up guild ${guildId}`);
}

// ── Audio Processing ───────────────────────────────────────────

function setupAudioReceiver(guildId, connection) {
  const receiver = connection.receiver;
  if (!receiver) {
    console.error('No audio receiver available');
    return;
  }

  console.log(`Audio receiver ready for guild ${guildId}`);

  receiver.speaking.on('start', (userId) => {
    if (!isRecording.get(guildId)) return;

    console.log(`User ${userId} started speaking`);

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: 1, duration: 1000 },
    });

    const chunks = [];
    audioStream.on('data', (chunk) => chunks.push(chunk));

    audioStream.on('end', async () => {
      if (chunks.length === 0) return;

      const audioBuffer = Buffer.concat(chunks);
      console.log(`Audio received: ${audioBuffer.length} bytes`);
      await processAudio(guildId, audioBuffer);
    });

    audioStream.on('error', (err) => {
      console.error(`Audio stream error:`, err.message);
    });
  });
}

async function processAudio(guildId, audioBuffer) {
  try {
    const transcription = await sttEngine.transcribe(audioBuffer, CONFIG.language);
    console.log(`You: "${transcription}"`);

    if (!transcription || transcription.trim() === '') return;
    sendToGateway(transcription);
  } catch (error) {
    console.error('Error processing audio:', error.message);
  }
}

async function playAudioInConnection(connection, audioBuffer, format = 'mp3') {
  const { createAudioPlayer } = require('@discordjs/voice');

  if (!audioBuffer || audioBuffer.length === 0) return;

  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempFile = path.join(tempDir, `tts_${Date.now()}.mp3`);
  fs.writeFileSync(tempFile, audioBuffer);

  try {
    const resource = createAudioResource(tempFile);
    let player = audioPlayers.get(connection.joinConfig.guildId);

    if (!player) {
      player = createAudioPlayer();
      audioPlayers.set(connection.joinConfig.guildId, player);
      connection.subscribe(player);
    }

    player.play(resource);

    player.once(AudioPlayerStatus.Idle, () => {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
    });
  } catch (error) {
    console.error('Error playing audio:', error.message);
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
  }
}

// ── Interaction Handler ────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'voice') return;

  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'join':
        await handleJoinVoiceChannel(interaction);
        break;
      case 'leave':
        await handleLeaveVoiceChannel(interaction);
        break;
      case 'status':
        if (!interaction.guild) {
          await interaction.reply({ content: 'This command only works in servers.', ephemeral: true });
          return;
        }
        await interaction.reply({
          content: voiceConnections.has(interaction.guild.id)
            ? '✅ Connected to voice channel.'
            : '❌ Not connected to any voice channel.',
          ephemeral: true,
        });
        break;
    }
  } catch (error) {
    console.error('Interaction error:', error.message);
  }
});

// ── Startup & Shutdown ────────────────────────────────────────

client.once('ready', async () => {
  console.log(`\n🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
  connectToGateway();
});

validateConfig();
client.login(CONFIG.discordToken).catch((error) => {
  console.error('Failed to login to Discord:', error.message);
  process.exit(1);
});

function shutdown() {
  console.log('\nShutting down...');
  for (const [, connection] of voiceConnections) {
    connection.destroy();
  }
  voiceConnections.clear();
  audioPlayers.clear();
  isRecording.clear();

  if (gatewayWs) gatewayWs.close();
  client.destroy();

  const tempDir = path.join(__dirname, 'temp');
  try {
    if (fs.existsSync(tempDir)) {
      for (const file of fs.readdirSync(tempDir)) {
        fs.unlinkSync(path.join(tempDir, file));
      }
    }
  } catch {}

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
