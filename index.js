const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const fs = require("fs");
const qrcode = require("qrcode");
const qrt = require("qrcode-terminal");
const math = require("mathjs");
const { formatNepali, roundNormal, DECIMALS } = require("./nepali-format");
const db = require("./db");

async function ensureTables() {
  await db.query(`CREATE TABLE IF NOT EXISTS group_totals (
    chat_id TEXT PRIMARY KEY,
    total NUMERIC DEFAULT 0
  );`);

  await db.query(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data JSONB
  );`);
}
const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  // Save QR as PNG file too
  sock.ev.on("connection.update", (update) => {
    const { qr } = update;
    if (qr) {
    qrcode.generate(qr, { small: false }); // large, scannable QR
 // ASCII QR in logs
      require("qrcode").toFile("qr.png", qr, (err) => {
        if (err) console.error("❌ QR Save Error:", err);
        else console.log("✅ QR saved as qr.png, download & scan it.");
      });
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

startBot();

const processed = new Set();
function seenOnce(id) {
  if (!id) return true;
  if (processed.has(id)) return false;
  processed.add(id);
  setTimeout(() => processed.delete(id), 60000);
  return true;
}

const startsWithOp = (t) => /^[\s]*[+\-*/]/.test(t);
const hasAnyOperator = (t) => /[+\-*/]/.test(t);
const onlyDigits = (t) => /^\d+(\.\d+)?$/.test(t.replace(/\s+/g, ""));

function getLabelledResult(result) {
  const val = roundNormal(parseFloat(result));
  const formatted = formatNepali(val);
  if (val < 0) return `*ADV: ${formatted}* 💸💸💸💸`;
  return `*DUES: ${formatted}* ⚠️⚠️⚠️`;
}

async function getTotal(chatId) {
  const res = await db.query("SELECT total FROM group_totals WHERE chat_id=$1", [chatId]);
  if (res.rows.length === 0) return null;
  return parseFloat(res.rows[0].total);
}

async function setTotal(chatId, val) {
  await db.query(`INSERT INTO group_totals (chat_id, total)
    VALUES ($1,$2)
    ON CONFLICT (chat_id) DO UPDATE SET total=$2`, [chatId, val]);
}

async function resetTotal(chatId) {
  await db.query("DELETE FROM group_totals WHERE chat_id=$1", [chatId]);
}

const startSock = async () => {
  await ensureTables();

  const AUTH_DIR = "auth_info";
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state });

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log("Scan this QR (ASCII below) or open qr.png:");
      try { qrt.generate(qr, { small: true }); } catch {}
      try { await qrcode.toFile("qr.png", qr); } catch {}
    }
    if (connection === "open") console.log("✅ Connected to WhatsApp");
    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startSock();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message || msg.key.fromMe) return;
    if (!seenOnce(msg.key.id)) return;

    const chatId = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const t = (text || "").trim();
    if (!t) return;

    // Commands
    if (/^!total\b/i.test(t)) {
      const tot = await getTotal(chatId);
      if (tot === null) {
        await sock.sendMessage(chatId, { text: "No running total yet." }, { quoted: msg });
        return;
      }
      const reply = getLabelledResult(tot);
      await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
      return;
    }
    if (/^!reset\b/i.test(t)) {
      await resetTotal(chatId);
      await sock.sendMessage(chatId, { text: "Reset. No running total now." }, { quoted: msg });
      return;
    }

    // Guards
    if (t.includes("\n")) return;
    if (onlyDigits(t)) return;
    if (!hasAnyOperator(t)) return;

    try {
      let expr = t;
      let base = await getTotal(chatId);
      if (startsWithOp(t)) {
        if (base === null) {
          await sock.sendMessage(chatId, { text: "No previous total. Send a full expression first." }, { quoted: msg });
          return;
        }
        expr = `${base} ${t}`;
      }
      const raw = math.evaluate(expr);
      const result = roundNormal(raw);
      await setTotal(chatId, result);
      const reply = getLabelledResult(result);
      await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
    } catch (err) {
      console.error("Invalid calculation:", t, err?.message);
    }
  });

  sock.ev.on("creds.update", saveCreds);
};

console.log("Starting WhatsApp Calculator Bot v7 Final with Postgres persistence...");
startSock();
