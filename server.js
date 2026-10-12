import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// In-memory persistent state (mirrored to a local state file if needed)
const STATE_FILE = path.join(__dirname, '.gobbonet-state.json');
let savedState = {};
let stateMtime = Date.now();

try {
  if (fs.existsSync(STATE_FILE)) {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    savedState = JSON.parse(raw);
    const stat = fs.statSync(STATE_FILE);
    stateMtime = stat.mtimeMs;
  }
} catch (e) {
  console.warn('[state] Could not load initial state file:', e.message);
}

// Active model tracking
let activeModelConfig = {
  id: 'gemma3-4b',
  name: 'Gemma 3 4B IT',
  family: 'gemma',
  maxCtx: 131072,
  defaultCtx: 32768,
  thinkingFormat: 'none',
  ggufFile: 'gemma-3-4b-it-q4_k_m.gguf',
  hint: 'Universal LLM engine ready. Auto-detects KoboldCpp, llama.cpp, Ollama & LM Studio.'
};

let tuningConfig = {
  ctx: 32768,
  gpu_layers: 99,
  kv_cache: 'f16'
};

let standDownConfig = {
  minutes: 0,
  active: false
};

// =========================================================================
// UNIVERSAL LLM SERVER DETECTOR & PROBER
// Detects KoboldCpp, KoboldAI, llama.cpp, Ollama, LM Studio, vLLM, etc.
// =========================================================================

const CANDIDATE_PORTS = [
  { port: 5001, defaultName: 'KoboldCpp', type: 'kobold' },
  { port: 5000, defaultName: 'KoboldAI', type: 'kobold' },
  { port: 11437, defaultName: 'llama.cpp', type: 'llama' },
  { port: 11434, defaultName: 'Ollama', type: 'ollama' },
  { port: 1234, defaultName: 'LM Studio', type: 'lmstudio' },
  { port: 8080, defaultName: 'llama-server', type: 'llama' },
  { port: 8000, defaultName: 'vLLM', type: 'vllm' }
];

// If env LLM_URL is provided, extract its port
if (process.env.LLM_URL) {
  try {
    const u = new URL(process.env.LLM_URL);
    const p = parseInt(u.port, 10);
    if (p && !CANDIDATE_PORTS.some(c => c.port === p)) {
      CANDIDATE_PORTS.unshift({ port: p, defaultName: 'Custom Server', type: 'custom' });
    }
  } catch (_) {}
}

let activeDetectedServer = {
  online: true,
  localServerDetected: false,
  type: 'cloud_or_builtin',
  name: 'Checking...',
  port: 3000,
  url: 'http://127.0.0.1:3000',
  model: 'gemma3-4b',
  latencyMs: 1,
  lastChecked: Date.now()
};

let lastScanResults = [];

async function probePort(port, host = '127.0.0.1', timeoutMs = 600) {
  // Never probe our own listening port
  if (port === PORT) return null;

  const candidateEndpoints = [
    { path: '/api/extra/version', hint: 'KoboldCpp', check: (d) => d && (d.result !== undefined || d.version !== undefined) },
    { path: '/api/v1/model', hint: 'Kobold', check: (d) => d && typeof d.result === 'string' },
    { path: '/health', hint: 'llama.cpp', check: (d) => d && (d.status === 'ok' || d.status === 'loading model' || d.slots_idle !== undefined || d.slots_processing !== undefined) },
    { path: '/api/tags', hint: 'Ollama', check: (d) => d && Array.isArray(d.models) },
    { path: '/api/version', hint: 'Ollama', check: (d) => d && typeof d.version === 'string' },
    { path: '/v1/models', hint: 'OpenAI-Compatible', check: (d) => d && (Array.isArray(d.data) || Array.isArray(d.models)) }
  ];

  const t0 = Date.now();
  for (const { path: ep, hint, check } of candidateEndpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const url = `http://${host}:${port}${ep}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - t0;

      const contentType = res.headers.get('content-type') || '';
      // Ignore plain HTML pages (like web servers or routers)
      if (contentType.includes('text/html')) continue;

      if (res.ok || res.status === 200) {
        let data = null;
        try {
          data = await res.json();
        } catch (_) {
          continue;
        }

        // Verify that this is genuinely an LLM API response matching signature
        if (check && !check(data)) {
          continue;
        }

        let detectedName = hint;
        let detectedType = hint.toLowerCase();
        let modelName = '';

        if (ep.startsWith('/api/extra/version')) {
          detectedName = 'KoboldCpp';
          detectedType = 'kobold';
          if (data && typeof data.result === 'string') {
            detectedName = `KoboldCpp (${data.result})`;
          }
        } else if (ep.startsWith('/api/v1/model')) {
          detectedName = 'KoboldCpp / KoboldAI';
          detectedType = 'kobold';
          if (data && typeof data.result === 'string') {
            modelName = data.result;
          }
        } else if (ep.startsWith('/api/tags') || ep.startsWith('/api/version')) {
          detectedName = 'Ollama';
          detectedType = 'ollama';
          if (data && Array.isArray(data.models) && data.models[0]) {
            modelName = data.models[0].name || '';
          }
        } else if (ep === '/health') {
          detectedName = 'llama.cpp';
          detectedType = 'llama';
          if (data && data.model) modelName = data.model;
        } else if (ep === '/v1/models') {
          if (port === 5001 || port === 5000) {
            detectedName = 'KoboldCpp';
            detectedType = 'kobold';
          } else if (port === 11434) {
            detectedName = 'Ollama';
            detectedType = 'ollama';
          } else if (port === 1234) {
            detectedName = 'LM Studio';
            detectedType = 'lmstudio';
          } else if (port === 11437 || port === 8080) {
            detectedName = 'llama.cpp';
            detectedType = 'llama';
          } else if (port === 8000) {
            detectedName = 'vLLM';
            detectedType = 'vllm';
          }
          if (data && Array.isArray(data.data) && data.data[0]) {
            modelName = data.data[0].id || '';
          }
        }

        return {
          online: true,
          localServerDetected: true,
          port,
          host,
          url: `http://${host}:${port}`,
          type: detectedType,
          name: detectedName,
          model: modelName || `${detectedName} Model`,
          latencyMs,
          endpoint: ep
        };
      }
    } catch (_) {
      // Endpoint not active on this port
    }
  }
  return null;
}

async function scanAllLlmTargets() {
  const results = [];
  let foundFirst = null;

  for (const item of CANDIDATE_PORTS) {
    const probe = await probePort(item.port);
    if (probe) {
      results.push(probe);
      if (!foundFirst) foundFirst = probe;
    } else {
      results.push({
        online: false,
        port: item.port,
        name: item.defaultName,
        type: item.type
      });
    }
  }

  lastScanResults = results;

  if (foundFirst) {
    activeDetectedServer = foundFirst;
    activeModelConfig.name = foundFirst.model || foundFirst.name;
    activeModelConfig.id = 'custom';
    console.log(`[llm-detect] Detected active LLM server: ${foundFirst.name} on port ${foundFirst.port} (${foundFirst.latencyMs}ms)`);
  } else {
    // If no local port is listening, configure cloud or built-in
    const isGemini = !!process.env.GEMINI_API_KEY;
    activeDetectedServer = {
      online: true,
      localServerDetected: false,
      type: isGemini ? 'gemini' : 'builtin',
      name: isGemini ? 'Google Gemini (Cloud Engine)' : 'GobboNet Built-in Simulated Engine',
      port: 3000,
      url: 'http://127.0.0.1:3000',
      model: isGemini ? 'gemini-3.8-flash' : 'gemma3-4b',
      latencyMs: 1,
      lastChecked: Date.now()
    };
    console.log(`[llm-detect] No local server responding on ports [${CANDIDATE_PORTS.map(p => p.port).join(', ')}]. Active engine: ${activeDetectedServer.name}`);
  }

  return activeDetectedServer;
}

// Initial scan
scanAllLlmTargets().catch(() => {});

// Jobs manager (detached generations)
const jobs = new Map();

function newJobId() {
  return crypto.randomBytes(16).toString('hex');
}

// Helper to format OpenAI SSE chunk
function makeSSEChunk(jobId, model, deltaText, isFinish = false) {
  if (isFinish) {
    return (
      `data: ${JSON.stringify({
        id: 'chatcmpl-' + jobId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || activeDetectedServer.model || 'gemma3-4b',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })}\n\n` +
      `data: [DONE]\n\n`
    );
  }
  return `data: ${JSON.stringify({
    id: 'chatcmpl-' + jobId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || activeDetectedServer.model || 'gemma3-4b',
    choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }]
  })}\n\n`;
}

// Initialize Gemini if key is available
let aiClient = null;
if (process.env.GEMINI_API_KEY) {
  try {
    aiClient = new GoogleGenAI();
    console.log('[engine] Google Gemini API initialized');
  } catch (err) {
    console.warn('[engine] Failed to initialize Gemini API:', err.message);
  }
}

// Simulated fallback generator if Gemini API key not present or on error
async function generateFallbackStream(messages, onChunk, onDone, isCancelled) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || 'Hello';
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';

  let characterFlavor = 'GobboNet Assistant';
  let replyIntro = '';

  if (systemMsg.toLowerCase().includes('codegoblin') || systemMsg.toLowerCase().includes('goblin')) {
    characterFlavor = 'CodeGoblin';
    replyIntro = "*cackles and taps rusty mechanical keyboard*\n\nHehehe! Goblin engineer at your service! Let's inspect this code before something catches fire.\n\n";
  } else if (systemMsg.toLowerCase().includes('informant')) {
    characterFlavor = 'Informant';
    replyIntro = "*leans forward from the shadows and slides a decrypted parchment across the steel table*\n\nKeep your voice down. Here is the intel you asked for:\n\n";
  } else if (systemMsg.toLowerCase().includes('dungeon master') || systemMsg.toLowerCase().includes('dm')) {
    characterFlavor = 'Dungeon Master';
    replyIntro = "*rolls a twenty-sided die behind the screen*\n\nThe torchlight wavers across the stone walls as the party waits in suspense...\n\n";
  } else if (systemMsg.toLowerCase().includes('storyteller')) {
    characterFlavor = 'Storyteller';
    replyIntro = "*takes a slow breath as embers drift from the hearth*\n\nEvery journey begins with a spoken word, and yours unfolds thus:\n\n";
  } else {
    replyIntro = `Greetings from **GobboNet**! [${activeDetectedServer.name}]\n\n`;
  }

  const serverInfo = activeDetectedServer.localServerDetected
    ? `Connected to local server **${activeDetectedServer.name}** on port **${activeDetectedServer.port}**.`
    : `Operating via **${activeDetectedServer.name}**. Ready to connect to KoboldCpp, llama.cpp, or Ollama on loopback.`;

  const simulatedResponse = `${replyIntro}You said: *"${lastUserMsg.trim()}"*.\n\n` +
    `${serverInfo}\n\n` +
    `GobboNet supports markdown, LaTeX formatting ($$\\int_0^\\infty e^{-x} dx = 1$$), and hot-swappable model targets across all local and cloud LLM servers!`;

  const words = simulatedResponse.split(' ');
  for (let i = 0; i < words.length; i += 3) {
    if (isCancelled()) break;
    const chunk = words.slice(i, i + 3).join(' ') + (i + 3 < words.length ? ' ' : '');
    onChunk(chunk);
    await new Promise(r => setTimeout(r, 40));
  }
  onDone();
}

async function runGeminiStream(messages, onChunk, onDone, onError, isCancelled) {
  try {
    if (!aiClient) {
      throw new Error('No Gemini client available');
    }

    let systemInstruction = '';
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += (systemInstruction ? '\n\n' : '') + msg.content;
      } else if (msg.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
    }

    const responseStream = await aiClient.models.generateContentStream({
      model: 'gemini-3.8-flash',
      contents,
      config: systemInstruction ? { systemInstruction } : undefined
    });

    for await (const chunk of responseStream) {
      if (isCancelled()) break;
      const text = chunk.text;
      if (text) {
        onChunk(text);
      }
    }
    onDone();
  } catch (err) {
    console.warn('[gemini] Stream error, falling back to simulated generation:', err.message);
    if (!isCancelled()) {
      await generateFallbackStream(messages, onChunk, onDone, isCancelled);
    }
  }
}

// Forward streaming request to local LLM server (KoboldCpp, llama.cpp, Ollama, LM Studio)
async function runLocalUpstreamStream(targetUrl, requestBody, onChunk, onDone, onError, isCancelled) {
  try {
    const upstreamUrl = `${targetUrl}/v1/chat/completions`;
    const resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        ...requestBody,
        stream: true
      })
    });

    if (!resp.ok) {
      throw new Error(`Upstream ${upstreamUrl} returned HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (isCancelled()) {
        try { reader.cancel(); } catch (_) {}
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data:')) {
          try {
            const parsed = JSON.parse(trimmed.slice(5).trim());
            const text = parsed.choices?.[0]?.delta?.content ||
                         parsed.choices?.[0]?.delta?.reasoning_content ||
                         parsed.message?.content || '';
            if (text) onChunk(text);
          } catch (_) {
            // raw text line
          }
        }
      }
    }
    onDone();
  } catch (err) {
    console.warn('[upstream] Local server error, falling back:', err.message);
    if (aiClient) {
      await runGeminiStream(requestBody.messages || [], onChunk, onDone, onError, isCancelled);
    } else {
      await generateFallbackStream(requestBody.messages || [], onChunk, onDone, isCancelled);
    }
  }
}

// Background generation runner for a job
function executeJob(job, requestBody) {
  const messages = requestBody.messages || [];
  const model = requestBody.model || activeDetectedServer.model || activeModelConfig.id;

  const onChunk = (text) => {
    if (job.status !== 'running') return;
    const sse = makeSSEChunk(job.id, model, text, false);
    job.buffer += sse;
    job.updatedAt = Math.floor(Date.now() / 1000);
  };

  const onDone = () => {
    if (job.status !== 'running') return;
    const sseFinish = makeSSEChunk(job.id, model, '', true);
    job.buffer += sseFinish;
    job.status = 'done';
    job.updatedAt = Math.floor(Date.now() / 1000);
  };

  const onError = (errMsg) => {
    if (job.status !== 'running') return;
    job.status = 'error';
    job.error = errMsg;
    job.updatedAt = Math.floor(Date.now() / 1000);
  };

  const isCancelled = () => job.status === 'cancelled';

  if (activeDetectedServer.localServerDetected) {
    runLocalUpstreamStream(activeDetectedServer.url, requestBody, onChunk, onDone, onError, isCancelled);
  } else if (aiClient) {
    runGeminiStream(messages, onChunk, onDone, onError, isCancelled);
  } else {
    generateFallbackStream(messages, onChunk, onDone, isCancelled);
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '64mb' }));
app.use(express.urlencoded({ extended: true, limit: '64mb' }));

// Auth routes
app.get('/login', (req, res) => {
  res.redirect('/');
});

app.post('/login', (req, res) => {
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  res.redirect('/');
});

// =========================================================================
// HEALTH & PING ENDPOINTS
// Pings detected server port directly
// =========================================================================

app.get('/llm/health', async (req, res) => {
  if (activeDetectedServer.localServerDetected) {
    // Actively ping the detected port
    const t0 = Date.now();
    const probe = await probePort(activeDetectedServer.port, activeDetectedServer.host || '127.0.0.1', 800);
    const latency = Date.now() - t0;

    if (probe) {
      activeDetectedServer.online = true;
      activeDetectedServer.latencyMs = latency;
      return res.json({
        status: 'ok',
        online: true,
        server_name: activeDetectedServer.name,
        server_type: activeDetectedServer.type,
        port: activeDetectedServer.port,
        url: activeDetectedServer.url,
        model: activeDetectedServer.model,
        latency_ms: latency,
        local_server_detected: true
      });
    } else {
      activeDetectedServer.online = false;
      return res.status(503).json({
        status: 'offline',
        online: false,
        error: `LLM server on port ${activeDetectedServer.port} is not responding`,
        server_name: activeDetectedServer.name,
        port: activeDetectedServer.port,
        local_server_detected: true
      });
    }
  }

  // Cloud or built-in
  res.json({
    status: 'ok',
    online: true,
    server_name: activeDetectedServer.name,
    server_type: activeDetectedServer.type,
    port: activeDetectedServer.port,
    url: activeDetectedServer.url,
    model: activeDetectedServer.model,
    latency_ms: activeDetectedServer.latencyMs || 1,
    local_server_detected: false
  });
});

app.get('/health-fileserver', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.7.6',
    lan: true,
    port: PORT,
    model_dir: 'models',
    models_available: true,
    detected_llm: activeDetectedServer
  });
});

app.get('/search/health', (req, res) => {
  res.json({ status: 'ok', provider: 'local' });
});

// Endpoint for detecting, scanning, and selecting target LLM ports
app.get('/api/detect-llm', (req, res) => {
  res.json({
    active: activeDetectedServer,
    scanned: lastScanResults,
    known_ports: CANDIDATE_PORTS
  });
});

app.post('/api/detect-llm', async (req, res) => {
  const { action, port, url } = req.body || {};

  if (action === 'scan') {
    const detected = await scanAllLlmTargets();
    return res.json({
      active: detected,
      scanned: lastScanResults
    });
  }

  if (port) {
    const targetPort = parseInt(port, 10);
    const probe = await probePort(targetPort);
    if (probe) {
      activeDetectedServer = probe;
      activeModelConfig.name = probe.model || probe.name;
      return res.json({
        status: 'ok',
        connected: true,
        active: activeDetectedServer
      });
    } else {
      // Connect anyway to user-specified port even if probe hasn't answered yet
      activeDetectedServer = {
        online: false,
        localServerDetected: true,
        port: targetPort,
        host: '127.0.0.1',
        url: `http://127.0.0.1:${targetPort}`,
        type: 'custom',
        name: `Custom Server (Port ${targetPort})`,
        model: 'Custom Model',
        latencyMs: null
      };
      return res.json({
        status: 'warn',
        connected: false,
        message: `Port ${targetPort} probed but not responding yet`,
        active: activeDetectedServer
      });
    }
  }

  if (url) {
    try {
      const u = new URL(url);
      const targetPort = parseInt(u.port, 10) || 80;
      activeDetectedServer = {
        online: true,
        localServerDetected: true,
        port: targetPort,
        host: u.hostname,
        url,
        type: 'custom',
        name: `Server (${u.hostname}:${targetPort})`,
        model: 'Custom Model',
        latencyMs: null
      };
      return res.json({ status: 'ok', active: activeDetectedServer });
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
  }

  res.json({ active: activeDetectedServer });
});

app.get('/active-model.json', (req, res) => {
  res.json({
    ...activeModelConfig,
    defaultCtx: tuningConfig.ctx
  });
});

app.get('/models-list.json', (req, res) => {
  const list = [
    {
      file: activeDetectedServer.model || 'active-model.gguf',
      name: `${activeDetectedServer.name} (${activeDetectedServer.model})`,
      id: 'active',
      remote: true
    },
    {
      file: 'gemma-3-4b-it-q4_k_m.gguf',
      name: 'Gemma 3 4B IT',
      id: 'gemma3-4b',
      remote: false
    },
    {
      file: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash (Cloud)',
      id: 'custom',
      remote: false
    },
    {
      file: 'deepseek-r1-8b.gguf',
      name: 'DeepSeek-R1 8B (Reasoning)',
      id: 'deepseek-r1-8b',
      remote: false
    }
  ];
  res.json({
    current: activeDetectedServer.model || activeModelConfig.ggufFile,
    models: list
  });
});

app.get('/catalog.json', (req, res) => {
  res.json({ models: [] });
});

app.get('/ui-defaults.json', (req, res) => {
  res.json({ ui: {} });
});

app.get('/perf', (req, res) => {
  res.json(tuningConfig);
});

app.post('/perf', (req, res) => {
  if (req.body.ctx) tuningConfig.ctx = Number(req.body.ctx);
  if (req.body.gpu_layers !== undefined) tuningConfig.gpu_layers = Number(req.body.gpu_layers);
  if (req.body.kv_cache) tuningConfig.kv_cache = String(req.body.kv_cache);
  res.json(tuningConfig);
});

app.get('/standdown', (req, res) => {
  res.json(standDownConfig);
});

app.post('/standdown', (req, res) => {
  if (req.body.minutes !== undefined) standDownConfig.minutes = Number(req.body.minutes);
  res.json(standDownConfig);
});

app.post('/swap-model', (req, res) => {
  const file = req.body?.file || 'gemma-3-4b-it-q4_k_m.gguf';
  activeModelConfig.ggufFile = file;
  if (file.includes('deepseek')) {
    activeModelConfig.id = 'deepseek-r1-8b';
    activeModelConfig.name = 'DeepSeek-R1 8B';
    activeModelConfig.thinkingFormat = 'deepseek';
  } else if (file.includes('gemini')) {
    activeModelConfig.id = 'custom';
    activeModelConfig.name = 'Gemini 3.8 Flash';
    activeModelConfig.thinkingFormat = 'none';
  } else {
    activeModelConfig.id = 'gemma3-4b';
    activeModelConfig.name = 'Gemma 3 4B IT';
    activeModelConfig.thinkingFormat = 'none';
  }
  res.status(202).json({ status: 'swapping', file });
});

app.get('/swap-status', (req, res) => {
  res.json({ phase: 'ready' });
});

// State Sync Endpoints
app.get('/state/info', (req, res) => {
  const str = JSON.stringify(savedState);
  res.json({
    mtime: Math.floor(stateMtime / 1000),
    size: Buffer.byteLength(str, 'utf-8')
  });
});

app.get('/state/profiles', (req, res) => {
  res.json({ profiles: ['shared'] });
});

app.get('/state', (req, res) => {
  res.json(savedState);
});

app.post('/state', (req, res) => {
  savedState = req.body;
  stateMtime = Date.now();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(savedState, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[state] Could not save state to disk:', e.message);
  }
  res.json({ status: 'ok', mtime: Math.floor(stateMtime / 1000) });
});

app.delete('/state', (req, res) => {
  savedState = {};
  stateMtime = Date.now();
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (_) {}
  res.json({ status: 'ok' });
});

// Detached LLM Jobs API
app.post('/llm/jobs', (req, res) => {
  const id = newJobId();
  const thread = req.query.thread || '';
  const now = Math.floor(Date.now() / 1000);

  const job = {
    id,
    thread,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    buffer: '',
    error: null
  };

  jobs.set(id, job);
  executeJob(job, req.body);

  res.status(202).json({
    id,
    status: 'running'
  });
});

app.get('/llm/jobs/:id', (req, res) => {
  const { id } = req.params;
  const job = jobs.get(id);

  if (!job) {
    return res.status(404).json({ error: 'unknown job', id });
  }

  const from = Math.max(0, parseInt(req.query.from, 10) || 0);
  const max = Math.min(262144, parseInt(req.query.max, 10) || 262144);

  const rawBytes = Buffer.from(job.buffer, 'utf-8');
  const totalSize = rawBytes.length;

  let chunk = Buffer.alloc(0);
  let next = from;

  if (from < totalSize) {
    const end = Math.min(totalSize, from + max);
    chunk = rawBytes.subarray(from, end);
    next = end;
  }

  const out = {
    id: job.id,
    status: job.status,
    size: totalSize,
    next,
    started_at: job.startedAt,
    updated_at: job.updatedAt
  };

  if (chunk.length > 0) {
    out.chunk_b64 = chunk.toString('base64');
  }

  if (job.error) {
    out.error = job.error;
  }

  res.json(out);
});

app.post('/llm/jobs/:id/cancel', (req, res) => {
  const { id } = req.params;
  const job = jobs.get(id);
  if (!job) {
    return res.status(404).json({ error: 'unknown job', id });
  }
  job.status = 'cancelled';
  job.updatedAt = Math.floor(Date.now() / 1000);
  res.json({ id: job.id, status: 'cancelling' });
});

app.delete('/llm/jobs/:id', (req, res) => {
  const { id } = req.params;
  jobs.delete(id);
  res.json({ id, status: 'deleted' });
});

// Legacy direct streaming route
app.post('/llm/v1/chat/completions', async (req, res) => {
  const stream = req.body?.stream !== false;
  const messages = req.body?.messages || [];
  const model = req.body?.model || activeDetectedServer.model || activeModelConfig.id;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let isAborted = false;
    req.on('close', () => { isAborted = true; });

    const onChunk = (text) => {
      if (isAborted) return;
      res.write(makeSSEChunk('direct', model, text, false));
    };

    const onDone = () => {
      if (isAborted) return;
      res.write(makeSSEChunk('direct', model, '', true));
      res.end();
    };

    const onError = (msg) => {
      if (isAborted) return;
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.end();
    };

    const isCancelled = () => isAborted;

    if (activeDetectedServer.localServerDetected) {
      await runLocalUpstreamStream(activeDetectedServer.url, req.body, onChunk, onDone, onError, isCancelled);
    } else if (aiClient) {
      await runGeminiStream(messages, onChunk, onDone, onError, isCancelled);
    } else {
      await generateFallbackStream(messages, onChunk, onDone, isCancelled);
    }
  } else {
    // Non-streaming
    let fullText = '';
    const onChunk = (t) => { fullText += t; };
    const onDone = () => {
      res.json({
        id: 'chatcmpl-direct',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: fullText },
          finish_reason: 'stop'
        }]
      });
    };
    const onError = (msg) => {
      res.status(500).json({ error: msg });
    };
    if (activeDetectedServer.localServerDetected) {
      await runLocalUpstreamStream(activeDetectedServer.url, req.body, onChunk, onDone, onError, () => false);
    } else if (aiClient) {
      await runGeminiStream(messages, onChunk, onDone, onError, () => false);
    } else {
      await generateFallbackStream(messages, onChunk, onDone, () => false);
    }
  }
});

// Static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/chat.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});

app.get('/favicon.ico', (req, res) => {
  if (fs.existsSync(path.join(__dirname, 'gobbonet.ico'))) {
    res.sendFile(path.join(__dirname, 'gobbonet.ico'));
  } else {
    res.status(204).end();
  }
});

// Serve everything else as static assets
app.use(express.static(__dirname));

// Start server
app.listen(PORT, HOST, () => {
  console.log(`[gobbonet] Server listening at http://${HOST}:${PORT}`);
});
