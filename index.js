require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;
const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES || '5', 10);
const TIMEZONE = process.env.TIMEZONE || 'Asia/Jakarta';
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');
const FEEDS_FILE = path.join(__dirname, 'feeds.json');

// Feed awal dari .env (fallback)
const INITIAL_FEEDS = (process.env.RSS_FEEDS || '')
   .split(',')
   .map((s) => s.trim())
   .filter(Boolean);

if (!BOT_TOKEN) {
   console.error('❌  TELEGRAM_BOT_TOKEN wajib diisi di file .env');
   process.exit(1);
}
if (INITIAL_FEEDS.length === 0) {
   console.error('❌  RSS_FEEDS wajib diisi di file .env');
   process.exit(1);
}

// ── SUBSCRIBERS ───────────────────────────────────────────────────────────────

/** Load subscriber dari file (biar persist setelah restart) */
function loadSubscribers() {
   try {
      if (fs.existsSync(SUBSCRIBERS_FILE)) {
         return new Set(JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8')));
      }
   } catch {}
   return new Set();
}

/** Simpan subscriber ke file */
function saveSubscribers(subscribers) {
   fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...subscribers]), 'utf8');
}

const subscribers = loadSubscribers();

// ── FEEDS ─────────────────────────────────────────────────────────────────────

/** Load daftar feed dari feeds.json, fallback ke .env */
function loadFeeds() {
   try {
      if (fs.existsSync(FEEDS_FILE)) {
         return JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
      }
   } catch {}
   // Pertama kali: simpan feed dari .env ke file
   saveFeeds(INITIAL_FEEDS);
   return [...INITIAL_FEEDS];
}

/** Simpan daftar feed ke feeds.json */
function saveFeeds(feedList) {
   fs.writeFileSync(FEEDS_FILE, JSON.stringify(feedList, null, 2), 'utf8');
}

/** Daftar feed aktif (mutable) */
let activeFeeds = loadFeeds();

/** Cek apakah pengirim adalah admin */
function isAdmin(chatId) {
   if (!ADMIN_CHAT_ID) return true; // Kalau belum set, semua boleh (untuk setup awal)
   return chatId === ADMIN_CHAT_ID;
}

// ── INIT ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const parser = new Parser({
   timeout: 10_000,
   headers: { 'User-Agent': 'news-notify-bot/1.0' },
});

/** Set berisi guid/link artikel yang sudah dikirim (per sesi) */
const seen = new Set();

// ── BOT COMMANDS ──────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
   const chatId = msg.chat.id;
   const name = msg.from.first_name || 'teman';

   if (subscribers.has(chatId)) {
      await bot.sendMessage(chatId, `👋 Halo *${escapeMarkdown(name)}*\\! Kamu sudah terdaftar sebelumnya\\.\n\nKamu akan terus menerima notifikasi berita baru setiap *${INTERVAL_MINUTES} menit*\\.`, { parse_mode: 'MarkdownV2' });
      return;
   }

   subscribers.add(chatId);
   saveSubscribers(subscribers);
   console.log(`✅ Subscriber baru: ${chatId} (${name}) — total: ${subscribers.size}`);

   await bot.sendMessage(
      chatId,
      `👋 Halo *${escapeMarkdown(name)}*\\! Selamat datang\\!\n\n` +
         `Kamu berhasil subscribe notifikasi berita\\.\n` +
         `Memantau *${activeFeeds.length}* sumber berita setiap *${INTERVAL_MINUTES} menit*\\.\n\n` +
         `Ketik /stop untuk berhenti berlangganan\\.`,
      { parse_mode: 'MarkdownV2' },
   );
});

bot.onText(/\/stop/, async (msg) => {
   const chatId = msg.chat.id;
   const name = msg.from.first_name || 'teman';

   if (!subscribers.has(chatId)) {
      await bot.sendMessage(chatId, 'Kamu belum terdaftar. Ketik /start untuk mulai berlangganan.');
      return;
   }

   subscribers.delete(chatId);
   saveSubscribers(subscribers);
   console.log(`❌ Unsubscribe: ${chatId} (${name}) — sisa: ${subscribers.size}`);

   await bot.sendMessage(chatId, `😢 Kamu sudah berhenti berlangganan\\.\nKetik /start kapan saja untuk berlangganan lagi\\.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/status/, async (msg) => {
   const chatId = msg.chat.id;
   await bot.sendMessage(
      chatId,
      `📊 *Status Bot*\n\n` + `👥 Subscriber: *${subscribers.size}* orang\n` + `📡 Feed dipantau: *${activeFeeds.length}* sumber\n` + `⏱ Interval: setiap *${INTERVAL_MINUTES} menit*\n` + `📰 Total artikel dicatat: *${seen.size}*`,
      { parse_mode: 'MarkdownV2' },
   );
});

// ── FEED MANAGEMENT COMMANDS ──────────────────────────────────────────────────

bot.onText(/\/listfeeds/, async (msg) => {
   const chatId = msg.chat.id;
   if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.');
      return;
   }
   if (activeFeeds.length === 0) {
      await bot.sendMessage(chatId, '📭 Belum ada feed yang terdaftar.');
      return;
   }
   const list = activeFeeds.map((url, i) => `${i + 1}. ${url}`).join('\n');
   await bot.sendMessage(chatId, `📡 Daftar Feed Aktif (${activeFeeds.length}):\n\n${list}`);
});

bot.onText(/\/addfeed (.+)/, async (msg, match) => {
   const chatId = msg.chat.id;
   if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.');
      return;
   }
   const url = match[1].trim();
   if (!url.startsWith('http')) {
      await bot.sendMessage(chatId, '❌ URL tidak valid. Pastikan dimulai dengan http:// atau https://');
      return;
   }
   if (activeFeeds.includes(url)) {
      await bot.sendMessage(chatId, '⚠️ Feed ini sudah ada dalam daftar.');
      return;
   }
   activeFeeds.push(url);
   saveFeeds(activeFeeds);
   console.log(`➕ Feed ditambahkan: ${url}`);
   await bot.sendMessage(chatId, `✅ Feed berhasil ditambahkan!\n\n🔗 ${url}\n\nTotal feed sekarang: ${activeFeeds.length}`);
});

bot.onText(/\/removefeed (.+)/, async (msg, match) => {
   const chatId = msg.chat.id;
   if (!isAdmin(chatId)) {
      await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.');
      return;
   }
   const url = match[1].trim();
   const index = activeFeeds.indexOf(url);
   if (index === -1) {
      await bot.sendMessage(chatId, `❌ Feed tidak ditemukan.\n\nKetik /listfeeds untuk melihat feed aktif.`);
      return;
   }
   activeFeeds.splice(index, 1);
   saveFeeds(activeFeeds);
   console.log(`➖ Feed dihapus: ${url}`);
   await bot.sendMessage(chatId, `🗑 Feed berhasil dihapus!\n\nSisa feed: ${activeFeeds.length}`);
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function escapeMarkdown(text = '') {
   return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/** Kirim notifikasi artikel ke semua subscriber */
async function broadcast(feedTitle, item) {
   if (subscribers.size === 0) return;

   const title = item.title || 'Tanpa Judul';
   const link = item.link || item.guid || '';
   const pubDate = item.pubDate ? new Date(item.pubDate).toLocaleString('id-ID', { timeZone: TIMEZONE }) : 'Tidak diketahui';
   const summary = item.contentSnippet || item.summary || '';

   // Bersihkan summary dari tag HTML
   const cleanSummary = summary.replace(/<[^>]*>/g, '').trim();

   const message =
      `📰 *${escapeMarkdown(feedTitle)}*\n\n` +
      `*${escapeMarkdown(title)}*\n\n` +
      (cleanSummary ? `${escapeMarkdown(cleanSummary.slice(0, 300))}${cleanSummary.length > 300 ? '\\.\\.\\.' : ''}\n\n` : '') +
      `🕐 ${escapeMarkdown(pubDate)}\n` +
      (link ? `🔗 [Baca selengkapnya](${link})` : '');

   for (const chatId of subscribers) {
      try {
         await bot.sendMessage(chatId, message, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: false,
         });
         await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
         // Kalau user blokir bot, hapus dari subscriber
         if (err.response?.body?.error_code === 403 || err.message?.includes('bot was blocked')) {
            subscribers.delete(chatId);
            saveSubscribers(subscribers);
            console.log(`🚫 Auto-remove subscriber ${chatId} (bot diblokir)`);
         } else {
            console.error(`⚠️  Gagal kirim ke ${chatId}:`, err.message);
         }
      }
   }
}

/** Fetch satu RSS feed, kirim artikel baru */
async function checkFeed(feedUrl) {
   let feed;
   try {
      feed = await parser.parseURL(feedUrl);
   } catch (err) {
      console.error(`⚠️  Gagal fetch ${feedUrl}:`, err.message);
      return;
   }

   const feedTitle = feed.title || feedUrl;
   let newCount = 0;

   for (const item of feed.items || []) {
      const id = item.guid || item.link || item.title;
      if (!id || seen.has(id)) continue;

      seen.add(id);
      await broadcast(feedTitle, item);
      newCount++;
   }

   if (newCount > 0) {
      console.log(`[${new Date().toLocaleString('id-ID')}] ✅ ${newCount} artikel baru dari "${feedTitle}"`);
   }
}

/** Seed artikel lama saat startup (tandai sudah ada, TANPA kirim) */
async function seedSeen() {
   console.log('🔄 Memuat artikel lama (skip notif awal)…');
   for (const url of activeFeeds) {
      try {
         const feed = await parser.parseURL(url);
         for (const item of feed.items || []) {
            const id = item.guid || item.link || item.title;
            if (id) seen.add(id);
         }
         console.log(`   ✓ Loaded "${feed.title || url}"`);
      } catch (err) {
         console.error(`   ✗ Gagal seed ${url}:`, err.message);
      }
   }
   console.log(`✅ ${seen.size} artikel lama dicatat, bot siap memantau.\n`);
}

async function checkAllFeeds() {
   for (const url of activeFeeds) {
      await checkFeed(url);
   }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
   console.log('🚀 News Notify Bot dimulai');
   console.log(`   Feed    : ${activeFeeds.length} sumber`);
   console.log(`   Interval: setiap ${INTERVAL_MINUTES} menit`);
   console.log(`   Subscriber saat ini: ${subscribers.size} orang`);
   console.log(`   Admin   : ${ADMIN_CHAT_ID ? ADMIN_CHAT_ID : 'belum diset (semua bisa manage feed)'}\n`);

   await seedSeen();

   // Polling berkala
   setInterval(
      async () => {
         console.log(`[${new Date().toLocaleString('id-ID')}] 🔍 Memeriksa feed baru…`);
         await checkAllFeeds();
      },
      INTERVAL_MINUTES * 60 * 1000,
   );
})();
