// Vercel serverless function: /api/tts
// Keys live ONLY in Vercel Environment Variables:
//   GEMINI_KEY_1, GEMINI_KEY_2, GEMINI_KEY_3 ...   (or GEMINI_KEYS=key1,key2,key3)

const MODEL = 'gemini-2.5-flash-preview-tts';
const MAX_TEXT_LENGTH = 4000; // per request (client sends ~700 chars chunks)

const VOICES = new Set([
  'Iapetus', 'Aoede', 'Gacrux', 'Vindemiatrix', 'Fenrir', 'Puck', 'Charon',
  'Sadaltager', 'Sulafat', 'Schedar', 'Orus', 'Rasalgethi', 'Enceladus',
  'Achird', 'Algieba'
]);

function getKeys() {
  const keys = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (name.startsWith('GEMINI_KEY_')) keys.push(value.trim());
    if (name === 'GEMINI_KEYS') keys.push(...value.split(',').map(k => k.trim()).filter(Boolean));
  }
  return [...new Set(keys)];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const payload = body && body.payload;
  const text = payload?.contents?.[0]?.parts?.[0]?.text;
  const voice = payload?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName;

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: { message: 'Missing text' } });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: { message: 'Text chunk too long' } });
  }
  if (!VOICES.has(voice)) {
    return res.status(400).json({ error: { message: 'Unknown voice' } });
  }

  const keys = getKeys();
  if (keys.length === 0) {
    return res.status(500).json({ error: { message: 'No API keys configured on server' } });
  }

  // Rebuild the request ourselves so clients cannot change model or settings.
  const geminiBody = JSON.stringify({
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let lastStatus = 429;
  let lastMessage = 'All keys are busy';

  for (const key of shuffle(keys)) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: geminiBody
      });

      if (r.ok) {
        const data = await r.json();
        return res.status(200).json(data);
      }

      const err = await r.json().catch(() => ({}));
      lastStatus = r.status;
      lastMessage = err?.error?.message || `Upstream error ${r.status}`;

      // Quota hit, bad key, or Google-side error -> try the next key.
      if (r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500) continue;

      // Other 4xx (e.g. 400 bad request) will fail on every key; stop here.
      return res.status(r.status).json({ error: { message: lastMessage } });
    } catch (e) {
      lastMessage = 'Network error reaching Gemini';
      lastStatus = 502;
    }
  }

  const status = lastStatus === 429 || lastStatus === 502 ? lastStatus : 503;
  return res.status(status).json({ error: { message: lastMessage }, retryAfter: 20 });
};
