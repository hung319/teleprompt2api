// =================================================================================
//  Project: teleprompt-2api (Bun Edition)
//  Version: 1.1.0 (Refactored for Bun)
//  Protocol: Chimera Synthesis
//  Environment: Bun Runtime
//
//  Changes:
//  - Removed HTML/WebUI (Headless Mode)
//  - Switched to Bun.serve()
//  - Added .env support
// =================================================================================

// --- [Part 1: Core Configuration] ---
const CONFIG = {
  PROJECT_NAME: "teleprompt-2api-bun",
  PROJECT_VERSION: "1.1.0",
  
  // Load from .env (Bun automatically loads .env files)
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  PORT: process.env.PORT || 3000,
  
  // Upstream Configuration
  UPSTREAM_ORIGIN: "https://teleprompt-v2-backend-production.up.railway.app",
  EXTENSION_ORIGIN: "chrome-extension://alfpjlcndmeoainjfgbbnphcidpnmoae",
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",

  // Model Mapping
  MODEL_MAP: {
    "teleprompt-reason": "/api/v1/prompt/optimize_reason_auth",
    "teleprompt-standard": "/api/v1/prompt/optimize_auth",
    "teleprompt-apps": "/api/v1/prompt/optimize_apps_auth"
  },
  
  DEFAULT_MODEL: "teleprompt-reason",
  STREAM_DELAY: 10 // ms
};

// --- [Part 2: Bun Server Entry] ---
console.log(`🚀 ${CONFIG.PROJECT_NAME} v${CONFIG.PROJECT_VERSION} is starting...`);
console.log(`🔌 Listening on port: ${CONFIG.PORT}`);
console.log(`🔑 Master Key Configured: ${CONFIG.API_MASTER_KEY !== "1" ? "YES" : "NO (Unsafe)"}`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. Health Check (Root) - Replaced UI with JSON status
    if (url.pathname === '/') {
      return new Response(JSON.stringify({ 
        status: "alive", 
        service: CONFIG.PROJECT_NAME,
        version: CONFIG.PROJECT_VERSION 
      }), {
        headers: corsHeaders({ 'Content-Type': 'application/json' })
      });
    } 
    
    // 3. API Routes
    else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request);
    } 
    
    // 4. 404 Not Found
    else {
      return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
    }
  }
});

// --- [Part 3: API Logic] ---

/**
 * Route Dispatcher
 */
async function handleApi(request) {
  // Auth Check
  const authHeader = request.headers.get('Authorization');
  const apiKey = CONFIG.API_MASTER_KEY;

  if (apiKey && apiKey !== "1") {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return createErrorResponse('Missing or invalid Authorization header.', 401, 'unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== apiKey) {
      return createErrorResponse('Invalid API Key.', 403, 'invalid_api_key');
    }
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`Method not allowed for: ${url.pathname}`, 404, 'not_found');
  }
}

/**
 * GET /v1/models
 */
function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: Object.keys(CONFIG.MODEL_MAP).map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'teleprompt-bun',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

/**
 * POST /v1/chat/completions
 */
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    
    if (!lastMsg) {
      return createErrorResponse("User message not found (role: user)", 400, "invalid_request");
    }

    const prompt = lastMsg.content;
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const endpoint = CONFIG.MODEL_MAP[model] || CONFIG.MODEL_MAP[CONFIG.DEFAULT_MODEL];

    // 1. Construct Upstream Request
    // Generate random email identity
    const randomEmail = `${crypto.randomUUID()}@anonymous.user`;
    
    const upstreamPayload = { text: prompt };

    const headers = {
      "Content-Type": "application/json",
      "Accept": "*/*",
      "Origin": CONFIG.EXTENSION_ORIGIN,
      "User-Agent": CONFIG.USER_AGENT,
      "email": randomEmail, // Identity Injection
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "none"
    };

    // 2. Fetch from Upstream
    const response = await fetch(`${CONFIG.UPSTREAM_ORIGIN}${endpoint}`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upstream Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.success || !data.data) {
      throw new Error(`Upstream Business Error: ${JSON.stringify(data)}`);
    }

    const resultText = data.data;

    // 3. Handle Response (Stream vs Normal)
    if (body.stream) {
      return handleStreamResponse(resultText, model, requestId);
    } else {
      return handleNormalResponse(resultText, model, requestId);
    }

  } catch (e) {
    console.error(`[Error] ${e.message}`);
    return createErrorResponse(e.message, 500, 'generation_failed');
  }
}

/**
 * Normal JSON Response
 */
function handleNormalResponse(text, model, requestId) {
  return new Response(JSON.stringify({
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

/**
 * Pseudo-Streaming Response (Typewriter Effect)
 */
function handleStreamResponse(text, model, requestId) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
        const chunkSize = 2; 
        for (let i = 0; i < text.length; i += chunkSize) {
            const chunkContent = text.slice(i, i + chunkSize);
            const chunk = {
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{ index: 0, delta: { content: chunkContent }, finish_reason: null }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            await new Promise(r => setTimeout(r, CONFIG.STREAM_DELAY));
        }
        
        // End chunk
        const endChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
        console.error("Stream write error:", err);
    } finally {
        await writer.close();
    }
  })();

  return new Response(readable, {
    headers: corsHeaders({ 
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    })
  });
}

// --- Helpers ---
function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
