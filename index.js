require('dotenv').config();

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const STTEngine = require('./src/stt');
const TTSEngine = require('./src/tts');

// ── Configuration ──────────────────────────────────────────────

const CONFIG = {
  discordToken: process.env.DISCORD_BOT_TOKEN || '',
  openclawGatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'ws://localhost:18789',
  openclawGatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || '',
  sttBackend: process.env.STT_BACKEND || 'openai',
  ttsBackend: process.env.TTS_BACKEND || 'edge',
  language: process.env.LANGUAGE || 'ro',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
};

// Validate required config
function validateConfig() {
  const missing = [];
  if (!CONFIG.discordToken) missing.push('DISCORD_BOT_TOKEN');
  if (!CONFIG.openaiApiKey && CONFIG.sttBackend === 'openai') missing.push('OPENAI_API_KEY');

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
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

  gatewayWs.on('close', (code, reason) => {
    console.log(`Disconnected from OpenClaw Gateway (code: ${code})`);
    gatewayConnected = false;
    pendingChallenge = null;
    // Reconnect after 5 seconds
    setTimeout(connectToGateway, 5000);
  });

  gatewayWs.on('error', (error) => {
    console.error('Gateway WebSocket error:', error.message);
  });
}

function handleGatewayMessage(message) {
  // Wait for challenge before sending connect
  if (message.type === 'event' && message.event === 'connect.challenge') {
    pendingChallenge = message.payload.nonce;
    console.log('Received challenge, sending connect request...');
    sendConnectRequest();
    return;
  }

  // Handle connect response
  if (message.type === 'res' && message.id?.startsWith('connect-')) {
    if (message.ok) {
      console.log('Successfully connected to OpenClaw Gateway');
      gatewayConnected = true;
      if (message.payload?.auth?.deviceToken) {
        console.log('Device token received (save for future connections)');
      }
    } else {
      console.error('Failed to connect to OpenClaw Gateway:', message.error);
      gatewayConnected = false;
    }
    return;
  }

  // Handle events
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
        id: 'discord-voice-plugin',
        version: '1.0.0',
        platform: 'node',
        mode: 'operator',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token: CONFIG.openclawGatewayToken },
      device: {
        id: 'discord-voice-plugin-device',
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
  // Extract text from agent response
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

  console.log(`Agent response: "${text.slice(0, 100)}..."`);

  // Find active voice connection and play TTS
  for (const [guildId, connection] of voiceConnections) {
    try {
      const ttsResult = await ttsEngine.synthesize(text, CONFIG.language);
      if (ttsResult.audio && ttsResult.audio.length > 0) {
        await playAudioInConnection(connection, ttsResult.audio, ttsResult.format);
        console.log(`TTS played in guild ${guildId}`);
      }
    } catch (error) {
      console.error(`Error playing TTS in guild ${guildId}:`, error.message);
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
      console.log(`Connected to voice channel in guild ${interaction.guild.id}`);
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

    await interaction.reply({ content: `Joined **${voiceChannel.name}** — voice conversation started!`, ephemeral: false });
  } catch (error) {
    console.error('Error joining voice channel:', error.message);
    await interaction.reply({ content: `Failed to join voice channel: ${error.message}`, ephemeral: true });
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
  await interaction.reply({ content: 'Left voice channel and stopped voice conversation.', ephemeral: false });
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

  console.log(`Setting up audio receiver for guild ${guildId}`);

  receiver.speaking.on('start', (userId) => {
    if (!isRecording.get(guildId)) return;

    console.log(`User ${userId} started speaking in guild ${guildId}`);

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: 1, duration: 1000 }, // End after 1s silence
    });

    const chunks = [];
    audioStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    audioStream.on('end', async () => {
      if (chunks.length === 0) return;

      const audioBuffer = Buffer.concat(chunks);
      console.log(`Received ${audioBuffer.length} bytes of audio from user ${userId}`);

      // Process audio: STT -> Gateway -> TTS -> Play
      await processAudio(guildId, audioBuffer);
    });

    audioStream.on('error', (err) => {
      console.error(`Audio stream error for user ${userId}:`, err.message);
    });
  });
}

async function processAudio(guildId, audioBuffer) {
  try {
    console.log(`Processing audio for guild ${guildId} (${audioBuffer.length} bytes)`);

    // Step 1: STT
    const transcription = await sttEngine.transcribe(audioBuffer, CONFIG.language);
    console.log(`Transcription: "${transcription}"`);

    if (!transcription || transcription.trim() === '') {
      console.log('Empty transcription, skipping...');
      return;
    }

    // Step 2: Send to OpenClaw Gateway
    sendToGateway(transcription);
  } catch (error) {
    console.error('Error processing audio:', error.message);
  }
}

async function playAudioInConnection(connection, audioBuffer, format = 'mp3') {
  const { createAudioResource, createAudioPlayer } = require('@discordjs/voice');

  if (!audioBuffer || audioBuffer.length === 0) {
    console.warn('Empty audio buffer, skipping playback');
    return;
  }

  // Save to temp file
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempFile = path.join(tempDir, `tts_${Date.now()}.${format}`);
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

    // Cleanup temp file after playback
    player.once(AudioPlayerStatus.Idle, () => {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
    });
  } catch (error) {
    console.error('Error playing audio:', error.message);
    // Cleanup on error
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {}
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
        const isConnected = voiceConnections.has(interaction.guild.id);
        await interaction.reply({
          content: isConnected ? 'Connected to voice channel.' : 'Not connected to any voice channel.',
          ephemeral: true,
        });
        break;
    }
  } catch (error) {
    console.error('Interaction error:', error.message);
    const reply = { content: `Error: ${error.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

// ── Startup & Shutdown ────────────────────────────────────────

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await registerCommands();
  connectToGateway();
});

validateConfig();
client.login(CONFIG.discordToken).catch((error) => {
  console.error('Failed to login to Discord:', error.message);
  process.exit(1);
});

function shutdown() {
  console.log('Shutting down...');
  for (const [, connection] of voiceConnections) {
    connection.destroy();
  }
  voiceConnections.clear();
  audioPlayers.clear();
  isRecording.clear();

  if (gatewayWs) gatewayWs.close();
  client.destroy();

  // Clean temp directory
  const tempDir = path.join(__dirname, 'temp');
  try {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        fs.unlinkSync(path.join(tempDir, file));
      }
    }
  } catch {}

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
