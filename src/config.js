require('dotenv').config();
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;
const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES || '5', 10);
const TIMEZONE = process.env.TIMEZONE || 'Asia/Jakarta';

const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2-turbo-preview';

const INITIAL_FEEDS = (process.env.RSS_FEEDS || '')
   .split(',')
   .map((s) => s.trim())
   .filter(Boolean);

const FILES = {
   SUBSCRIBERS: path.join(ROOT_DIR, 'subscribers.json'),
   FEEDS: path.join(ROOT_DIR, 'feeds.json'),
   SEEN: path.join(ROOT_DIR, 'seen.json'),
   SETTINGS: path.join(ROOT_DIR, 'settings.json'),
   SCRAPE_DIR: path.join(ROOT_DIR, 'scrape'),
};

module.exports = {
   BOT_TOKEN,
   ADMIN_CHAT_ID,
   INTERVAL_MINUTES,
   TIMEZONE,
   KIMI_API_KEY,
   KIMI_MODEL,
   INITIAL_FEEDS,
   FILES,
};
