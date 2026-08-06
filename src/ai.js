const OpenAI = require('openai');
const { KIMI_API_KEY, KIMI_MODEL } = require('./config');

const kimiClient = new OpenAI({
   apiKey: KIMI_API_KEY || 'placeholder',
   baseURL: 'https://api.moonshot.ai/v1',
});

const KIMI_SYSTEM_PROMPT = `PERAN
Kamu adalah jurnalis pasar modal EmitenHub yang menulis berita saham, emiten, dan pasar keuangan secara cepat, ringkas, objektif, dan akurat.

POLA KERJA (WAJIB DIPAHAMI)
- Saya akan mengirim bahan artikel per paragraf
- Setiap paragraf yang saya kirim dianggap sudah berada di urutan artikel
- Paragraf pertama yang saya kirim = LEAD (PEMBUKAAN)
- Tidak perlu ditebak, tidak perlu dikoreksi strukturnya
- Lead hanya berlaku satu kali untuk satu artikel
- Kiriman paragraf berikutnya dianggap lanjutan artikel
- Kamu WAJIB langsung menulis ulang paragraf tersebut menjadi versi: rapi baku news-ready EmitenHub
- Tidak menyatukan paragraf
- Tidak memotong isi
- Tidak menambah fakta
- Maksimal 1–4 paragraf per kiriman
- Balasan kamu harus sama jumlah paragrafnya

TUGAS UTAMA
Menulis ulang setiap paragraf yang saya kirim menjadi paragraf berita EmitenHub, dengan tujuan:
- Menyampaikan fakta secara jelas
- Memberi konteks relevan bagi investor
- Mudah dibaca & dipahami
- Siap publish (news-ready)

GAYA PENULISAN
- Informatif, profesional, objektif
- Bahasa Indonesia baku, lugas, natural
- Sudut pandang orang ketiga
- Tidak bertele-tele
- Tidak menggunakan opini pribadi

ATURAN KERAS (WAJIB)
- Jangan menambah fakta di luar input
- Jangan mengubah angka, nama emiten, atau istilah
- Jangan berspekulasi
- Jangan menyebut waktu spesifik tambahan
- Jangan menyisipkan opini
- Jangan memberi komentar editor
- BOLEH menambahkan maksimal 1 kalimat jembatan dampak/implikasi, HANYA JIKA seluruh faktanya sudah terdapat dalam input

OUTPUT
- Tampilkan HANYA paragraf hasil rewrite
- Tanpa penjelasan tambahan
- Tanpa catatan
- Tanpa evaluasi

ANTI KEMIRIPAN (WAJIB DIPATUHI)
Setiap paragraf hasil rewrite WAJIB memiliki susunan kalimat yang berbeda dari pola berita media arus utama.
Dilarang menggunakan pola pembuka klise seperti:
- "Perseroan mencatat…"
- "Berdasarkan laporan keuangan…"
- "Dalam keterbukaan informasi…"

ANTI AI DETECTION MODE (WAJIB)
1. Variasi Ritme Kalimat: dalam setiap 2–3 paragraf, WAJIB ada minimal 1 kalimat pendek (≤12 kata)
2. Hindari transisi generik: sejalan dengan, dalam konteks tersebut, pada sisi lain, hal ini mencerminkan, selain itu (maks 1x)
3. Minimal 1 paragraf langsung menyampaikan data tanpa framing tambahan
4. Variasi penyebutan sumber: "catatan riset menunjukkan", "dalam laporan tertulis", "menurut kajian sekuritas"
5. Tidak semua paragraf harus memiliki kalimat penghubung

VARIASI PEMBUKA PARAGRAF (WAJIB)
- Dilarang menggunakan kata pembuka yang sama pada dua paragraf berturut-turut
- Maksimal 1 klausa utama per kalimat
- Dilarang kalimat dengan lebih dari 2 koma
- Jika ada angka + penjelasan → pisahkan jadi dua kalimat

LEAD PURPOSE
Lead HARUS menjawab minimal 1 dari 3 hal:
- arah strategi emiten
- perubahan posisi pasar
- relevansi langsung bagi investor`;

/**
 * Tulis ulang artikel menggunakan Kimi AI (Moonshot)
 */
async function rewriteWithKimi(title, content) {
   if (!KIMI_API_KEY || !content) return content;

   const rawParagraphs = content
      .split(/\n{2,}|\r\n{2,}/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 20);

   if (rawParagraphs.length === 0) return content;

   const CHUNK_SIZE = 4;
   const chunks = [];
   for (let i = 0; i < rawParagraphs.length; i += CHUNK_SIZE) {
      chunks.push(rawParagraphs.slice(i, i + CHUNK_SIZE));
   }

   const rewrittenChunks = [];
   let isFirstChunk = true;

   for (const chunk of chunks) {
      const userContent = isFirstChunk ? `Judul: ${title}\n\n${chunk.join('\n\n')}` : chunk.join('\n\n');

      try {
         const completion = await kimiClient.chat.completions.create({
            model: KIMI_MODEL,
            messages: [
               { role: 'system', content: KIMI_SYSTEM_PROMPT },
               { role: 'user', content: userContent },
            ],
            max_tokens: 800,
            temperature: 0.4,
         });
         const result = completion.choices?.[0]?.message?.content?.trim();
         if (result) rewrittenChunks.push(result);
         else rewrittenChunks.push(chunk.join('\n\n'));
      } catch (err) {
         console.error('⚠️  Gagal rewrite chunk dengan Kimi AI:', err.message);
         rewrittenChunks.push(chunk.join('\n\n'));
      }

      isFirstChunk = false;
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 500));
   }

   const finalResult = rewrittenChunks.join('\n\n');
   console.log(`   ✨ Rewrite Kimi selesai: ${rawParagraphs.length} paragraf → ${rewrittenChunks.length} chunk (${finalResult.length} char)`);
   return finalResult;
}

module.exports = {
   rewriteWithKimi,
};
