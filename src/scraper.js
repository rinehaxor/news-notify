const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const { FILES } = require('./config');

const parser = new Parser({
   timeout: 10_000,
   headers: { 'User-Agent': 'news-notify-bot/1.0' },
});

/**
 * Load semua scrape config dari folder scrape/
 */
function loadScrapeConfigs() {
   const configs = [];
   if (!fs.existsSync(FILES.SCRAPE_DIR)) return configs;
   const files = fs.readdirSync(FILES.SCRAPE_DIR).filter((f) => f.endsWith('.json'));
   for (const file of files) {
      try {
         const config = JSON.parse(fs.readFileSync(path.join(FILES.SCRAPE_DIR, file), 'utf8'));
         config._file = file;
         configs.push(config);
      } catch (err) {
         console.error(`⚠️  Gagal load scrape config ${file}:`, err.message);
      }
   }
   return configs;
}

/**
 * Scrape isi artikel dari URL.
 */
async function fetchArticleContent(url) {
   if (!url) return '';
   try {
      const res = await axios.get(url, {
         timeout: 15_000,
         headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
         },
      });
      const $ = cheerio.load(res.data);

      $('script, style, nav, header, footer, aside, .ads, .advertisement, .sidebar, .comment, .related, #comments').remove();

      const contentSelectors = [
         'article .content',
         'article .post-content',
         'article .entry-content',
         'article .article-body',
         '.detail__body-text',
         '.article-content',
         '.post-body',
         '.entry-content',
         '.content-detail',
         '.read__content',
         '.detail-content',
         'article p',
         '.content p',
         'main p',
      ];

      let text = '';
      for (const sel of contentSelectors) {
         const parts = [];
         $(sel).each((_, el) => {
            const t = $(el).text().trim();
            if (t.length > 30) parts.push(t);
         });
         if (parts.length > 0) {
            text = parts.join('\n\n');
            break;
         }
      }

      if (!text) {
         const parts = [];
         $('p').each((_, el) => {
            const t = $(el).text().trim();
            if (t.length > 30) parts.push(t);
         });
         text = parts.join('\n\n');
      }

      return text
         .replace(/[ \t]+/g, ' ')
         .replace(/\n{3,}/g, '\n\n')
         .trim();
   } catch (err) {
      console.error(`⚠️  Gagal fetch konten artikel ${url}:`, err.message);
      return '';
   }
}

/**
 * Check single RSS Feed URL
 */
async function checkFeed(feedUrl, seen, broadcastFn) {
   let feed;
   try {
      feed = await parser.parseURL(feedUrl);
   } catch (err) {
      console.error(`⚠️  Gagal fetch RSS ${feedUrl}:`, err.message);
      return 0;
   }

   const feedTitle = feed.title || feedUrl;
   let newCount = 0;

   for (const item of feed.items || []) {
      const id = item.guid || item.link || item.title;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      await broadcastFn(feedTitle, item);
      newCount++;
   }

   if (newCount > 0) {
      console.log(`[${new Date().toLocaleString('id-ID')}] ✅ ${newCount} artikel baru dari RSS "${feedTitle}"`);
   }
   return newCount;
}

/**
 * Scrape satu halaman kategori dari config website
 */
async function checkScrapePage(config, page, seen, broadcastFn) {
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
      return 0;
   }

   const $ = cheerio.load(html);
   const feedTitle = `${config.name} – ${page.label}`;
   const links = new Set();
   const urlRegex = config.urlPattern ? new RegExp(config.urlPattern) : null;

   $(config.articleLinkSelector).each((_, el) => {
      let href = $(el).attr('href') || '';
      if (href.startsWith('/')) href = config.baseUrl + href;
      if (!href.startsWith('http')) return;
      if (urlRegex && !urlRegex.test(href)) return;
      links.add(href);
   });

   let newCount = 0;
   for (const link of links) {
      if (seen.has(link)) continue;
      seen.add(link);

      let title = '';
      if (config.titleSelector) {
         const el = $(`a[href="${link.replace(config.baseUrl, '')}"]`);
         title = el.find(config.titleSelector).text().trim() || el.text().trim();
      } else {
         $(`a[href="${link}"], a[href="${link.replace(config.baseUrl, '')}"]`).each((_, el) => {
            const t = $(el).text().trim();
            if (t.length > title.length) title = t;
         });
      }

      if (!title) {
         const slug = link.split('/').pop();
         title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }

      const articleContent = await fetchArticleContent(link);
      await broadcastFn(feedTitle, { title, link, pubDate: null, contentSnippet: articleContent });
      newCount++;
   }

   if (newCount > 0) {
      console.log(`[${new Date().toLocaleString('id-ID')}] ✅ ${newCount} artikel baru dari scrape "${feedTitle}"`);
   }
   return newCount;
}

module.exports = {
   parser,
   loadScrapeConfigs,
   fetchArticleContent,
   checkFeed,
   checkScrapePage,
};
