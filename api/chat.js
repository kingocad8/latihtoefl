// Vercel Serverless Function: POST /api/chat
// LatihTOEFL — chatbot tutor TOEFL iBT 2026 via Gemini (free tier).
// Pola disalin dari api/grade.js (yang disalin dari api/ask.js Kamus Oleokimia):
// - API key HANYA dari env GEMINI_API_KEY — tidak pernah hardcode di sini,
//   tidak pernah di index.html, tidak pernah di git, tidak pernah di log/respons.
//   Pemilik mengisinya sendiri di Vercel Dashboard > Settings > Environment Variables.
// - Rantai model gratis yang sama: gemini-3.5-flash-lite / gemini-3.6-flash /
//   gemini-flash-lite-latest (gemini-2.5-flash 404 "no longer available to new
//   users" untuk key yang dibuat Okt 2026 ke atas). Per model dicoba dulu
//   endpoint OpenAI-compatible, lalu endpoint native :generateContent.
//   Semua model di sini free-tier Flash/Flash-Lite saja; tidak ada model
//   berbayar, tidak ada auto-upgrade, tidak ada pembelian kredit.
//   Bila semua gagal (termasuk 429 / kuota habis), fail closed 502 —
//   halaman memakai jawaban lokal sebagai fallback.
// - Fail-closed bila key belum dipasang: 503 dengan pesan yang sama seperti
//   produk lain ("AI belum aktif — API key belum dipasang di Vercel project ini").
// - Fungsi ini stateless; batas pemakaian harian (bila ada) ditegakkan di halaman,
//   bukan di sini.
'use strict';

const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-lite-latest'];
const ATTEMPT_TIMEOUT_MS = 25000;
const OVERALL_BUDGET_MS = 50000;
const MAX_MESSAGES = 10;
const MIN_CONTENT_LEN = 1;
const MAX_CONTENT_LEN = 2000;
const MAX_TOTAL_LEN = 8000;
const MAX_REPLY_LEN = 3000;

const SYSTEM_PROMPT = [
  'Kamu adalah tutor TOEFL iBT 2026 yang ramah di aplikasi LatihTOEFL.',
  'Jawab SINGKAT dan to the point — maksimal sekitar 5 kalimat, kecuali user secara',
  'eksplisit minta penjelasan detail atau contoh panjang.',
  'Pakai contoh konkret setiap kali menjelaskan materi (misalnya contoh kalimat,',
  'contoh soal, atau contoh kesalahan umum).',
  'Kalau tulisan user dalam bahasa Inggris ada kesalahan grammar, koreksi secara',
  'singkat di akhir jawaban dengan penjelasan satu baris per kesalahan.',
  'Kalau relevan, arahkan user ke materi latihan di LatihTOEFL (Reading, Listening,',
  'Writing, Speaking, bank soal, atau Simulasi Ujian).',
  'Kalau user mengobrol dalam bahasa Inggris, balas dalam bahasa Inggris sederhana',
  'dan tetap sertakan koreksi singkat bila ada kesalahan.',
  'JANGAN berikan jawaban soal ujian resmi TOEFL, JANGAN klaim atau janjikan skor',
  'resmi, dan JANGAN beri nasihat medis atau hukum.',
  'Kalau tidak yakin dengan suatu fakta (misalnya aturan ETS terbaru), katakan',
  'terus terang bahwa kamu tidak yakin dan sarankan user memeriksa sumber resmi ETS.',
].join('\n');

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function callGeminiOpenAI(systemPrompt, history, model) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const res = await fetchWithTimeout(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }].concat(history),
        temperature: 0.7,
      }),
    },
    ATTEMPT_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Gemini failed: ${res.status}`);
  const data = await res.json();
  const text =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('Gemini empty response');
  return text;
}

async function callGeminiNative(systemPrompt, history, model) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.7 },
      }),
    },
    ATTEMPT_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Gemini native failed: ${res.status}`);
  const data = await res.json();
  const parts =
    data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = parts ? parts.map((p) => p.text || '').join('') : '';
  if (!text) throw new Error('Gemini native empty response');
  return text;
}

function validateMessages(input) {
  if (!Array.isArray(input)) return 'messages must be an array';
  if (input.length < 1) return 'messages is required';
  if (input.length > MAX_MESSAGES) return `messages too many (max ${MAX_MESSAGES})`;
  let total = 0;
  const history = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') return 'each message must be an object';
    if (m.role !== 'user' && m.role !== 'assistant') return 'message role must be "user" or "assistant"';
    const content = String(m.content || '').trim();
    if (content.length < MIN_CONTENT_LEN) return 'message content is required';
    if (content.length > MAX_CONTENT_LEN) return `message too long (max ${MAX_CONTENT_LEN} chars)`;
    total += content.length;
    if (total > MAX_TOTAL_LEN) return `conversation too long (max ${MAX_TOTAL_LEN} chars)`;
    history.push({ role: m.role, content });
  }
  return history;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST {uid, messages: [{role, content}]}' });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ error: 'AI belum aktif — API key belum dipasang di Vercel project ini' });
    return;
  }
  try {
    const body = req.body || {};
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const uid = String((parsed && parsed.uid) || '').trim().slice(0, 200);
    void uid;
    const historyOrError = validateMessages(parsed && parsed.messages);
    if (typeof historyOrError === 'string') {
      res.status(400).json({ error: historyOrError });
      return;
    }
    const history = historyOrError;
    const startedAt = Date.now();
    let reply = null;
    let provider = '';
    let lastErr = '';
    for (const model of GEMINI_MODELS) {
      if (Date.now() - startedAt > OVERALL_BUDGET_MS) break;
      try {
        const raw = await callGeminiOpenAI(SYSTEM_PROMPT, history, model);
        const text = String(raw || '').trim();
        if (text) {
          reply = text.slice(0, MAX_REPLY_LEN);
          provider = `gemini:${model}`;
          break;
        }
        lastErr += `Gemini OpenAI ${model}: empty reply; `;
      } catch (e1) {
        lastErr += `Gemini OpenAI ${model}: ${e1.message}; `;
        if (Date.now() - startedAt > OVERALL_BUDGET_MS) break;
        try {
          const raw = await callGeminiNative(SYSTEM_PROMPT, history, model);
          const text = String(raw || '').trim();
          if (text) {
            reply = text.slice(0, MAX_REPLY_LEN);
            provider = `gemini-native:${model}`;
            break;
          }
          lastErr += `Gemini native ${model}: empty reply; `;
        } catch (e2) {
          lastErr += `Gemini native ${model}: ${e2.message}; `;
        }
      }
    }
    if (!reply) {
      console.error('chat AI failed:', lastErr.slice(0, 500));
      res.status(502).json({ error: 'AI belum tersedia. Coba lagi nanti, atau pakai jawaban lokal.' });
      return;
    }
    res.status(200).json({ source: 'ai', provider, reply });
  } catch (err) {
    console.error('chat error:', err && err.message ? String(err.message).slice(0, 200) : 'unknown');
    res.status(502).json({ error: 'AI belum tersedia. Coba lagi nanti, atau pakai jawaban lokal.' });
  }
};
