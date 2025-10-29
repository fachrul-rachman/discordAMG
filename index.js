// index.js
require('dotenv').config();
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const {
  DISCORD_TOKEN,
  ALLOWED_ROLE_IDS,
  WEBHOOK_CHAT_URL,
  DM_CHECK_GUILD_ID,
  N8N_TIMEOUT_MS = 60000,
  LOG_LEVEL = 'info'
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN belum diset di .env');
  process.exit(1);
}

const allowedRoleIds = (ALLOWED_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const WEBHOOK_CHAT = WEBHOOK_CHAT_URL;
const DM_GUILD_ID = DM_CHECK_GUILD_ID;
const N8N_TIMEOUT = Number(N8N_TIMEOUT_MS) || 60000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

// ----------------- Utilities -----------------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function postJsonWithTimeout(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text || 'null'); } catch (e) { json = null; }
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.message || String(err) };
  }
}

function logDebug(...args) { if (LOG_LEVEL === 'debug') console.debug('[DEBUG]', ...args); }
function logInfo(...args) { console.log('[INFO]', ...args); }
function logWarn(...args) { console.warn('[WARN]', ...args); }
function logErr(...args) { console.error('[ERR]', ...args); }

function memberHasAllowedRole(member) {
  if (!member || allowedRoleIds.length === 0) return false;
  return member.roles.cache.some(r => allowedRoleIds.includes(r.id));
}

async function userHasAllowedRoleInGuild(userId) {
  if (!DM_GUILD_ID || allowedRoleIds.length === 0) return false;
  try {
    const guild = await client.guilds.fetch(DM_GUILD_ID);
    if (!guild) return false;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    return memberHasAllowedRole(member);
  } catch (err) {
    logWarn('Error checking roles in guild:', err.message);
    return false;
  }
}

// sanitize content: remove bot mention tokens like <@123> or <@!123>
function sanitizeContentText(rawText, botId) {
  if (!rawText) return '';
  if (!botId) return rawText.trim();
  const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
  const withoutMentions = rawText.replace(mentionRegex, ' ').replace(/\s+/g, ' ').trim();
  return withoutMentions;
}

function extractAttachments(message) {
  const out = [];
  try {
    if (message.attachments && message.attachments.size > 0) {
      for (const [, att] of message.attachments) {
        out.push({
          id: att.id,
          name: att.name || null,
          url: att.url || null,
          proxyUrl: att.proxyURL || null,
          size: att.size || null,
          contentType: att.contentType || null
        });
      }
    }
  } catch (err) {
    logWarn('extractAttachments error', err.message);
  }
  return out;
}

// ----------------- Payload builders -----------------
function buildChatPayload(message, isEdit = false) {
  const botId = client.user?.id;
  const sanitized = sanitizeContentText(message.content || '', botId);
  return {
    type: 'chat',
    messageId: message.id,
    channelId: message.channel.id,
    channelName: message.channel?.name || null,
    guildId: message.guild?.id || null,
    guildName: message.guild?.name || null,
    author: { id: message.author.id, tag: message.author.tag },
    content: {
      id: message.id,
      text: sanitized,
      raw: message.content || ''
    },
    attachments: extractAttachments(message),
    createdAt: message.createdAt,
    editedAt: message.editedAt || null,
    isEdit,
    link: message.guild ? `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}` : null,
  };
}

// ----------------- Helpers -----------------
async function isReplyToBot(message) {
  if (!message.reference) return false;
  try {
    const ref = message.reference;
    if (!ref.messageId || !ref.channelId) return false;
    const ch = await client.channels.fetch(ref.channelId).catch(() => null);
    if (!ch) return false;
    const referenced = await ch.messages.fetch(ref.messageId).catch(() => null);
    if (!referenced) return false;
    if (!client.user) return false;
    return referenced.author?.id === client.user.id;
  } catch (err) {
    logWarn('isReplyToBot error', err.message);
    return false;
  }
}

function createTypingKeeper(channel) {
  let stopped = false;
  async function start() {
    try { await channel.sendTyping().catch(()=>{}); } catch {}
    const iv = setInterval(() => {
      if (stopped) { clearInterval(iv); return; }
      channel.sendTyping().catch(()=>{});
    }, 8000);
    return () => { stopped = true; clearInterval(iv); };
  }
  return start;
}

function splitIntoChunks(text, maxLen = 2000) {
  if (!text) return [''];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // try to cut at newline or space for nicer split
    let idx = remaining.lastIndexOf('\n', maxLen);
    if (idx === -1) idx = remaining.lastIndexOf(' ', maxLen);
    if (idx === -1) idx = maxLen;
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendReplyWithSplit(message, text) {
  const chunks = splitIntoChunks(text, 2000);
  if (chunks.length === 0) return;
  try {
    // reply first chunk as reply; subsequent chunks as normal messages
    await message.reply({ content: chunks[0], allowedMentions: { repliedUser: false } });
    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send({ content: chunks[i] }).catch(()=>{});
    }
  } catch (err) {
    logErr('Failed to send reply chunks:', err.message);
  }
}

// ----------------- Core processing -----------------
async function processChatMessage(message, isEdit = false) {
  if (!WEBHOOK_CHAT) {
    logWarn('WEBHOOK_CHAT not defined; skipping processing');
    return;
  }

  // role checks
  let okRole = false;
  if (message.guild) {
    const member = await message.guild.members.fetch(message.author.id).catch(()=>null);
    if (member) okRole = memberHasAllowedRole(member);
  } else {
    okRole = await userHasAllowedRoleInGuild(message.author.id);
  }

  if (!okRole) {
    try {
      await message.reply({
        content: 'Maaf — Anda tidak memiliki izin untuk menggunakan fitur ini. Jika Anda rasa ini kesalahan, hubungi admin.',
        allowedMentions: { repliedUser: true }
      });
    } catch (err) {
      logWarn('Gagal mengirim notifikasi role:', err.message);
    }
    return;
  }

  const payload = buildChatPayload(message, isEdit);

  // typing indicator
  const startTyping = createTypingKeeper(message.channel);
  const stopTyping = await startTyping();

  let response;
  try {
    response = await postJsonWithTimeout(WEBHOOK_CHAT, payload, N8N_TIMEOUT);
  } catch (err) {
    response = { ok: false, error: String(err) };
  } finally {
    try { stopTyping(); } catch {}
  }

  if (!response.ok) {
    logWarn('n8n chat webhook failed or timed out:', response.error || response.status);
    try {
      await message.reply({
        content: 'Maaf, layanan pemrosesan sedang mengalami gangguan. Silakan coba lagi nanti.',
        allowedMentions: { repliedUser: true }
      });
    } catch (err) {
      logWarn('gagal mengirim fallback error message:', err.message);
    }
    return;
  }

  // parse n8n response robustly (cover {output}, [ { json: { output } } ], plain text)
  let outputText = null;
  try {
    const { json, text } = response;

    if (json !== null && typeof json === 'object') {
      if (typeof json.output === 'string' && json.output.trim() !== '') {
        outputText = json.output;
      } else if (Array.isArray(json) && json.length > 0) {
        const first = json[0];
        if (first && typeof first === 'object') {
          if (typeof first.output === 'string' && first.output.trim() !== '') outputText = first.output;
          else if (first.json && typeof first.json.output === 'string' && first.json.output.trim() !== '') outputText = first.json.output;
        }
      } else if (json.data && typeof json.data.output === 'string') {
        outputText = json.data.output;
      }
    }

    if (!outputText && text && String(text).trim() !== '') {
      outputText = String(text).trim();
    }
  } catch (err) {
    logWarn('Error parsing n8n response:', err.message);
  }

  if (!outputText) {
    logInfo('n8n returned no output -> no reply sent');
    return;
  }

  // send reply (with splitting if too long)
  await sendReplyWithSplit(message, outputText);
  logInfo('Sent reply for message', message.id);
}

// ----------------- Discord Event handlers -----------------
client.once('ready', () => {
  logInfo(`Bot ready: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;

    let isMention = false;
    let isReply = false;
    if (message.mentions && client.user && message.mentions.has(client.user.id)) isMention = true;
    isReply = await isReplyToBot(message);

    if (!message.guild) {
      const hasRole = await userHasAllowedRoleInGuild(message.author.id);
      if (!hasRole) {
        await message.reply({ content: 'Maaf — Anda tidak memiliki izin untuk mengirim DM ke AI.', allowedMentions: { repliedUser: true } }).catch(()=>null);
        return;
      }
      await processChatMessage(message, false);
      return;
    }

    if (isMention || isReply) {
      await processChatMessage(message, false);
    }
  } catch (err) {
    logErr('messageCreate error:', err);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) {
      try { newMessage = await newMessage.fetch(); } catch {}
    }
    if (!newMessage) return;
    if (newMessage.author?.bot) return;

    const previouslyMentioned = oldMessage && oldMessage.mentions && client.user && oldMessage.mentions.has?.(client.user.id);
    const nowMentioned = newMessage.mentions && client.user && newMessage.mentions.has(client.user.id);

    const prevWasReplyToBot = oldMessage ? await isReplyToBot(oldMessage).catch(()=>false) : false;
    const nowIsReplyToBot = await isReplyToBot(newMessage).catch(()=>false);

    if ((!previouslyMentioned && nowMentioned) || (!prevWasReplyToBot && nowIsReplyToBot)) {
      await processChatMessage(newMessage, true);
    }
  } catch (err) {
    logErr('messageUpdate error:', err);
  }
});

// ----------------- graceful handlers -----------------
process.on('SIGINT', async () => {
  logInfo('SIGINT, shutting down...');
  try { await client.destroy(); } catch {}
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logErr('Unhandled Rejection:', reason);
});

// login
client.login(DISCORD_TOKEN).catch(err => {
  logErr('Failed to login:', err.message);
  process.exit(1);
});
