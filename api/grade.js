// Vercel Serverless Function: POST /api/grade
// LatihTOEFL — penilaian Writing TOEFL iBT gaya e-rater via Gemini (free tier).
// Pola disalin dari api/ask.js Kamus Oleokimia (kamus-oleokimia-vercel):
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
//   halaman memanggil checker lokal sebagai fallback.
// - Fail-closed bila key belum dipasang: 503 dengan pesan yang sama seperti
//   produk lain ("AI belum aktif — API key belum dipasang di Vercel project ini").
// - Batas harian penilaian AI (10/user/hari) ditegakkan di halaman (counter
//   Firestore per UID per tanggal), bukan di sini — fungsi ini stateless.
'use strict';

const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-lite-latest'];
const ATTEMPT_TIMEOUT_MS = 25000;
const OVERALL_BUDGET_MS = 50000;
const MAX_TEXT_LEN = 5000;
const MIN_TEXT_LEN = 10;

const SYSTEM_PROMPT = [
  'Kamu adalah penilai TOEFL iBT Writing gaya e-rater (ETS).',
  'Nilai teks pengguna untuk tugas yang diberikan, dalam Bahasa Indonesia.',
  'Nilai 5 facet ini, masing-masing skala 1-6 (1 = sangat lemah, 6 = sangat baik):',
  'grammar (tata bahasa: tense, subject-verb agreement, kalimat),',
  'usage (pemakaian kata: artikel, preposisi, bentuk kata),',
  'mechanics (ejaan, tanda baca, kapitalisasi),',
  'wordChoice (pilihan kata, kolokasi, variasi kosakata),',
  'organisation (struktur, koherensi, kohesi, pengembangan gagasan).',
  'Berikan juga band keseluruhan 1-6 (boleh kelipatan 0,5), daftar temuan kesalahan',
  'yang paling penting (maksimal 8, tiap temuan: category, issue dalam Bahasa Indonesia,',
  'fix berupa perbaikan konkret), dan 2-4 saran perbaikan singkat dalam Bahasa Indonesia.',
  'Jawab HANYA dengan JSON valid, tanpa markdown fence, tanpa teks lain, dengan bentuk persis ini:',
  '{"band": 4.5, "facets": {"grammar": 4, "usage": 5, "mechanics": 5, "wordChoice": 4, "organisation": 4}, "findings": [{"category": "grammar", "issue": "...", "fix": "..."}], "suggestions": ["..."]}',
].join('\n');

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function callGeminiOpenAI(systemPrompt, userText, model) {
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
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        temperature: 0.2,
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

async function callGeminiNative(systemPrompt, userText, model) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
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
        contents: [{ parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.2 },
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

function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch (_) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }
}

function clampBand(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(6, Math.max(1, Math.round(n * 2) / 2));
}

function normalizeResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const band = clampBand(parsed.band);
  const facetsIn = parsed.facets && typeof parsed.facets === 'object' ? parsed.facets : {};
  const facets = {};
  let facetsOk = true;
  for (const key of ['grammar', 'usage', 'mechanics', 'wordChoice', 'organisation']) {
    const v = clampBand(facetsIn[key]);
    if (v === null) facetsOk = false;
    facets[key] = v === null ? 3 : v;
  }
  if (band === null || !facetsOk) return null;
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings
        .filter((f) => f && typeof f.issue === 'string' && f.issue.trim())
        .slice(0, 8)
        .map((f) => ({
          category: ['grammar', 'usage', 'mechanics', 'wordChoice', 'organisation'].includes(f.category)
            ? f.category
            : 'grammar',
          issue: String(f.issue).slice(0, 300),
          fix: String(f.fix || '').slice(0, 300),
        }))
    : [];
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.filter((s) => typeof s === 'string' && s.trim()).slice(0, 4).map((s) => String(s).slice(0, 300))
    : [];
  return { band, facets, findings, suggestions };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST {task, taskType, text, uid}' });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ error: 'AI belum aktif — API key belum dipasang di Vercel project ini' });
    return;
  }
  try {
    const body = req.body || {};
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const task = String((parsed && parsed.task) || '').trim().slice(0, 2000);
    const taskType = String((parsed && parsed.taskType) || '').trim().slice(0, 100);
    const uid = String((parsed && parsed.uid) || '').trim().slice(0, 200);
    const text = String((parsed && parsed.text) || '').trim();
    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    if (text.length < MIN_TEXT_LEN) {
      res.status(400).json({ error: `text too short (min ${MIN_TEXT_LEN} chars)` });
      return;
    }
    if (text.length > MAX_TEXT_LEN) {
      res.status(400).json({ error: `text too long (max ${MAX_TEXT_LEN} chars)` });
      return;
    }
    const userText = [
      taskType ? `Jenis tugas: ${taskType}.` : '',
      task ? `Tugas/soal: ${task}` : '',
      '',
      'Teks yang dinilai:',
      text,
    ]
      .filter(Boolean)
      .join('\n');
    const startedAt = Date.now();
    let result = null;
    let provider = '';
    let lastErr = '';
    for (const model of GEMINI_MODELS) {
      if (Date.now() - startedAt > OVERALL_BUDGET_MS) break;
      try {
        const raw = await callGeminiOpenAI(SYSTEM_PROMPT, userText, model);
        result = normalizeResult(extractJson(raw));
        if (result) {
          provider = `gemini:${model}`;
          break;
        }
        lastErr += `Gemini OpenAI ${model}: invalid JSON; `;
      } catch (e1) {
        lastErr += `Gemini OpenAI ${model}: ${e1.message}; `;
        if (Date.now() - startedAt > OVERALL_BUDGET_MS) break;
        try {
          const raw = await callGeminiNative(SYSTEM_PROMPT, userText, model);
          result = normalizeResult(extractJson(raw));
          if (result) {
            provider = `gemini-native:${model}`;
            break;
          }
          lastErr += `Gemini native ${model}: invalid JSON; `;
        } catch (e2) {
          lastErr += `Gemini native ${model}: ${e2.message}; `;
        }
      }
    }
    if (!result) {
      console.error('grade AI failed:', lastErr.slice(0, 500));
      res.status(502).json({ error: 'AI gagal menilai. Coba lagi nanti, atau pakai penilaian lokal.' });
      return;
    }
    res.status(200).json({ source: 'ai', provider, result });
  } catch (err) {
    console.error('grade error:', err && err.message ? String(err.message).slice(0, 200) : 'unknown');
    res.status(502).json({ error: 'AI belum tersedia. Coba lagi nanti, atau pakai penilaian lokal.' });
  }
};
