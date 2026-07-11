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
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Check if an origin is a localhost origin (http://127.0.0.1 or http://localhost, any port).
 */
function isLocalhostOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

// Available models (verified via live GetCliModelConfigs API call 2026-07-11)
// All 4 models are promo free (tier 4/2, isPremium=1) with Devin Pro (Windsurf)
// All share the same ModelFeatures (feature_8=1, feature_12=1, feature_15=1, feature_24=1)
// which includes vision support (supports_image_captions in binary)
const MODELS = [
  {
    id: "glm-5-2",
    name: "GLM-5.2 High",
    description: "Cognition GLM-5.2 High (promo free, vision)",
    context_window: 128000,
    max_tokens: 200000,
    vision: true,
  },
  {
    id: "swe-1-7",
    name: "SWE-1.7",
    description: "Cognition SWE-1.7 coding model (promo free, vision)",
    context_window: 128000,
    max_tokens: 262000,
    vision: true,
  },
  {
    id: "swe-1-7-lightning",
    name: "SWE-1.7 Lightning",
    description: "Cognition SWE-1.7 Lightning (promo free, vision)",
    context_window: 96000,
    max_tokens: 202752,
    vision: true,
  },
  {
    id: "kimi-k2-7",
    name: "Kimi K2.7",
    description: "Moonshot Kimi K2.7 (promo free, vision)",
    context_window: 16000,
    max_tokens: 262144,
    vision: true,
  },
];

/**
 * Parse JSON body from request.
 */
function parseBody(req, res) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return; // stop accumulating once exceeded
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        body = ""; // release memory
        if (res && !res.headersSent) {
          const headers = { "Content-Type": "application/json" };
          if (isLocalhostOrigin(req.headers.origin)) {
            headers["Access-Control-Allow-Origin"] = req.headers.origin;
          }
          res.writeHead(413, headers);
          res.end(JSON.stringify({ error: { message: "Request body too large (max 10MB)", type: "invalid_request_error" } }));
        }
        req.destroy();
        reject(new Error("Request body too large (max 10MB)"));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
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
function sendJSON(res, status, data, req) {
  const json = JSON.stringify(data);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  const origin = req && req.headers && req.headers.origin;
  if (isLocalhostOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  res.writeHead(status, headers);
  res.end(json);
}

/**
 * Send SSE stream.
 */
function sendSSEStream(res, stream, req) {
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };
  const origin = req && req.headers && req.headers.origin;
  if (isLocalhostOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  res.writeHead(200, headers);
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
    if (!isLocalhostOrigin(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "CORS not allowed for this origin", type: "invalid_request_error" } }));
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin,
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
    }, req);
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
    }, req);
  }

  // Chat completions
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body;
    try {
      body = await parseBody(req, res);
    } catch (e) {
      if (res.headersSent) return; // 413 already sent by parseBody
      return sendJSON(res, 400, { error: { message: e.message, type: "invalid_request_error" } }, req);
    }

    // Validate
    if (!body.messages || !Array.isArray(body.messages)) {
      return sendJSON(res, 400, {
        error: { message: "messages is required and must be an array", type: "invalid_request_error" },
      }, req);
    }

    if (!body.model || typeof body.model !== "string") {
      return sendJSON(res, 400, { error: { message: "model must be a non-empty string", type: "invalid_request_error" } }, req);
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

    const isStream = body.stream === true;

    console.log(`[${new Date().toISOString()}] ${isStream ? "STREAM" : "NON-STREAM"} model=${modelId} msgs=${body.messages.length}`);

    try {
      if (isStream) {
        const { stream } = await windsurf.execute(body);
        return sendSSEStream(res, stream, req);
      } else {
        const result = await windsurf.executeNonStreaming(body);
        return sendJSON(res, 200, result, req);
      }
    } catch (e) {
      console.error(`[windsurf-server] Error: ${e.message}`);
      const status = /timeout/i.test(e.message) ? 504 : 502;
      return sendJSON(res, status, {
        error: {
          message: e.message,
          type: /timeout/i.test(e.message) ? "timeout_error" : "upstream_error",
          code: "windsurf_api_error",
        },
      }, req);
    }
  }

  // 404
  sendJSON(res, 404, { error: { message: `Not found: ${req.url}`, type: "invalid_request_error" } }, req);
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
