const { BOT_TOKEN, ADMIN_CHAT_ID, INTERVAL_MINUTES, INITIAL_FEEDS } = require('./src/config');
const { loadSubscribers, loadFeeds, loadSeen, saveSeen, loadSettings } = require('./src/storage');
const { loadScrapeConfigs, parser, checkFeed, checkScrapePage } = require('./src/scraper');
const { initBot } = require('./src/bot');

// Validasi env awal
if (!BOT_TOKEN) {
   console.error('❌  TELEGRAM_BOT_TOKEN wajib diisi di file .env');
   process.exit(1);
}

// Global State
const subscribers = loadSubscribers();
const activeFeeds = loadFeeds();
const settings = loadSettings();
const seen = loadSeen();
const scrapeConfigs = loadScrapeConfigs();

if (INITIAL_FEEDS.length === 0 && activeFeeds.length === 0) {
   console.error('❌  RSS_FEEDS wajib diisi di file .env');
   process.exit(1);
}

let broadcastFn = null;

async function checkAllFeeds() {
   if (!broadcastFn) return;

   for (const url of activeFeeds) {
      await checkFeed(url, seen, broadcastFn);
   }

   for (const config of scrapeConfigs) {
      for (const page of config.pages) {
         await checkScrapePage(config, page, seen, broadcastFn);
      }
   }

   saveSeen(seen);
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
            const axios = require('axios');
            const cheerio = require('cheerio');
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

   saveSeen(seen);
   console.log(`✅ ${seen.size} artikel lama dicatat, bot siap memantau.\n`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
   const totalScrapePages = scrapeConfigs.reduce((sum, c) => sum + c.pages.length, 0);
   console.log('🚀 News Notify Bot dimulai');
   console.log(`   RSS Feed   : ${activeFeeds.length} sumber`);
   console.log(`   Scrape     : ${scrapeConfigs.length} website (${totalScrapePages} halaman)`);
   console.log(`   Interval   : setiap ${INTERVAL_MINUTES} menit`);
   console.log(`   Subscriber : ${subscribers.size} orang`);
   console.log(`   Admin      : ${ADMIN_CHAT_ID ? ADMIN_CHAT_ID : '⚠️ belum diset di .env (akses admin ditolak)'}\n`);

   const { broadcast } = initBot({
      subscribers,
      activeFeeds,
      settings,
      seen,
      checkAllFeedsFn: checkAllFeeds,
   });

   broadcastFn = broadcast;

   // Jika seen masih kosong (pertama kali run), lakukan seeding
   if (seen.size === 0) {
      await seedSeen();
   } else {
      console.log(`✅ ${seen.size} artikel lama dimuat dari seen.json, bot siap memantau.\n`);
   }

   setInterval(
      async () => {
         console.log(`[${new Date().toLocaleString('id-ID')}] 🔍 Memeriksa feed & scrape baru…`);
         await checkAllFeeds();
      },
      INTERVAL_MINUTES * 60 * 1000,
   );
})();

// Graceful Shutdown & Error handling
function cleanup() {
   console.log('\n🛑 Menyimpan state sebelum shutdown...');
   saveSeen(seen);
   process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (err) => {
   console.error('💥 Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
   console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
