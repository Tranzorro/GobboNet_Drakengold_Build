/* @gobbonet-split js/11-search.js
   Moved verbatim from chat.html lines 7849-8065.
   web search, llama.cpp connection check
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   WEB SEARCH
================================================================ */
let searchEnabled = false;

function toggleSearch() {
  searchEnabled = !searchEnabled;
  state.searchEnabled = searchEnabled;
  saveState();
  document.getElementById('search-toggle').classList.toggle('active', searchEnabled);
}

async function webSearch(query) {
  const apiKey = state.settings.apiKey;
  if (!apiKey) {
    console.warn('[search] No API key set in settings');
    return null;
  }

  console.log(`[search] Starting search for: "${query}"`);
  console.log(`[search] API key present: ${apiKey.slice(0, 6)}...`);

  // Step 1: Check if proxy is reachable
  try {
    const healthCheck = await fetch(SEARCH_PROXY_URL + '/health');
    if (!healthCheck.ok) {
      console.error(`[search] Proxy health check failed: HTTP ${healthCheck.status}`);
      return null;
    }
    console.log('[search] Proxy is healthy');
  } catch (e) {
    console.error('[search] Proxy unreachable at ' + SEARCH_PROXY_URL + ' — ' + e.message);
    console.error('[search] Make sure GobboNet is running (it starts the proxy)');
    return null;
  }

  // Step 2: Send search request through proxy
  try {
    console.log('[search] Sending POST to proxy...');
    const resp = await fetch(SEARCH_PROXY_URL + '/web_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query, max_results: 5 })
    });

    console.log(`[search] Proxy responded: HTTP ${resp.status}`);
    const rawText = await resp.text();
    console.log(`[search] Raw response (first 500 chars): ${rawText.slice(0, 500)}`);

    if (!resp.ok) {
      console.error(`[search] Non-OK status ${resp.status}: ${rawText}`);
      return null;
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(`[search] Response is not valid JSON: ${parseErr.message}`);
      return null;
    }

    if (data.error) {
      console.error(`[search] API returned error: ${data.error}`);
      return null;
    }

    if (data.results && data.results.length > 0) {
      console.log(`[search] Got ${data.results.length} results`);
      return data.results;
    } else {
      console.warn('[search] Response parsed OK but no results array:', data);
      return null;
    }
  } catch (e) {
    console.error(`[search] Fetch failed: ${e.name}: ${e.message}`);
    return null;
  }
}

/* Test connection — called from settings */
async function testSearchConnection() {
  const statusEl = document.getElementById('search-test-status');
  const outputEl = document.getElementById('search-test-output');
  const apiKey = document.getElementById('set-apikey').value.trim();

  statusEl.textContent = 'Testing...';
  statusEl.style.color = 'var(--cyan-mid)';
  outputEl.style.display = 'block';
  outputEl.textContent = '';

  let log = '';
  const addLog = (msg) => { log += msg + '\n'; outputEl.textContent = log; };

  // Test 1: Proxy health
  addLog('>>> Step 1: Check proxy at ' + SEARCH_PROXY_URL + '/health');
  try {
    const h = await fetch(SEARCH_PROXY_URL + '/health');
    const hText = await h.text();
    addLog(`    Status: ${h.status} — ${hText}`);
    if (!h.ok) {
      statusEl.textContent = 'Proxy unhealthy';
      statusEl.style.color = 'var(--red-neon)';
      return;
    }
    addLog('    Proxy is alive!');
  } catch (e) {
    addLog(`    FAILED: ${e.message}`);
    addLog('    The search proxy is not running.');
    addLog('    Make sure GobboNet itself is running.');
    statusEl.textContent = 'Proxy not reachable';
    statusEl.style.color = 'var(--red-neon)';
    return;
  }

  // Test 2: API key check
  addLog('');
  addLog('>>> Step 2: Test search API via proxy');
  if (!apiKey) {
    addLog('    No API key entered. Paste one above first.');
    statusEl.textContent = 'No API key';
    statusEl.style.color = 'var(--red-neon)';
    return;
  }
  addLog(`    Key: ${apiKey.slice(0, 8)}...`);

  try {
    const resp = await fetch(SEARCH_PROXY_URL + '/web_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query: 'test', max_results: 2 })
    });

    addLog(`    HTTP Status: ${resp.status}`);
    const raw = await resp.text();
    addLog(`    Response body:`);
    addLog('    ' + raw.slice(0, 800));

    if (!resp.ok) {
      statusEl.textContent = `Failed: HTTP ${resp.status}`;
      statusEl.style.color = 'var(--red-neon)';
      return;
    }

    try {
      const data = JSON.parse(raw);
      if (data.error) {
        addLog(`    API Error: ${data.error}`);
        statusEl.textContent = 'API error (see below)';
        statusEl.style.color = 'var(--red-neon)';
      } else if (data.results && data.results.length > 0) {
        addLog(`    Got ${data.results.length} results — search is working!`);
        statusEl.textContent = `Working! (${data.results.length} results)`;
        statusEl.style.color = 'var(--green-neon)';
      } else {
        addLog('    Parsed OK but no results array found.');
        addLog('    Keys in response: ' + Object.keys(data).join(', '));
        statusEl.textContent = 'Unexpected response format';
        statusEl.style.color = 'var(--red-neon)';
      }
    } catch (pe) {
      addLog(`    Response is not valid JSON: ${pe.message}`);
      statusEl.textContent = 'Invalid JSON response';
      statusEl.style.color = 'var(--red-neon)';
    }
  } catch (e) {
    addLog(`    Fetch failed: ${e.message}`);
    statusEl.textContent = 'Request failed';
    statusEl.style.color = 'var(--red-neon)';
  }
}

function formatSearchResults(results) {
  if (!results || results.length === 0) return '';
  let text = '\n\n[Web Search Results]\n';
  for (const r of results) text += `- ${r.title}: ${r.content}\n  Source: ${r.url}\n`;
  text += '[End of Search Results]\n\nUse the search results above to inform your response. Cite sources when relevant.';
  return text;
}

/* ================================================================
   LLM SERVER & PORT CONNECTION CHECK
================================================================ */
async function checkConnection() {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');

  // Helper to mark UI connected
  function markConnected(serverName, port, latencyMs, modelName) {
    serverConnected = true;
    serverOfflineReason = '';
    serverOfflinePhase = '';
    if (dot) dot.classList.add('connected');
    if (label) {
      const sPort = port ? ` :${port}` : '';
      const sPing = latencyMs ? ` (${latencyMs}ms)` : '';
      label.textContent = `${serverName}${sPort}`;
      label.title = `Engine: ${serverName} | Target Port: ${port || 'N/A'}${sPing} | Model: ${modelName || 'Active'}`;
      label.style.color = '';
    }
  }

  // 1. Try LLAMA_URL /health (standard llama.cpp)
  try {
    const resp = await privacyFetch(LLAMA_URL + '/health');
    if (resp.ok) {
      const data = await resp.json();
      detectedLlmServer = data;
      markConnected(data.server_name || 'llama.cpp', data.port || 11437, data.latency_ms, data.model);
      return;
    }
  } catch (_) {}

  // 2. Try LLAMA_URL with KoboldCpp or OpenAI endpoints (e.g. if reverse proxy points to KoboldCpp)
  try {
    const kResp = await privacyFetch(LLAMA_URL + '/api/extra/version');
    if (kResp.ok) {
      const kd = await kResp.json();
      detectedLlmServer = {
        online: true,
        localServerDetected: true,
        server_name: 'KoboldCpp',
        port: detectedLlmServer?.port || 5001,
        url: LLAMA_URL,
        model: kd.result || 'KoboldCpp',
        latency_ms: 6
      };
      markConnected('KoboldCpp', detectedLlmServer.port, 6, kd.result);
      return;
    }
  } catch (_) {}

  try {
    const mResp = await privacyFetch(LLAMA_URL + '/v1/models');
    if (mResp.ok) {
      const md = await mResp.json();
      const firstModel = (md.data && md.data[0] && md.data[0].id) || 'OpenAI-Compatible';
      detectedLlmServer = {
        online: true,
        localServerDetected: true,
        server_name: detectedLlmServer?.server_name || 'LLM Engine',
        port: detectedLlmServer?.port || 5001,
        url: LLAMA_URL,
        model: firstModel,
        latency_ms: 6
      };
      markConnected(detectedLlmServer.server_name, detectedLlmServer.port, 6, firstModel);
      return;
    }
  } catch (_) {}

  // 3. Fallback: if client-side probing previously found a local server (e.g. KoboldCpp on 5001)
  if (detectedLlmServer && detectedLlmServer.localServerDetected && detectedLlmServer.port) {
    const port = detectedLlmServer.port;
    const isLive = await probeSinglePort(port);
    if (isLive) {
      markConnected(detectedLlmServer.server_name || 'KoboldCpp', port, detectedLlmServer.latency_ms || 10, detectedLlmServer.model);
      return;
    }
  }

  // 4. Mark offline if all checks failed
  serverConnected = false;
  if (dot) dot.classList.remove('connected');
  if (label) {
    label.textContent = 'No connection';
    label.style.color = 'var(--red-neon)';
  }
  await refreshOfflineReason();
}

/**
 * Probes a single port across Linux loopback variants (127.0.0.1 and localhost)
 * with both CORS and no-cors fallback to detect servers like KoboldCpp on Linux.
 */
async function probeSinglePort(port, timeoutMs = 600) {
  const hosts = ['127.0.0.1', 'localhost'];
  if (window.location.hostname && !hosts.includes(window.location.hostname)) {
    hosts.push(window.location.hostname);
  }

  const paths = (port === 5001 || port === 5000)
    ? ['/api/extra/version', '/api/v1/model', '/v1/models', '/']
    : ['/health', '/api/version', '/v1/models', '/'];

  for (const host of hosts) {
    // Stage A: Standard CORS fetch to read JSON metadata
    for (const p of paths) {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeoutMs);
        const res = await fetch(`http://${host}:${port}${p}`, {
          signal: c.signal,
          headers: { 'Accept': 'application/json' }
        });
        clearTimeout(t);
        if (res.ok) {
          let modelName = '';
          try {
            const d = await res.json();
            if (d.result) modelName = d.result;
            else if (d.models && d.models[0]) modelName = d.models[0].name;
            else if (d.data && d.data[0]) modelName = d.data[0].id;
          } catch (_) {}
          return { ok: true, host, port, model: modelName, corsOk: true };
        }
      } catch (_) {}
    }

    // Stage B: Linux no-cors probe fallback (detects KoboldCpp when running without --cors)
    try {
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), timeoutMs);
      await fetch(`http://${host}:${port}/`, {
        mode: 'no-cors',
        signal: c2.signal
      });
      clearTimeout(t2);
      // In mode: 'no-cors', connection refused throws TypeError, while an open HTTP port succeeds
      return { ok: true, host, port, model: 'Active (CORS restricted)', corsOk: false };
    } catch (_) {}
  }

  return null;
}

async function clientSideProbeLlmServers() {
  const candidatePorts = [
    { port: 5001, name: 'KoboldCpp' },
    { port: 5000, name: 'KoboldAI' },
    { port: 11437, name: 'llama.cpp' },
    { port: 11434, name: 'Ollama' },
    { port: 1234, name: 'LM Studio' },
    { port: 8080, name: 'llama-server' },
    { port: 8000, name: 'vLLM' }
  ];

  for (const candidate of candidatePorts) {
    const res = await probeSinglePort(candidate.port, 500);
    if (res && res.ok) {
      detectedLlmServer = {
        online: true,
        localServerDetected: true,
        server_name: candidate.name,
        port: candidate.port,
        url: `http://${res.host}:${candidate.port}`,
        model: res.model || `${candidate.name} Model`,
        latency_ms: 8,
        corsOk: res.corsOk
      };
      serverConnected = true;
      if (!res.corsOk && (candidate.port === 5001 || candidate.port === 5000)) {
        serverOfflineReason = `KoboldCpp detected on port ${candidate.port}. Note: launch with --cors flag if direct browser requests stall.`;
      } else {
        serverOfflineReason = '';
      }
      return detectedLlmServer;
    }
  }
  return null;
}

async function scanLlmServers(btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'SCANNING...';
  }
  try {
    const resp = await fetch('/api/detect-llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'scan' })
    });
    if (resp.ok) {
      const result = await resp.json();
      if (result.active) detectedLlmServer = result.active;
      await checkConnection();
      await loadActiveModel();
      if (typeof render === 'function') render();
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⟳ RESCAN PORTS';
      }
      return;
    }
  } catch (e) {
    console.warn('[scan] Server-side detect endpoint unavailable, falling back to Linux dual-stack client probe:', e);
  }

  // Fallback for native Linux executable where /api/detect-llm is not present
  await clientSideProbeLlmServers();
  await checkConnection();
  await loadActiveModel();
  if (typeof render === 'function') render();

  if (btn) {
    btn.disabled = false;
    btn.textContent = '⟳ RESCAN PORTS';
  }
}

async function connectLlmPort(portNumber) {
  const p = parseInt(portNumber, 10);
  if (!p || isNaN(p)) return;
  try {
    const resp = await fetch('/api/detect-llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: p })
    });
    if (resp.ok) {
      const result = await resp.json();
      if (result.active) detectedLlmServer = result.active;
      await checkConnection();
      await loadActiveModel();
      if (typeof render === 'function') render();
      return;
    }
  } catch (e) {
    console.warn('[connect] Server endpoint not available, probing port locally:', e);
  }

  // Client-side fallback for native Linux binary
  const probe = await probeSinglePort(p, 800);
  const sName = p === 5001 ? 'KoboldCpp' : (p === 5000 ? 'KoboldAI' : (p === 11434 ? 'Ollama' : (p === 1234 ? 'LM Studio' : `Server :${p}`)));

  detectedLlmServer = {
    online: !!probe,
    localServerDetected: true,
    server_name: sName,
    port: p,
    url: probe ? `http://${probe.host}:${p}` : `http://127.0.0.1:${p}`,
    model: (probe && probe.model) ? probe.model : `${sName} Model`,
    latency_ms: probe ? 6 : 999,
    corsOk: probe ? probe.corsOk : false
  };
  serverConnected = !!probe;
  await checkConnection();
  if (typeof render === 'function') render();
}



/* ================================================================
   WHY IS IT DOWN?

   "HTTP 502" is true and useless: it says llama-server did not answer,
   not what stopped it. The supervisor already knows -- it captures
   llama-server's stderr and pulls the actionable line out of it, VRAM
   exhaustion included -- and publishes it at /swap-status. Nothing ever
   asked, so the landing page filled the gap with a hardcoded guess that
   told Linux users to run a Windows batch file (issue #43).

   Only runs when we are actually served over HTTP. Opened as a file://
   page there is no server to ask, and the fetch would just throw.

   Failure here is deliberately silent. This is decoration on top of a
   status we already have; if the endpoint is unreachable the caller
   still knows the connection is down and says so in plainer words.
================================================================ */
async function refreshOfflineReason() {
  serverOfflineReason = '';
  serverOfflinePhase = '';
  if (!IS_SERVED) return;
  try {
    const r = await fetch('/swap-status', { cache: 'no-store' });
    if (!r.ok) return;
    const s = await r.json();
    serverOfflinePhase = String(s.phase || '');
    // "ready" while we cannot reach it means the supervisor's view is stale,
    // so there is no reason worth quoting -- fall through to the generic line
    // rather than print a contradiction.
    if (s.phase === 'error') {
      serverOfflineReason = String(s.message || '');
    } else if (s.phase === 'starting') {
      // Mid-load the message is just "Loading model", which the pill already
      // says. The filename is the part the user does not know.
      serverOfflineReason = String(s.name || s.file || '');
    }
  } catch (_) { /* leave it to the generic message */ }
}

