/**
 * Windsurf Provider Server — Standalone OpenAI-compatible proxy
 *
 * Exposes Devin's GLM-5.2 (and other Cognition models) as an OpenAI-compatible
 * API server. Run this alongside 9router, then add it as a custom provider
 * in 9router UI (OpenAI-compatible, baseUrl: http://127.0.0.1:8083/v1)
 *
 * Endpoints:
 *   GET  /v1/models              — list available models
 *   POST /v1/chat/completions    — chat completion (streaming + non-streaming)
 *   GET  /health                 — health check
 *
 * Usage:
 *   node windsurf-server.js [port]
 *   node windsurf-server.js 8083
 *
 * Then in 9router UI:
 *   Settings → Providers → Add Custom Provider
 *   Type: OpenAI-compatible
 *   Base URL: http://127.0.0.1:8083/v1
 *   API Key: devin (any value, auth is via Devin session token)
 */

const http = require("http");
const { randomUUID } = require("crypto");
const windsurf = require("./windsurf-provider.js");

const PORT = parseInt(process.argv[2] || "8083", 10);

// Available models (from captured GetCliModelConfigs)
const MODELS = [
  {
    id: "glm-5-2",
    name: "GLM-5.2 High",
    description: "Cognition GLM-5.2 High (via Devin CLI quota)",
    context_window: 128000,
    max_tokens: 200000,
  },
  {
    id: "swe-1-7",
    name: "SWE-1.7",
    description: "Cognition SWE-1.7 coding model with vision (promo free)",
    context_window: 128000,
    max_tokens: 262000,
    vision: true,
  },
  {
    id: "swe-1-7-lightning",
    name: "SWE-1.7 Lightning",
    description: "Cognition SWE-1.7 Lightning with vision (promo free)",
    context_window: 96000,
    max_tokens: 202752,
    vision: true,
  },
  {
    id: "kimi-k2-7",
    name: "Kimi K2.7",
    description: "Moonshot Kimi K2.7 (via Devin CLI quota, no vision)",
    context_window: 16000,
    max_tokens: 262144,
    vision: false,
  },
];

/**
 * Parse JSON body from request.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send JSON response.
 */
function sendJSON(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(json);
}

/**
 * Send SSE stream.
 */
function sendSSEStream(res, stream) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  stream.on("data", (chunk) => res.write(chunk));
  stream.on("end", () => res.end());
  stream.on("error", (e) => {
    console.error(`[windsurf-server] Stream error: ${e.message}`);
    try {
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {}
  });
}

// Create server
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  // Health check
  if (req.url === "/health" || req.url === "/") {
    return sendJSON(res, 200, {
      status: "ok",
      service: "windsurf-provider",
      models: MODELS.length,
    });
  }

  // List models
  if (req.url === "/v1/models" && req.method === "GET") {
    return sendJSON(res, 200, {
      object: "list",
      data: MODELS.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "cognition",
        ...m,
      })),
    });
  }

  // Chat completions
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      return sendJSON(res, 400, { error: { message: e.message, type: "invalid_request_error" } });
    }

    // Validate
    if (!body.messages || !Array.isArray(body.messages)) {
      return sendJSON(res, 400, {
        error: { message: "messages is required and must be an array", type: "invalid_request_error" },
      });
    }

    // Normalize model name (strip prefix)
    const modelId = (body.model || "glm-5-2").replace(/^windsurf\//, "");
    body.model = modelId;

    // Log request for debugging
    const msgSummary = (body.messages || []).map(m => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return `${m.role}:${c.substring(0, 80)}`;
    }).join(" | ");
    console.log(`[windsurf-server] ${new Date().toISOString()} model=${modelId} msgs=${body.messages?.length} [${msgSummary.substring(0, 200)}]`);

    // Check model is available
    if (!MODELS.find((m) => m.id === modelId)) {
      console.log(`[windsurf-server] Model "${modelId}" not in predefined list, attempting anyway...`);
    }

    const isStream = body.stream !== false;

    console.log(`[${new Date().toISOString()}] ${isStream ? "STREAM" : "NON-STREAM"} model=${modelId} msgs=${body.messages.length}`);

    try {
      if (isStream) {
        const { stream } = await windsurf.execute(body);
        return sendSSEStream(res, stream);
      } else {
        const result = await windsurf.executeNonStreaming(body);
        return sendJSON(res, 200, result);
      }
    } catch (e) {
      console.error(`[windsurf-server] Error: ${e.message}`);
      return sendJSON(res, 502, {
        error: {
          message: e.message,
          type: "upstream_error",
          code: "windsurf_api_error",
        },
      });
    }
  }

  // 404
  sendJSON(res, 404, { error: { message: `Not found: ${req.url}`, type: "invalid_request_error" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🚀 Windsurf Provider Server`);
  console.log(`   Listening:  http://127.0.0.1:${PORT}`);
  console.log(`   Models:     ${MODELS.map((m) => m.id).join(", ")}`);
  console.log(`   Endpoints:`);
  console.log(`     GET  /v1/models`);
  console.log(`     POST /v1/chat/completions`);
  console.log(`     GET  /health`);
  console.log(`\n   Add to 9router as custom provider:`);
  console.log(`     Base URL: http://127.0.0.1:${PORT}/v1`);
  console.log(`     API Key:  devin (placeholder)`);
  console.log();
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use. Try a different port: node windsurf-server.js ${PORT + 1}`);
  } else {
    console.error(`Server error: ${e.message}`);
  }
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\n Shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("\n Shutting down...");
  server.close(() => process.exit(0));
});
