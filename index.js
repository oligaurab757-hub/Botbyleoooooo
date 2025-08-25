// index.js
// WhatsApp Calculator Bot – Render/Railway ready

// ====================== Imports ======================
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { Pool } = require('pg');

// ====================== Config ======================
const SESSION_LABEL = process.env.SESSION_LABEL || 'bhjs';
const AUTH_DIR = 'auth_info'; // on Render free, FS is ephemeral; you'll need to rescan after restarts
const DATABASE_URL = process.env.DATABASE_URL;

// Postgres (use public URL; Railway internal host won't work on Render)
// SSL: true (Render requires TLS to outside)
const pgPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('railway.app')
    ? { rejectUnauthorized: false }
    : undefined
});

// Make sure our tables exist
async function ensureTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS chat_totals (
      chat_id TEXT PRIMARY KEY,
      total   NUMERIC NOT NULL DEFAULT 0
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      chat_id TEXT NOT NULL,
      msg_id  TEXT NOT NULL,
      PRIMARY KEY (chat_id, msg_id)
    )
  `);
}

// Helpers to format numbers to 2 decimals
function fmt2(n) {
  const num = Number(n);
  if (!isFinite(num)) return '0.00';
  return (Math.round(num * 100) / 100).toFixed(2);
}

// Validate that text is a single-line arithmetic expression
function isSingleLineArithmetic(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.includes('\n')) return false;               // ignore multi-line
  const hasOp = /[+\-*/]/.test(text);                  // must contain an operator
  if (!hasOp) return false;
  // allow digits, spaces, . + - * / and parentheses
  const valid = /^[0-9+\-*/().\s]+$/.test(text);
  return valid;
}

// Safely evaluate expression (after strict validation)
function safeEval(expr) {
  // Extra guard: disallow sequences like ".." or "*/" at ends, etc.
  const cleaned = expr.replace(/\s+/g, '');
  if (!/^[0-9+\-*/().]+$/.test(cleaned)) {
    throw new Error('Invalid characters');
  }
  // Prevent dangerous leading operators that aren't arithmetic-contextual
  // (we already validated allowed chars, so use Function strictly)
  // eslint-disable-next-line no-new-func
  const result = Function(`"use strict"; return (${cleaned});`)();
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error('Invalid result');
  }
  return result;
}

// Running total helpers
async function getTotal(chatId) {
  const { rows } = await pgPool.query('SELECT total FROM chat_totals WHERE chat_id = $1', [chatId]);
  if (rows.length === 0) return 0;
  return Number(rows[0].total) || 0;
}

async function setTotal(chatId, value) {
  await pgPool.query(
    `INSERT INTO chat_totals (chat_id, total)
     VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET total = EXCLUDED.total`,
    [chatId, value]
  );
  return value;
}

async function addToTotal(chatId, delta) {
  const current = await getTotal(chatId);
  const next = current + delta;
  await setTotal(chatId, next);
  return next;
}

// Dedup helpers to avoid double replies
async function alreadyProcessed(chatId, msgId) {
  const { rows } = await pgPool.query(
    'SELECT 1 FROM processed_messages WHERE chat_id = $1 AND msg_id = $2',
    [chatId, msgId]
  );
  return rows.length > 0;
}

async function markProcessed(chatId, msgId) {
  await pgPool.query(
    'INSERT INTO processed_messages (chat_id, msg_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [chatId, msgId]
  );
}

// Build the expression that may continue from total if it starts with an operator
async function buildExpression(chatId, text) {
  const trimmed = text.trim();
  // If it starts with + - * /, prepend current total
  if (/^[+\-*/]/.test(trimmed)) {
    const current = await getTotal(chatId);
    return `${current}${trimmed}`;
  }
  return trimmed;
}

// Send a simple text reply
async function sendText(sock, jid, text, quoted) {
  await sock.sendMessage(jid, { text }, { quoted });
}

// ====================== Main ======================
async function start() {
  if (!DATABASE_URL) {
    console.log('❌ DATABASE_URL is not set. Set it in Render/host env.');
    process.exit(1);
  }

  await ensureTables();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we'll render manually to make it BIG
    browser: ['Ubuntu', 'Chrome', '22.04'],
    syncFullHistory: false
  });

  // Big scannable QR in logs
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[${SESSION_LABEL}] Scan this QR from logs:`);
      qrcode.generate(qr, { small: false }); // big, scannable QR
    }

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log(`[${SESSION_LABEL}] connection closed. reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) start().catch(console.error);
    } else if (connection === 'open') {
      console.log(`[${SESSION_LABEL}] ✅ Connected to WhatsApp`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Message handler
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages && m.messages[0];
      if (!msg || !msg.key || msg.key.fromMe) return;

      const chatId = msg.key.remoteJid;
      const msgId = msg.key.id;
      const isGroup = chatId.endsWith('@g.us');

      // Dedup
      if (await alreadyProcessed(chatId, msgId)) return;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
        '';

      if (!text) {
        await markProcessed(chatId, msgId);
        return;
      }

      const lower = text.trim().toLowerCase();

      // Commands
      if (lower === 'total') {
        const total = await getTotal(chatId);
        await sendText(sock, chatId, `Total: ${fmt2(total)}`, msg);
        await markProcessed(chatId, msgId);
        return;
      }

      if (lower === 'reset') {
        await setTotal(chatId, 0);
        await sendText(sock, chatId, `Total reset to 0.00`, msg);
        await markProcessed(chatId, msgId);
        return;
      }

      // set <number>
      if (lower.startsWith('set ')) {
        const num = Number(lower.slice(4).trim());
        if (isFinite(num)) {
          await setTotal(chatId, num);
          await sendText(sock, chatId, `Total set to ${fmt2(num)}`, msg);
        } else {
          await sendText(sock, chatId, `Could not understand that number.`, msg);
        }
        await markProcessed(chatId, msgId);
        return;
      }

      // Only process single-line arithmetic with + - * /
      if (!isSingleLineArithmetic(text)) {
        await markProcessed(chatId, msgId);
        return;
      }

      // Build expression (prepend running total if it starts with operator)
      const expr = await buildExpression(chatId, text);

      // Evaluate & update total
      let value;
      try {
        value = safeEval(expr);
      } catch {
        await sendText(sock, chatId, `Sorry, I couldn't evaluate that.`, msg);
        await markProcessed(chatId, msgId);
        return;
      }

      const newTotal = await addToTotal(chatId, value);

      const reply = [
        `${expr} = ${fmt2(value)}`,
        `Running total: ${fmt2(newTotal)}`
      ].join('\n');

      await sendText(sock, chatId, reply, msg);
      await markProcessed(chatId, msgId);
    } catch (err) {
      console.error('Message handler error:', err);
    }
  });
}

start().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
