const TelegramBot = require('node-telegram-bot-api');
const { BOT_TOKEN, ADMIN_CHAT_ID, INTERVAL_MINUTES, TIMEZONE, KIMI_API_KEY, KIMI_MODEL } = require('./config');
const { saveSubscribers, saveFeeds, saveSettings, saveSeen } = require('./storage');
const { fetchArticleContent, loadScrapeConfigs } = require('./scraper');
const { rewriteWithKimi } = require('./ai');
const { autoGenerateScrapeConfig } = require('./autoscrape');

function isAdmin(chatId) {
   if (!ADMIN_CHAT_ID) {
      console.warn('⚠️  ADMIN_CHAT_ID belum diset di .env. Perintah admin ditolak demi keamanan.');
      return false;
   }
   return chatId === ADMIN_CHAT_ID;
}

function escapeMarkdown(text = '') {
   return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

function escapeHtml(text = '') {
   return String(text).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}

function initBot(context) {
   const { subscribers, activeFeeds, settings, seen, checkAllFeedsFn } = context;

   if (!BOT_TOKEN) {
      console.error('❌  TELEGRAM_BOT_TOKEN wajib diisi di file .env');
      process.exit(1);
   }

   const bot = new TelegramBot(BOT_TOKEN, { polling: true });

   // ── BROADCAST ───────────────────────────────────────────────────────────────
   async function broadcast(feedTitle, item) {
      if (subscribers.size === 0) return;

      const title = item.title || 'Tanpa Judul';
      const link = item.link || item.guid || '';
      const pubDate = item.pubDate ? new Date(item.pubDate).toLocaleString('id-ID', { timeZone: TIMEZONE }) : 'Baru saja';

      let rewrittenText = '';
      let isRewritten = false;

      if (settings.rewriteEnabled && link) {
         console.log(`   🔍 Fetching konten artikel: ${link}`);
         const rawContent = await fetchArticleContent(link);
         if (rawContent) {
            console.log(`   🧠 Rewriting dengan Kimi AI...`);
            const rewritten = await rewriteWithKimi(title, rawContent);
            if (rewritten) {
               rewrittenText = rewritten;
               isRewritten = true;
            }
         }
      }

      let message, plainMessage;

      if (isRewritten) {
         const preview = rewrittenText.slice(0, 3000);
         message =
            `📰 <b>${escapeHtml(feedTitle)}</b>\n\n` + `<b>${escapeHtml(title)}</b> <i>✨ ditulis ulang AI</i>\n\n` + `${escapeHtml(preview)}\n\n` + `🕐 ${escapeHtml(pubDate)}\n` + (link ? `🔗 <a href="${link}">Baca selengkapnya</a>` : '');

         plainMessage = `📰 ${feedTitle}\n\n` + `${title} ✨ (ditulis ulang AI)\n\n` + `${preview}\n\n` + `🕐 ${pubDate}\n` + (link ? `🔗 ${link}` : '');
      } else {
         message = `📰 <b>${escapeHtml(feedTitle)}</b>\n\n` + `<b>${escapeHtml(title)}</b>\n\n` + `🕐 ${escapeHtml(pubDate)}\n` + (link ? `🔗 <a href="${link}">Baca selengkapnya</a>` : '');

         plainMessage = `📰 ${feedTitle}\n\n` + `${title}\n\n` + `🕐 ${pubDate}\n` + (link ? `🔗 ${link}` : '');
      }

      for (const chatId of subscribers) {
         try {
            await bot.sendMessage(chatId, message, {
               parse_mode: 'HTML',
               disable_web_page_preview: false,
            });
            await new Promise((r) => setTimeout(r, 300));
         } catch (err) {
            if (err.response?.body?.error_code === 403 || err.message?.includes('bot was blocked')) {
               subscribers.delete(chatId);
               saveSubscribers(subscribers);
               console.log(`🚫 Auto-remove subscriber ${chatId} (bot diblokir)`);
            } else {
               console.error(`⚠️  Gagal kirim ke ${chatId} (HTML):`, err.message);
               try {
                  await bot.sendMessage(chatId, plainMessage, { disable_web_page_preview: false });
                  console.log(`   ✓ Fallback plain text berhasil ke ${chatId}`);
               } catch (err2) {
                  console.error(`⚠️  Gagal kirim plain text ke ${chatId}:`, err2.message);
               }
            }
         }
      }

      // Persist seen ke file setelah broadcast
      saveSeen(seen);
   }

   // ── COMMAND HANDLERS ────────────────────────────────────────────────────────

   bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const name = msg.from.first_name || 'teman';

      if (subscribers.has(chatId)) {
         await bot.sendMessage(chatId, `👋 Halo <b>${escapeHtml(name)}</b>! Kamu sudah terdaftar sebelumnya.\n\nKamu akan terus menerima notifikasi berita baru setiap <b>${INTERVAL_MINUTES} menit</b>.`, { parse_mode: 'HTML' });
         return;
      }

      subscribers.add(chatId);
      saveSubscribers(subscribers);
      console.log(`✅ Subscriber baru: ${chatId} (${name}) — total: ${subscribers.size}`);

      const scrapeConfigs = loadScrapeConfigs();
      const totalSources = activeFeeds.length + scrapeConfigs.reduce((sum, c) => sum + c.pages.length, 0);
      await bot.sendMessage(
         chatId,
         `👋 Halo <b>${escapeHtml(name)}</b>! Selamat datang!\n\n` +
            `Kamu berhasil subscribe notifikasi berita.\n` +
            `Memantau <b>${totalSources}</b> sumber berita setiap <b>${INTERVAL_MINUTES} menit</b>.\n\n` +
            `Ketik /stop untuk berhenti berlangganan.`,
         { parse_mode: 'HTML' },
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

      await bot.sendMessage(chatId, `😢 Kamu sudah berhenti berlangganan.\nKetik /start kapan saja untuk berlangganan lagi.`);
   });

   bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      const scrapeConfigs = loadScrapeConfigs();
      const totalScrapePages = scrapeConfigs.reduce((sum, c) => sum + c.pages.length, 0);
      await bot.sendMessage(
         chatId,
         `📊 <b>Status Bot</b>\n\n` +
            `👥 Subscriber: <b>${subscribers.size}</b> orang\n` +
            `📡 RSS Feed: <b>${activeFeeds.length}</b> sumber\n` +
            `🔍 Scrape: <b>${scrapeConfigs.length}</b> website (<b>${totalScrapePages}</b> halaman)\n` +
            `⏱ Interval: setiap <b>${INTERVAL_MINUTES} menit</b>\n` +
            `📰 Total artikel dicatat: <b>${seen.size}</b>\n` +
            `🧠 Rewrite AI: <b>${settings.rewriteEnabled ? '✅ ON' : '❌ OFF'}</b>`,
         { parse_mode: 'HTML' },
      );
   });

   bot.onText(/\/listfeeds/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini atau ADMIN_CHAT_ID belum dikonfigurasi.');
         return;
      }

      const scrapeConfigs = loadScrapeConfigs();
      const lines = [];

      if (activeFeeds.length > 0) {
         lines.push(`📡 <b>RSS Feed (${activeFeeds.length}):</b>`);
         activeFeeds.forEach((url, i) => lines.push(`  ${i + 1}. ${escapeHtml(url)}`));
      }

      if (scrapeConfigs.length > 0) {
         if (lines.length > 0) lines.push('');
         lines.push(`🔍 <b>Scrape (${scrapeConfigs.length} website):</b>`);
         scrapeConfigs.forEach((cfg, i) => {
            lines.push(`  ${i + 1}. <b>${escapeHtml(cfg.name)}</b> (${escapeHtml(cfg._file)})`);
            cfg.pages.forEach((p) => lines.push(`     - ${escapeHtml(p.label)}: ${escapeHtml(p.url)}`));
         });
      }

      if (lines.length === 0) {
         await bot.sendMessage(chatId, '📭 Belum ada feed atau scrape config yang terdaftar.');
         return;
      }

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
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
      await bot.sendMessage(chatId, `✅ RSS Feed berhasil ditambahkan!\n\n🔗 ${escapeHtml(url)}\n\nTotal RSS feed sekarang: ${activeFeeds.length}`, { parse_mode: 'HTML' });
   });

   bot.onText(/\/autoscrape (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.');
         return;
      }
      const rawInput = match[1].trim();
      const parts = rawInput.split(' ');
      const targetUrl = parts[0];
      const customName = parts.slice(1).join(' ') || null;

      await bot.sendMessage(chatId, `🔍 Menganalisis website <b>${escapeHtml(targetUrl)}</b>...`, { parse_mode: 'HTML' });

      try {
         const result = await autoGenerateScrapeConfig(targetUrl, customName);
         await bot.sendMessage(
            chatId,
            `✅ <b>Web Scraper Berhasil Dibuat Otomatis!</b>\n\n` +
               `📌 Nama Media: <b>${escapeHtml(result.config.name)}</b>\n` +
               `📁 File Config: <code>scrape/${escapeHtml(result.fileName)}</code>\n` +
               `🌐 Target URL: ${escapeHtml(result.config.pages[0].url)}\n` +
               `📊 Link Terdeteksi: <b>${result.totalLinksFound}</b> link\n\n` +
               `Bot sekarang otomatis memantau website ini tanpa perlu restart! 🚀`,
            { parse_mode: 'HTML' },
         );
      } catch (err) {
         console.error('⚠️ Gagal auto scrape:', err.message);
         await bot.sendMessage(chatId, `❌ Gagal membuat scraper otomatis: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
      }
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
      await bot.sendMessage(chatId, `🗑 RSS Feed berhasil dihapus!\n\nSisa RSS feed: ${activeFeeds.length}`);
   });

   bot.onText(/\/rewrite(?:\s+(on|off))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.');
         return;
      }

      const action = match[1]?.toLowerCase();

      if (!action) {
         const status = settings.rewriteEnabled ? '✅ *ON*' : '❌ *OFF*';
         const apiStatus = KIMI_API_KEY ? '✅ API key terkonfigurasi' : '⚠️ API key belum diset \\(KIMI\\_API\\_KEY di \\.env\\)';
         await bot.sendMessage(
            chatId,
            `🧠 *Rewrite Artikel \\(Kimi AI\\)*\n\n` + `Status: ${status}\n` + `Model: \`${escapeMarkdown(KIMI_MODEL)}\`\n` + `API: ${apiStatus}\n\n` + `Gunakan:\n` + `\`/rewrite on\` \u2014 aktifkan\n` + `\`/rewrite off\` \u2014 matikan`,
            { parse_mode: 'MarkdownV2' },
         );
         return;
      }

      if (action === 'on') {
         if (!KIMI_API_KEY) {
            await bot.sendMessage(chatId, '⚠️ KIMI_API_KEY belum diset di file .env. Isi dulu lalu restart bot.');
            return;
         }
         settings.rewriteEnabled = true;
         saveSettings(settings);
         console.log('🧠 Rewrite Kimi AI: ON');
         await bot.sendMessage(chatId, '✅ Rewrite artikel dengan Kimi AI <b>diaktifkan</b>.', { parse_mode: 'HTML' });
      } else {
         settings.rewriteEnabled = false;
         saveSettings(settings);
         console.log('🧠 Rewrite Kimi AI: OFF');
         await bot.sendMessage(chatId, '❌ Rewrite artikel dengan Kimi AI <b>dimatikan</b>.', { parse_mode: 'HTML' });
      }
   });

   bot.onText(/\/fetchnow/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.');
         return;
      }
      await bot.sendMessage(chatId, '🔍 Mengecek semua feed & scrape sekarang...');
      console.log(`[${new Date().toLocaleString('id-ID')}] 🔍 Manual fetch oleh admin ${chatId}`);
      await checkAllFeedsFn();
      await bot.sendMessage(chatId, '✅ Pengecekan selesai. Notifikasi dikirim jika ada artikel baru.');
   });

   return { bot, broadcast };
}

module.exports = {
   initBot,
   isAdmin,
   escapeMarkdown,
   escapeHtml,
};
