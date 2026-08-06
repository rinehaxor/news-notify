const TelegramBot = require('node-telegram-bot-api');
const { BOT_TOKEN, ADMIN_CHAT_ID, INTERVAL_MINUTES, TIMEZONE, KIMI_API_KEY, KIMI_MODEL } = require('./config');
const { saveSubscribers, saveFeeds, saveSettings, saveSeen } = require('./storage');
const { fetchArticleContent, loadScrapeConfigs } = require('./scraper');
const { rewriteWithKimi } = require('./ai');
const { autoGenerateScrapeConfig } = require('./autoscrape');

function isAdmin(chatId) {
   // Jika ADMIN_CHAT_ID belum diset atau masih default placeholder (123456789), izinkan semua user
   if (!ADMIN_CHAT_ID || ADMIN_CHAT_ID === 123456789) {
      return true;
   }
   return String(chatId) === String(ADMIN_CHAT_ID);
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

   // Helper Reply Keyboards (Menu Tombol Bawah)
   function getMainMenuKeyboard(chatId) {
      const keyboard = [[{ text: '📊 Status Bot' }, { text: '🔍 List Sumber Berita' }]];

      if (isAdmin(chatId)) {
         keyboard.push([{ text: '➕ Tambah Feed' }, { text: '🧠 Toggle AI Rewrite' }]);
         keyboard.push([{ text: '⚡ Fetch Berita Sekarang' }]);
      }

      const isSubscribed = subscribers.has(chatId);
      if (isSubscribed) {
         keyboard.push([{ text: '🛑 Berhenti Langganan' }]);
      } else {
         keyboard.push([{ text: '🔔 Mulai Berlangganan' }]);
      }

      return {
         reply_markup: {
            keyboard: keyboard,
            resize_keyboard: true,
            persistent: true,
         },
      };
   }

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

   async function handleStart(msg) {
      const chatId = msg.chat.id;
      const name = msg.from.first_name || 'teman';

      if (subscribers.has(chatId)) {
         await bot.sendMessage(chatId, `👋 Halo <b>${escapeHtml(name)}</b>! Kamu sudah terdaftar sebelumnya.\n\nKamu akan terus menerima notifikasi berita baru setiap <b>${INTERVAL_MINUTES} menit</b>.`, {
            parse_mode: 'HTML',
            ...getMainMenuKeyboard(chatId),
         });
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
            `Gunakan menu tombol di bawah untuk navigasi cepat! 📱`,
         { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) },
      );
   }

   async function handleStop(msg) {
      const chatId = msg.chat.id;
      const name = msg.from.first_name || 'teman';

      if (!subscribers.has(chatId)) {
         await bot.sendMessage(chatId, 'Kamu belum terdaftar. Ketik /start untuk mulai berlangganan.', getMainMenuKeyboard(chatId));
         return;
      }

      subscribers.delete(chatId);
      saveSubscribers(subscribers);
      console.log(`❌ Unsubscribe: ${chatId} (${name}) — sisa: ${subscribers.size}`);

      await bot.sendMessage(chatId, `😢 Kamu sudah berhenti berlangganan.\nKetik /start kapan saja untuk berlangganan lagi.`, getMainMenuKeyboard(chatId));
   }

   async function handleStatus(msg) {
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
         { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) },
      );
   }

   async function handleAddFeed(msg, match) {
      const chatId = msg ? msg.chat.id : ADMIN_CHAT_ID;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.', getMainMenuKeyboard(chatId));
         return;
      }
      const url = match && match[1] ? match[1].trim() : '';
      if (!url) {
         await bot.sendMessage(
            chatId,
            '➕ <b>Panduan Menambah Sumber Berita:</b>\n\n' +
               '<b>1. Tambah RSS Feed:</b>\n' +
               'Ketik: <code>/addfeed <URL_RSS></code>\n' +
               '<i>Contoh:</i> <code>/addfeed https://sumberberita.com/feed</code>\n\n' +
               '<b>2. Tambah Web Scraper (Otomatis AI/Scraper):</b>\n' +
               'Ketik: <code>/autoscrape <URL_WEBSITE> [NAMA_MEDIA]</code>\n' +
               '<i>Contoh:</i> <code>/autoscrape https://bisnis.com BisnisCom</code>',
            { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) },
         );
         return;
      }
      if (!url.startsWith('http')) {
         await bot.sendMessage(chatId, '❌ URL tidak valid. Pastikan dimulai dengan http:// atau https://', getMainMenuKeyboard(chatId));
         return;
      }
      if (activeFeeds.includes(url)) {
         await bot.sendMessage(chatId, '⚠️ Feed ini sudah ada dalam daftar.', getMainMenuKeyboard(chatId));
         return;
      }
      activeFeeds.push(url);
      saveFeeds(activeFeeds);
      console.log(`➕ Feed ditambahkan: ${url}`);
      await bot.sendMessage(chatId, `✅ RSS Feed berhasil ditambahkan!\n\n🔗 ${escapeHtml(url)}\n\nTotal RSS feed sekarang: ${activeFeeds.length}`, { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) });
   }

   async function handleListFeeds(msg) {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini atau ADMIN_CHAT_ID belum dikonfigurasi.', getMainMenuKeyboard(chatId));
         return;
      }

      const scrapeConfigs = loadScrapeConfigs();
      const lines = [];
      const inlineButtons = [];

      if (activeFeeds.length > 0) {
         lines.push(`📡 <b>RSS Feed (${activeFeeds.length}):</b>`);
         activeFeeds.forEach((url, i) => {
            lines.push(`  ${i + 1}. ${escapeHtml(url)}`);
            inlineButtons.push([{ text: `🗑️ Hapus RSS ${i + 1}`, callback_data: `del_rss_${i}` }]);
         });
      }

      if (scrapeConfigs.length > 0) {
         if (lines.length > 0) lines.push('');
         lines.push(`🔍 <b>Scrape (${scrapeConfigs.length} website):</b>`);
         scrapeConfigs.forEach((cfg, i) => {
            lines.push(`  ${i + 1}. <b>${escapeHtml(cfg.name)}</b> (${escapeHtml(cfg._file)})`);
            cfg.pages.forEach((p) => lines.push(`     - ${escapeHtml(p.label)}: ${escapeHtml(p.url)}`));
            inlineButtons.push([{ text: `🗑️ Hapus Scraper: ${cfg.name}`, callback_data: `del_scrape_${cfg._file}` }]);
         });
      }

      inlineButtons.push([
         { text: '📡 + Tambah RSS', callback_data: 'add_rss' },
         { text: '🔍 + Auto Scrape Web', callback_data: 'add_scrape' },
      ]);

      if (lines.length === 0) {
         lines.push('📭 Belum ada feed atau scrape config yang terdaftar.');
      }

      const options = {
         parse_mode: 'HTML',
         reply_markup: {
            inline_keyboard: inlineButtons,
         },
      };

      await bot.sendMessage(chatId, lines.join('\n'), options);
   }

   async function handleFetchNow(msg) {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.', getMainMenuKeyboard(chatId));
         return;
      }
      await bot.sendMessage(chatId, '🔍 Mengecek semua feed & scrape sekarang...');
      console.log(`[${new Date().toLocaleString('id-ID')}] 🔍 Manual fetch oleh admin ${chatId}`);
      await checkAllFeedsFn();
      await bot.sendMessage(chatId, '✅ Pengecekan selesai. Notifikasi dikirim jika ada artikel baru.', getMainMenuKeyboard(chatId));
   }

   bot.onText(/\/start/, handleStart);
   bot.onText(/\/stop/, handleStop);
   bot.onText(/\/status/, handleStatus);
   bot.onText(/\/listfeeds/, handleListFeeds);
   bot.onText(/\/addfeed(?:\s+(.+))?/, handleAddFeed);

   // Handler Callback Query untuk Tombol Inline (Hapus Feed / Scraper File / Tambah Feed)
   bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const data = query.data;

      if (!isAdmin(chatId)) {
         await bot.answerCallbackQuery(query.id, { text: '⛔ Akses ditolak.', show_alert: true });
         return;
      }

      if (data === 'add_rss') {
         await bot.answerCallbackQuery(query.id);
         await bot.sendMessage(chatId, '📡 <b>Kirimkan URL RSS Feed</b> yang mau ditambahkan:\n\n<i>Contoh:</i> <code>https://sumberberita.com/feed</code>', {
            parse_mode: 'HTML',
            reply_markup: { force_reply: true },
         });
      } else if (data === 'add_scrape') {
         await bot.answerCallbackQuery(query.id);
         await bot.sendMessage(chatId, '🔍 <b>Kirimkan URL Website</b> yang mau discrape otomatis oleh AI:\n\n<i>Contoh:</i> <code>https://bisnis.com</code>', {
            parse_mode: 'HTML',
            reply_markup: { force_reply: true },
         });
      } else if (data === 'add_feed_prompt') {
         await bot.answerCallbackQuery(query.id);
         await handleAddFeed(query.message, null);
      } else if (data.startsWith('del_rss_')) {
         const index = parseInt(data.replace('del_rss_', ''), 10);
         if (activeFeeds[index]) {
            const removedUrl = activeFeeds.splice(index, 1)[0];
            saveFeeds(activeFeeds);
            await bot.answerCallbackQuery(query.id, { text: '✅ RSS feed berhasil dihapus!' });
            await bot.sendMessage(chatId, `🗑️ RSS feed dihapus:\n<code>${escapeHtml(removedUrl)}</code>`, { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) });
         } else {
            await bot.answerCallbackQuery(query.id, { text: '❌ Feed tidak ditemukan atau sudah dihapus.' });
         }
      } else if (data.startsWith('del_scrape_')) {
         const fileName = data.replace('del_scrape_', '');
         const fs = require('fs');
         const path = require('path');
         const { FILES } = require('./config');
         const filePath = path.join(FILES.SCRAPE_DIR, fileName);

         if (fs.existsSync(filePath)) {
            try {
               fs.unlinkSync(filePath);
               await bot.answerCallbackQuery(query.id, { text: '✅ Config Scraper berhasil dihapus!' });
               await bot.sendMessage(chatId, `🗑️ Config scraper <code>${escapeHtml(fileName)}</code> telah dihapus!`, { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) });
            } catch (err) {
               await bot.answerCallbackQuery(query.id, { text: '❌ Gagal menghapus file.' });
            }
         } else {
            await bot.answerCallbackQuery(query.id, { text: '❌ File config tidak ditemukan atau sudah dihapus.' });
         }
      }
   });

   async function handleAutoScrape(msg, match) {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.', getMainMenuKeyboard(chatId));
         return;
      }
      const rawInput = match ? match[1].trim() : '';
      if (!rawInput) {
         await bot.sendMessage(chatId, '⚠️ Format salah. Gunakan:\n`/autoscrape <URL_WEBSITE> [NAMA_MEDIA]`', { parse_mode: 'Markdown', ...getMainMenuKeyboard(chatId) });
         return;
      }
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
            { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) },
         );
      } catch (err) {
         console.error('⚠️ Gagal auto scrape:', err.message);
         await bot.sendMessage(chatId, `❌ Gagal membuat scraper otomatis: ${escapeHtml(err.message)}`, { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) });
      }
   }

   bot.onText(/\/autoscrape(?:\s+(.+))?/, handleAutoScrape);

   bot.onText(/\/removefeed (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.', getMainMenuKeyboard(chatId));
         return;
      }
      const url = match[1].trim();
      const index = activeFeeds.indexOf(url);
      if (index === -1) {
         await bot.sendMessage(chatId, `❌ Feed tidak ditemukan.\n\nKetik /listfeeds untuk melihat feed aktif.`, getMainMenuKeyboard(chatId));
         return;
      }
      activeFeeds.splice(index, 1);
      saveFeeds(activeFeeds);
      console.log(`➖ Feed dihapus: ${url}`);
      await bot.sendMessage(chatId, `🗑 RSS Feed berhasil dihapus!\n\nSisa RSS feed: ${activeFeeds.length}`, getMainMenuKeyboard(chatId));
   });

   bot.onText(/\/rewrite(?:\s+(on|off))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, '⛔ Kamu tidak punya akses ke command ini.', getMainMenuKeyboard(chatId));
         return;
      }

      const action = match[1]?.toLowerCase();

      if (!action) {
         const status = settings.rewriteEnabled ? '✅ *ON*' : '❌ *OFF*';
         const apiStatus = KIMI_API_KEY ? '✅ API key terkonfigurasi' : '⚠️ API key belum diset \\(KIMI\\_API\\_KEY di \\.env\\)';
         await bot.sendMessage(
            chatId,
            `🧠 *Rewrite Artikel \\(Kimi AI\\)*\n\n` + `Status: ${status}\n` + `Model: \`${escapeMarkdown(KIMI_MODEL)}\`\n` + `API: ${apiStatus}\n\n` + `Gunakan:\n` + `\`/rewrite on\` \u2014 aktifkan\n` + `\`/rewrite off\` \u2014 matikan`,
            { parse_mode: 'MarkdownV2', ...getMainMenuKeyboard(chatId) },
         );
         return;
      }

      if (action === 'on') {
         if (!KIMI_API_KEY) {
            await bot.sendMessage(chatId, '⚠️ KIMI_API_KEY belum diset di file .env. Isi dulu lalu restart bot.', getMainMenuKeyboard(chatId));
            return;
         }
         settings.rewriteEnabled = true;
         saveSettings(settings);
         console.log('🧠 Rewrite Kimi AI: ON');
         await bot.sendMessage(chatId, '✅ Rewrite artikel dengan Kimi AI <b>diaktifkan</b>.', { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) });
      } else {
         settings.rewriteEnabled = false;
         saveSettings(settings);
         console.log('🧠 Rewrite Kimi AI: OFF');
         await bot.sendMessage(chatId, '❌ Rewrite artikel dengan Kimi AI <b>dimatikan</b>.', { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) });
      }
   });

   bot.onText(/\/fetchnow/, handleFetchNow);

   // ── LISTENER TOMBOL REPLIES (TEXT BUTTONS) & FORCE REPLY ────────────────────
   bot.on('message', async (msg) => {
      if (!msg.text) return;
      const chatId = msg.chat.id;
      const text = msg.text.trim();

      // Jika user mengirim URL secara langsung (atau dari reply)
      if (text.startsWith('http://') || text.startsWith('https://')) {
         if (!isAdmin(chatId)) {
            await bot.sendMessage(chatId, `⛔ Fitur ini khusus Admin.\nChat ID kamu: <code>${chatId}</code>\n\nJika kamu Admin, set <code>ADMIN_CHAT_ID=${chatId}</code> di file <code>.env</code>.`, { parse_mode: 'HTML' });
            return;
         }

         if (text.includes('/feed') || text.includes('.xml') || text.includes('/rss')) {
            await handleAddFeed(msg, [null, text]);
         } else {
            await handleAutoScrape(msg, [null, text]);
         }
         return;
      }

      // Tangani pesan balasan dari tombol ForceReply (Tambah RSS / Scrape tanpa mengetik command)
      if (msg.reply_to_message && isAdmin(chatId)) {
         const replyText = msg.reply_to_message.text || '';
         if (replyText.includes('URL RSS Feed')) {
            await handleAddFeed(msg, [null, text]);
            return;
         } else if (replyText.includes('URL Website')) {
            await handleAutoScrape(msg, [null, text]);
            return;
         }
      }

      if (msg.text.startsWith('/')) return;

      switch (text) {
         case '📊 Status Bot':
            await handleStatus(msg);
            break;
         case '🔍 List Sumber Berita':
            await handleListFeeds(msg);
            break;
         case '➕ Tambah Feed':
            if (!isAdmin(chatId)) {
               await bot.sendMessage(chatId, '⛔ Perintah ini khusus Admin.', getMainMenuKeyboard(chatId));
               return;
            }
            await bot.sendMessage(
               chatId,
               '🌐 <b>Kirimkan URL Website / RSS Feed</b> yang ingin kamu tambahkan:\n\n' + '<i>Kamu cukup kirim/paste URL saja di sini, bot akan otomatis memprosesnya!</i>\n\n' + '<i>Contoh:</i> <code>https://www.kabarbursa.com/</code>',
               {
                  parse_mode: 'HTML',
                  reply_markup: { force_reply: true },
               },
            );
            break;
         case '🧠 Toggle AI Rewrite':
            if (!isAdmin(chatId)) {
               await bot.sendMessage(chatId, '⛔ Perintah ini khusus Admin.', getMainMenuKeyboard(chatId));
               return;
            }
            // Toggle status
            const newStatus = !settings.rewriteEnabled;
            if (newStatus && !KIMI_API_KEY) {
               await bot.sendMessage(chatId, '⚠️ KIMI_API_KEY belum diset di .env', getMainMenuKeyboard(chatId));
               return;
            }
            settings.rewriteEnabled = newStatus;
            saveSettings(settings);
            await bot.sendMessage(chatId, `🧠 Rewrite AI sekarang <b>${newStatus ? '✅ AKTIF (ON)' : '❌ NONAKTIF (OFF)'}</b>`, { parse_mode: 'HTML', ...getMainMenuKeyboard(chatId) });
            break;
         case '⚡ Fetch Berita Sekarang':
            await handleFetchNow(msg);
            break;
         case '🔔 Mulai Berlangganan':
            await handleStart(msg);
            break;
         case '🛑 Berhenti Langganan':
            await handleStop(msg);
            break;
      }
   });

   return { bot, broadcast };
}

module.exports = {
   initBot,
   isAdmin,
   escapeMarkdown,
   escapeHtml,
};
