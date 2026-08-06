const fs = require('fs');
const { FILES, INITIAL_FEEDS } = require('./config');

const MAX_SEEN_ITEMS = 5000;

// ── SUBSCRIBERS ───────────────────────────────────────────────────────────────
function loadSubscribers() {
   try {
      if (fs.existsSync(FILES.SUBSCRIBERS)) {
         const data = JSON.parse(fs.readFileSync(FILES.SUBSCRIBERS, 'utf8'));
         return new Set(data);
      }
   } catch (err) {
      console.error('⚠️  Gagal memuat subscribers.json:', err.message);
   }
   return new Set();
}

function saveSubscribers(subscribersSet) {
   try {
      fs.writeFileSync(FILES.SUBSCRIBERS, JSON.stringify([...subscribersSet]), 'utf8');
   } catch (err) {
      console.error('❌ Gagal simpan subscribers.json:', err.message);
   }
}

// ── FEEDS (RSS) ───────────────────────────────────────────────────────────────
function loadFeeds() {
   try {
      if (fs.existsSync(FILES.FEEDS)) {
         return JSON.parse(fs.readFileSync(FILES.FEEDS, 'utf8'));
      }
   } catch (err) {
      console.error('⚠️  Gagal memuat feeds.json:', err.message);
   }
   saveFeeds(INITIAL_FEEDS);
   return [...INITIAL_FEEDS];
}

function saveFeeds(feedList) {
   try {
      fs.writeFileSync(FILES.FEEDS, JSON.stringify(feedList, null, 2), 'utf8');
   } catch (err) {
      console.error('❌ Gagal simpan feeds.json:', err.message);
   }
}

// ── SEEN (ARTIKEL) ────────────────────────────────────────────────────────────
function loadSeen() {
   try {
      if (fs.existsSync(FILES.SEEN)) {
         const data = JSON.parse(fs.readFileSync(FILES.SEEN, 'utf8'));
         if (Array.isArray(data)) {
            return new Set(data);
         }
      }
   } catch (err) {
      console.error('⚠️  Gagal memuat seen.json:', err.message);
   }
   return new Set();
}

function saveSeen(seenSet) {
   try {
      let arr = [...seenSet];
      // Jika melebihi batas, pertahankan hanya item-item terbaru
      if (arr.length > MAX_SEEN_ITEMS) {
         arr = arr.slice(arr.length - MAX_SEEN_ITEMS);
      }
      fs.writeFileSync(FILES.SEEN, JSON.stringify(arr), 'utf8');
   } catch (err) {
      console.error('❌ Gagal simpan seen.json:', err.message);
   }
}

// ── SETTINGS (RUNTIME CONFIG) ──────────────────────────────────────────────────
function loadSettings() {
   const defaults = { rewriteEnabled: false };
   try {
      if (fs.existsSync(FILES.SETTINGS)) {
         return { ...defaults, ...JSON.parse(fs.readFileSync(FILES.SETTINGS, 'utf8')) };
      }
   } catch (err) {
      console.error('⚠️  Gagal memuat settings.json:', err.message);
   }
   return defaults;
}

function saveSettings(settings) {
   try {
      fs.writeFileSync(FILES.SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
   } catch (err) {
      console.error('❌ Gagal simpan settings.json:', err.message);
   }
}

module.exports = {
   loadSubscribers,
   saveSubscribers,
   loadFeeds,
   saveFeeds,
   loadSeen,
   saveSeen,
   loadSettings,
   saveSettings,
};
