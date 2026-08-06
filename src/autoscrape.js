const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { FILES } = require('./config');

/**
 * Menganalisis URL website berita dan membuatkan file JSON scrape secara otomatis
 */
async function autoGenerateScrapeConfig(url, customName = null) {
   let parsedUrl;
   try {
      if (!url.startsWith('http')) {
         url = 'https://' + url;
      }
      parsedUrl = new URL(url);
   } catch (err) {
      throw new Error(`URL tidak valid: ${url}`);
   }

   const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
   const siteDomain = parsedUrl.hostname.replace(/^www\./, '');

   // Fetch HTML halaman depan/kategori
   const res = await axios.get(url, {
      timeout: 15_000,
      headers: {
         'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
         Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
   });

   const $ = cheerio.load(res.data);

   // Ambil nama website dari title/og:site_name
   const siteName =
      customName ||
      $('meta[property="og:site_name"]').attr('content') ||
      $('title')
         .text()
         .split(/[-|_|•]/)[0]
         .trim() ||
      siteDomain;

   // Kumpulkan link internal
   const linkCounts = new Map();
   const linkTexts = new Map();

   $('a').each((_, el) => {
      let href = $(el).attr('href') || '';
      const text = $(el).text().trim();

      if (href.startsWith('/')) href = baseUrl + href;
      if (!href.startsWith('http')) return;

      try {
         const u = new URL(href);
         if (u.hostname.replace(/^www\./, '') !== siteDomain) return; // Skip external link

         // Exclude link non-artikel umum
         const pathName = u.pathname;
         if (pathName === '/' || pathName.length < 3 || /\.(jpg|jpeg|png|gif|css|js|svg|pdf)$/i.test(pathName) || /login|register|subscribe|about|contact|privacy|terms|search|faq/i.test(pathName)) {
            return;
         }

         linkCounts.set(href, (linkCounts.get(href) || 0) + 1);
         if (text && text.length > 10) {
            linkTexts.set(href, text);
         }
      } catch (e) {}
   });

   if (linkCounts.size === 0) {
      throw new Error(`Tidak dapat mengidentifikasi struktur link artikel di ${url}`);
   }

   // Tentukan selector artikel terbaik & regex pattern jika ada
   let articleLinkSelector = `a[href*='${siteDomain}']`;

   // Simpan ke JSON file
   const fileName = `${siteDomain.replace(/[^a-z0-9]/gi, '_')}.json`;
   const filePath = path.join(FILES.SCRAPE_DIR, fileName);

   const configData = {
      name: siteName,
      pages: [
         {
            url: url,
            label: 'Utama',
         },
      ],
      articleLinkSelector: articleLinkSelector,
      urlPattern: null,
      titleSelector: null,
      baseUrl: baseUrl,
   };

   // Jika folder scrape belum ada, buat foldernya
   if (!fs.existsSync(FILES.SCRAPE_DIR)) {
      fs.mkdirSync(FILES.SCRAPE_DIR, { recursive: true });
   }

   fs.writeFileSync(filePath, JSON.stringify(configData, null, 3), 'utf8');

   return {
      fileName,
      filePath,
      config: configData,
      totalLinksFound: linkCounts.size,
   };
}

module.exports = {
   autoGenerateScrapeConfig,
};
