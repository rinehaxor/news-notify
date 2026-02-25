require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;
const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES || '5', 10);
const TIMEZONE = process.env.TIMEZONE || 'Asia/Jakarta';
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');
const FEEDS_FILE = path.join(__dirname, 'feeds.json');
const SCRAPE_DIR = path.join(__dirname, 'scrape');

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

function loadSubscribers() {
   try {
      if (fs.existsSync(SUBSCRIBERS_FILE)) {
         return new Set(JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8')));
      }
   } catch {}
   return new Set();
}

function saveSubscribers(subscribers) {
   try {
      fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...subscribers]), 'utf8');
   } catch (err) {
      console.error('❌ Gagal simpan subscribers.json:', err.message);
   }
}

const subscribers = loadSubscribers();

// ── FEEDS (RSS) ───────────────────────────────────────────────────────────────

function loadFeeds() {
   try {
      if (fs.existsSync(FEEDS_FILE)) {
         return JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
      }
   } catch {}
   saveFeeds(INITIAL_FEEDS);
   return [...INITIAL_FEEDS];
}

function saveFeeds(feedList) {
   fs.writeFileSync(FEEDS_FILE, JSON.stringify(feedList, null, 2), 'utf8');
}

let activeFeeds = loadFeeds();

// ── SCRAPE CONFIGS ────────────────────────────────────────────────────────────

/**
 * Load semua scrape config dari folder scrape/
 * Tiap file JSON = satu website.
 * Format: { name, baseUrl, articleLinkSelector, titleSelector?, pages: [{url, label}] }
 */
function loadScrapeConfigs() {
   const configs = [];
   if (!fs.existsSync(SCRAPE_DIR)) return configs;
   const files = fs.readdirSync(SCRAPE_DIR).filter((f) => f.endsWith('.json'));
   for (const file of files) {
      try {
         const config = JSON.parse(fs.readFileSync(path.join(SCRAPE_DIR, file), 'utf8'));
         config._file = file; // simpan nama file untuk logging
         configs.push(config);
      } catch (err) {
         console.error(`⚠️  Gagal load scrape config ${file}:`, err.message);
      }
   }
   return configs;
}

const scrapeConfigs = loadScrapeConfigs();

// ── INIT ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const parser = new Parser({
   timeout: 10_000,
   headers: { 'User-Agent': 'news-notify-bot/1.0' },
});

function isAdmin(chatId) {
   if (!ADMIN_CHAT_ID) return true;
   return chatId === ADMIN_CHAT_ID;
}

/** Set berisi guid/link artikel yang sudah dikirim (per sesi) */
const seen = new Set();

// ── BOT COMMANDS ──────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
   const chatId = msg.chat.id;
   const name = msg.from.first_name || 'teman';

   if (subscribers.has(chatId)) {
      await bot.sendMessage(chatId, `👋 Halo *${escapeMarkdown(name)}*\\! Kamu sudah terdaftar sebelumnya\\.\\n\\nKamu akan terus menerima notifikasi berita baru setiap *${INTERVAL_MINUTES} menit*\\.`, { parse_mode: 'MarkdownV2' });
      return;
   }

   subscribers.add(chatId);
   saveSubscribers(subscribers);
   console.log(`✅ Subscriber baru: ${chatId} (${name}) — total: ${subscribers.size}`);

   const totalSources = activeFeeds.length + scrapeConfigs.reduce((sum, c) => sum + c.pages.length, 0);
   await bot.sendMessage(
      chatId,
      `👋 Halo *${escapeMarkdown(name)}*\\! Selamat datang\\!\\n\\n` +
         `Kamu berhasil subscribe notifikasi berita\\.\\n` +
         `Memantau *${totalSources}* sumber berita setiap *${INTERVAL_MINUTES} menit*\\.\\n\\n` +
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

   await bot.sendMessage(chatId, `😢 Kamu sudah berhenti berlangganan\\.\\nKetik /start kapan saja untuk berlangganan lagi\\.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/status/, async (msg) => {
   const chatId = msg.chat.id;
   const totalScrapePages = scrapeConfigs.reduce((sum, c) => sum + c.pages.length, 0);
   await bot.sendMessage(
      chatId,
      `📊 *Status Bot*\\n\\n` +
         `👥 Subscriber: *${subscribers.size}* orang\\n` +
         `📡 RSS Feed: *${activeFeeds.length}* sumber\\n` +
         `🔍 Scrape: *${scrapeConfigs.length}* website \\(*${totalScrapePages}* halaman\\)\\n` +
         `⏱ Interval: setiap *${INTERVAL_MINUTES} menit*\\n` +
         `📰 Total artikel dicatat: *${seen.size}*`,
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

   const lines = [];

   if (activeFeeds.length > 0) {
      lines.push(`📡 *RSS Feed (${activeFeeds.length}):*`);
      activeFeeds.forEach((url, i) => lines.push(`  ${i + 1}\\. ${escapeMarkdown(url)}`));
   }

   if (scrapeConfigs.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`🔍 *Scrape \\(${scrapeConfigs.length} website\\):*`);
      scrapeConfigs.forEach((cfg, i) => {
         lines.push(`  ${i + 1}\\. *${escapeMarkdown(cfg.name)}* \\(${escapeMarkdown(cfg._file)}\\)`);
         cfg.pages.forEach((p) => lines.push(`     \\- ${escapeMarkdown(p.label)}: ${escapeMarkdown(p.url)}`));
      });
   }

   if (lines.length === 0) {
      await bot.sendMessage(chatId, '📭 Belum ada feed atau scrape config yang terdaftar.');
      return;
   }

   await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
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
   await bot.sendMessage(chatId, `✅ RSS Feed berhasil ditambahkan!\\n\\n🔗 ${escapeMarkdown(url)}\\n\\nTotal RSS feed sekarang: ${activeFeeds.length}`, { parse_mode: 'MarkdownV2' });
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
      await bot.sendMessage(chatId, `❌ Feed tidak ditemukan.\\n\\nKetik /listfeeds untuk melihat feed aktif.`);
      return;
   }
   activeFeeds.splice(index, 1);
   saveFeeds(activeFeeds);
   console.log(`➖ Feed dihapus: ${url}`);
   await bot.sendMessage(chatId, `🗑 RSS Feed berhasil dihapus!\\n\\nSisa RSS feed: ${activeFeeds.length}`);
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function escapeMarkdown(text = '') {
   return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

/** Kirim notifikasi artikel ke semua subscriber */
async function broadcast(feedTitle, item) {
   if (subscribers.size === 0) return;

   const title = item.title || 'Tanpa Judul';
   const link = item.link || item.guid || '';
   const pubDate = item.pubDate ? new Date(item.pubDate).toLocaleString('id-ID', { timeZone: TIMEZONE }) : 'Baru saja';
   const summary = item.contentSnippet || item.summary || '';
   const cleanSummary = summary.replace(/<[^>]*>/g, '').trim();

   const message =
      `📰 *${escapeMarkdown(feedTitle)}*\n\n` +
      `*${escapeMarkdown(title)}*\n\n` +
      (cleanSummary ? `${escapeMarkdown(cleanSummary.slice(0, 300))}${cleanSummary.length > 300 ? '\\.\\.\\.' : ''}\n\n` : '') +
      `🕐 ${escapeMarkdown(pubDate)}\n` +
      (link ? `🔗 [Baca selengkapnya](${link})` : '');

   const plainMessage = `📰 ${feedTitle}\n\n` + `${title}\n\n` + (cleanSummary ? `${cleanSummary.slice(0, 300)}${cleanSummary.length > 300 ? '...' : ''}\n\n` : '') + `🕐 ${pubDate}\n` + (link ? `🔗 ${link}` : '');

   for (const chatId of subscribers) {
      try {
         await bot.sendMessage(chatId, message, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: false,
         });
         await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
         if (err.response?.body?.error_code === 403 || err.message?.includes('bot was blocked')) {
            subscribers.delete(chatId);
            saveSubscribers(subscribers);
            console.log(`🚫 Auto-remove subscriber ${chatId} (bot diblokir)`);
         } else {
            console.error(`⚠️  Gagal kirim ke ${chatId} (MarkdownV2):`, err.message);
            try {
               await bot.sendMessage(chatId, plainMessage, { disable_web_page_preview: false });
               console.log(`   ✓ Fallback plain text berhasil ke ${chatId}`);
            } catch (err2) {
               console.error(`⚠️  Gagal kirim plain text ke ${chatId}:`, err2.message);
            }
         }
      }
   }
}

// ── RSS FEED ──────────────────────────────────────────────────────────────────

async function checkFeed(feedUrl) {
   let feed;
   try {
      feed = await parser.parseURL(feedUrl);
   } catch (err) {
      console.error(`⚠️  Gagal fetch RSS ${feedUrl}:`, err.message);
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
      console.log(`[${new Date().toLocaleString('id-ID')}] ✅ ${newCount} artikel baru dari RSS "${feedTitle}"`);
   }
}

// ── WEB SCRAPING ──────────────────────────────────────────────────────────────

/**
 * Scrape satu halaman kategori dari sebuah config website.
 * @param {object} config  - Isi dari scrape/xxx.json
 * @param {object} page    - Entry dari config.pages[] { url, label }
 */
async function checkScrapePage(config, page) {
   let html;
   try {
      const res = await axios.get(page.url, {
         timeout: 15_000,
         headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'max-age=0',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Upgrade-Insecure-Requests': '1',
         },
      });
      html = res.data;
   } catch (err) {
      console.error(`⚠️  Gagal fetch scrape ${page.url}:`, err.message);
      return;
   }

   const $ = cheerio.load(html);
   const feedTitle = `${config.name} – ${page.label}`;
   const links = new Set();

   // Buat regex dari urlPattern jika ada (untuk filter link beneran vs navigasi)
   const urlRegex = config.urlPattern ? new RegExp(config.urlPattern) : null;

   $(config.articleLinkSelector).each((_, el) => {
      let href = $(el).attr('href') || '';
      // Jadikan URL absolut jika relatif
      if (href.startsWith('/')) href = config.baseUrl + href;
      if (!href.startsWith('http')) return;
      // Filter pakai urlPattern kalau ada
      if (urlRegex && !urlRegex.test(href)) return;
      links.add(href);
   });

   let newCount = 0;
   for (const link of links) {
      if (seen.has(link)) continue;
      seen.add(link);

      // Coba ambil judul dari selector khusus, fallback ke text elemen <a>
      let title = '';
      if (config.titleSelector) {
         // cari dalam konteks parent element link
         const el = $(`a[href="${link.replace(config.baseUrl, '')}"]`);
         title = el.find(config.titleSelector).text().trim() || el.text().trim();
      } else {
         // Ambil text dari semua <a> yang href-nya cocok
         $(`a[href="${link}"], a[href="${link.replace(config.baseUrl, '')}"]`).each((_, el) => {
            const t = $(el).text().trim();
            if (t.length > title.length) title = t;
         });
      }

      if (!title) {
         // Fallback: ambil slug dari URL sebagai judul
         const slug = link.split('/').pop();
         title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }

      await broadcast(feedTitle, { title, link, pubDate: null, contentSnippet: '' });
      newCount++;
   }

   if (newCount > 0) {
      console.log(`[${new Date().toLocaleString('id-ID')}] ✅ ${newCount} artikel baru dari scrape "${feedTitle}"`);
   }
}

/** Jalankan semua scrape config */
async function checkAllScrapeConfigs() {
   for (const config of scrapeConfigs) {
      for (const page of config.pages) {
         await checkScrapePage(config, page);
      }
   }
}

// ── SEED (startup) ────────────────────────────────────────────────────────────

async function seedSeen() {
   console.log('🔄 Memuat artikel lama (skip notif awal)…');

   // Seed dari RSS
   for (const url of activeFeeds) {
      try {
         const feed = await parser.parseURL(url);
         for (const item of feed.items || []) {
            const id = item.guid || item.link || item.title;
            if (id) seen.add(id);
         }
         console.log(`   ✓ RSS "${feed.title || url}"`);
      } catch (err) {
         console.error(`   ✗ Gagal seed RSS ${url}:`, err.message);
      }
   }

   // Seed dari scrape configs
   for (const config of scrapeConfigs) {
      for (const page of config.pages) {
         try {
            const res = await axios.get(page.url, {
               timeout: 15_000,
               headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
                  'Cache-Control': 'max-age=0',
               },
            });
            const $ = cheerio.load(res.data);
            const urlRegex = config.urlPattern ? new RegExp(config.urlPattern) : null;
            $(config.articleLinkSelector).each((_, el) => {
               let href = $(el).attr('href') || '';
               if (href.startsWith('/')) href = config.baseUrl + href;
               if (!href.startsWith('http')) return;
               if (urlRegex && !urlRegex.test(href)) return;
               seen.add(href);
            });
            console.log(`   ✓ Scrape "${config.name} – ${page.label}"`);
         } catch (err) {
            console.error(`   ✗ Gagal seed scrape ${page.url}:`, err.message);
         }
      }
   }

   console.log(`✅ ${seen.size} artikel lama dicatat, bot siap memantau.\n`);
}

async function checkAllFeeds() {
   for (const url of activeFeeds) {
      await checkFeed(url);
   }
   await checkAllScrapeConfigs();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
   const totalScrapePages = scrapeConfigs.reduce((sum, c) => sum + c.pages.length, 0);
   console.log('🚀 News Notify Bot dimulai');
   console.log(`   RSS Feed   : ${activeFeeds.length} sumber`);
   console.log(`   Scrape     : ${scrapeConfigs.length} website (${totalScrapePages} halaman)`);
   console.log(`   Interval   : setiap ${INTERVAL_MINUTES} menit`);
   console.log(`   Subscriber : ${subscribers.size} orang`);
   console.log(`   Admin      : ${ADMIN_CHAT_ID ? ADMIN_CHAT_ID : 'belum diset (semua bisa manage feed)'}\n`);

   await seedSeen();

   setInterval(
      async () => {
         console.log(`[${new Date().toLocaleString('id-ID')}] 🔍 Memeriksa feed & scrape baru…`);
         await checkAllFeeds();
      },
      INTERVAL_MINUTES * 60 * 1000,
   );
})();
