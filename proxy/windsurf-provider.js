/**
 * 9router Provider Adapter for Devin CLI (Cognition/Windsurf API)
 *
 * Mode B: Allows OTHER clients (Claude Code, OpenCode, curl) to use
 * Devin's GLM-5.2 model via 9router.
 *
 * Flow:
 *   Client → 9router /v1/chat/completions (model: "windsurf/glm-5-2")
 *   → 9router routes to this provider
 *   → This provider converts OpenAI → Connect+proto GetChatMessageRequest
 *   → Sends to server.codeium.com with Devin session token
 *   → Receives Connect+proto streaming response
 *   → Converts back → OpenAI SSE format
 *   → Streams back to client
 */

const { randomUUID } = require("crypto");
const https = require("https");
const path = require("path");
const protobuf = require("protobufjs");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const PROTO_PATH = path.join(__dirname, "..", "proto", "windsurf.proto");

let _root = null;
let _GetChatMessageRequest = null;
let _GetChatMessageResponse = null;

function loadProto() {
  if (_root) return;
  _root = protobuf.loadSync(PROTO_PATH);
  _GetChatMessageRequest = _root.lookupType("exa.api_server_pb.GetChatMessageRequest");
  _GetChatMessageResponse = _root.lookupType("exa.api_server_pb.GetChatMessageResponse");
}

// ─── Credential cache with auto-refresh ──────────────────────────────────────
let _cachedCredentials = null;
let _cachedAt = 0;
let _credFileMtime = 0;
const CRED_CACHE_TTL_MS = 30000; // Re-read at most every 30s
let _refreshInProgress = false;

/**
 * Find credentials.toml — checks both Devin CLI and Windsurf IDE paths.
 */
function findCredentialsFile() {
  const paths = [
    path.join(os.homedir(), ".local", "share", "devin", "credentials.toml"),
    path.join(os.homedir(), ".codeium", "windsurf", "credentials.toml"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Read Devin session token from credentials.toml.
 * Caches result but re-reads if:
 *   - Cache TTL expired (30s)
 *   - File modification time changed
 *   - force=true
 * Returns: { sessionToken, apiServerUrl, devinApiUrl, credPath }
 */
function readDevinCredentials(force = false) {
  const now = Date.now();
  const credPath = findCredentialsFile();
  if (!credPath) {
    throw new Error(
      "Devin credentials not found. Run 'devin auth login' to authenticate."
    );
  }

  // Check file modification time
  const stat = fs.statSync(credPath);
  const fileChanged = stat.mtimeMs !== _credFileMtime;
  const cacheExpired = now - _cachedAt > CRED_CACHE_TTL_MS;

  if (!force && _cachedCredentials && !fileChanged && !cacheExpired) {
    return _cachedCredentials;
  }

  const content = fs.readFileSync(credPath, "utf8");
  const tokenMatch = content.match(/windsurf_api_key\s*=\s*"([^"]+)"/);
  const serverMatch = content.match(/api_server_url\s*=\s*"([^"]+)"/);
  const devinMatch = content.match(/devin_api_url\s*=\s*"([^"]+)"/);
  if (!tokenMatch) throw new Error("No windsurf_api_key found in credentials.toml");

  _cachedCredentials = {
    sessionToken: tokenMatch[1],
    apiServerUrl: serverMatch ? serverMatch[1] : "https://server.codeium.com",
    devinApiUrl: devinMatch ? devinMatch[1] : "https://api.devin.ai",
    credPath,
  };
  _cachedAt = now;
  _credFileMtime = stat.mtimeMs;

  return _cachedCredentials;
}

/**
 * Try to refresh the Devin session token by running `devin auth status`.
 * This may trigger the Devin CLI to refresh the token and write it back to
 * credentials.toml. After calling this, re-read credentials.
 *
 * Returns true if the token changed, false otherwise.
 */
function tryRefreshDevinToken() {
  if (_refreshInProgress) return false;
  _refreshInProgress = true;

  try {
    const oldToken = _cachedCredentials?.sessionToken || "";

    // Run `devin auth status` — this may trigger a token refresh
    // Use a short timeout so we don't block too long
    try {
      execSync("devin auth status", {
        timeout: 10000,
        stdio: "pipe",
        env: { ...process.env },
      });
    } catch {
      // `devin auth status` may return non-zero if token is expired,
      // but it might still refresh the token file
    }

    // Force re-read credentials
    const newCreds = readDevinCredentials(true);
    const tokenChanged = newCreds.sessionToken !== oldToken;

    if (tokenChanged) {
      console.error("[windsurf-provider] Token refreshed successfully");
    } else {
      console.error("[windsurf-provider] Token unchanged after refresh attempt");
    }

    return tokenChanged;
  } catch (e) {
    console.error(`[windsurf-provider] Token refresh failed: ${e.message}`);
    return false;
  } finally {
    _refreshInProgress = false;
  }
}

// Watch credentials file for changes (Devin CLI may refresh it in background)
let _fileWatcher = null;
function startCredentialWatcher() {
  const credPath = findCredentialsFile();
  if (!credPath) return;

  try {
    _fileWatcher = fs.watch(credPath, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        // Debounce: wait a bit for the file to be fully written
        setTimeout(() => {
          try {
            readDevinCredentials(true);
            console.error("[windsurf-provider] Credentials file changed, re-read token");
          } catch (e) {
            // File might be temporarily empty during write
          }
        }, 500);
      }
    });
    _fileWatcher.on("error", () => {}); // Ignore watcher errors
  } catch {
    // fs.watch not available on all platforms
  }
}
startCredentialWatcher();

/**
 * Build a Connect-RPC request frame.
 * Format: [1 byte flags=0x00][4 bytes BE length][protobuf message]
 */
function buildConnectFrame(protoMessage) {
  const proto = _GetChatMessageRequest.encode(protoMessage).finish();
  const header = Buffer.alloc(5);
  header[0] = 0x00;
  header.writeUInt32BE(proto.length, 1);
  return Buffer.concat([header, proto]);
}

/**
 * Parse a Connect-RPC response stream into frames.
 * Returns array of { flags, isTrailer, data }
 */
function parseConnectFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 5 > buffer.length) break;
    const flags = buffer[offset];
    const msgLen = buffer.readUInt32BE(offset + 1);
    const isTrailer = Boolean(flags & 0x02);
    const data = buffer.subarray(offset + 5, offset + 5 + msgLen);
    frames.push({ flags, isTrailer, data });
    offset += 5 + msgLen;
  }
  return frames;
}

/**
 * Parse an OpenAI image_url object into Windsurf ImageData.
 * Supports:
 *   - data URI:  "data:image/png;base64,iVBOR..."
 *   - URL:       "https://example.com/img.png"  (fetched + base64-encoded)
 *   - object:    {url: "...", detail: "..."}
 */
function parseOpenAIImage(imageUrl) {
  const url = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
  if (!url) return null;

  let mime = "image/png";
  let base64 = "";

  if (url.startsWith("data:")) {
    // Parse data URI: data:image/png;base64,<data>
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      mime = m[1];
      base64 = m[2];
    } else {
      console.error("[windsurf] Invalid data URI");
      return null;
    }
  } else if (url.startsWith("http://") || url.startsWith("https://")) {
    // Fetch + encode — synchronous via child_process curl
    try {
      const { execSync } = require("child_process");
      const buf = execSync(`curl -sL --max-time 30 "${url.replace(/"/g, '\\"')}"`);
      // Detect mime from URL extension
      if (url.match(/\.jpe?g$/i)) mime = "image/jpeg";
      else if (url.match(/\.webp$/i)) mime = "image/webp";
      else if (url.match(/\.gif$/i)) mime = "image/gif";
      else if (url.match(/\.png$/i)) mime = "image/png";
      base64 = buf.toString("base64");
    } catch (e) {
      console.error(`[windsurf] Failed to fetch image ${url}: ${e.message}`);
      return null;
    }
  } else {
    console.error(`[windsurf] Unsupported image URL format`);
    return null;
  }

  if (!base64) return null;

  // Decode PNG/JPEG header for dimensions (best-effort)
  const dims = probeImageDimensions(Buffer.from(base64, "base64"));

  return {
    width: dims.width || 0,
    height: dims.height || 0,
    base64Data: base64,
    mimeType: mime,
    sourcePath: "",
  };
}

/**
 * Best-effort image dimension probe from buffer (PNG/JPEG/GIF/WebP).
 */
function probeImageDimensions(buf) {
  if (!buf || buf.length < 24) return { width: 0, height: 0 };
  // PNG: bytes 16-24 = width(4) + height(4) big-endian
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  // JPEG: scan for SOF0/SOF2 marker (0xFFC0/0xFFC2)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  // GIF: bytes 6-10 = width(2) + height(2) little-endian
  if (buf[0] === 0x47 && buf[1] === 0x49) {
    return {
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
    };
  }
  // WebP: RIFF....WEBP, dimensions depend on subformat
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
    const chunk = buf.slice(12, 16).toString();
    if (chunk === "VP8 ") {
      return { width: buf.readUInt16LE(26), height: buf.readUInt16LE(28) };
    }
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return { width: (buf.readUInt32LE(24) & 0xffffff) + 1, height: (buf.readUInt32LE(27) & 0xffffff) + 1 };
    }
  }
  return { width: 0, height: 0 };
}

/**
 * Convert OpenAI /v1/chat/completions request → GetChatMessageRequest protobuf.
 *
 * Note: session_id is client-generated metadata (NOT a server-registered session).
 * Devin CLI generates one UUID per conversation and reuses it for all messages
 * in that conversation. We use a stable UUID per provider instance to look like
 * a single long-running session — same pattern as Devin CLI.
 */
function openAIToWindsurf(openaiReq, credentials) {
  loadProto();

  let systemPrompt = "";
  const messages = [];
  const toolDefs = [];

  for (const msg of openaiReq.messages || []) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + (msg.content || "");
    } else {
      const m = {
        messageId: randomUUID(),
        role: msg.role === "assistant" ? 2 : 1,
        content: "",
        images: [],
      };

      // Parse content — string or array (OpenAI vision format)
      if (typeof msg.content === "string") {
        m.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // OpenAI vision: content is array of {type: "text"|"image_url", ...}
        for (const part of msg.content) {
          if (part.type === "text") {
            m.content += (m.content ? "\n" : "") + (part.text || "");
          } else if (part.type === "image_url") {
            const img = parseOpenAIImage(part.image_url);
            if (img) m.images.push(img);
          }
        }
      }

      messages.push(m);
    }
  }

  // Convert OpenAI tools to Windsurf tool definitions
  if (openaiReq.tools) {
    for (const tool of openaiReq.tools) {
      if (tool.type === "function" && tool.function) {
        toolDefs.push({
          name: tool.function.name,
          description: tool.function.description || "",
          jsonSchema: JSON.stringify(tool.function.parameters || { type: "object", properties: {} }),
        });
      }
    }
  }

  // Determine model name
  const modelName = openaiReq.model?.replace(/^windsurf\//, "") || "glm-5-2";
  const modelIndex = modelNameToIndex(modelName);

  // Build ClientInfo
  const clientInfo = {
    clientName: "chisel",
    clientVersion: "3000.1.27",
    apiKey: credentials.sessionToken,
    language: "en",
    platform: "mac",
    version: "3000.1.27",
    clientName2: "chisel",
    machineId: getStableMachineId(),
  };

  // Build GenerationConfig
  const genConfig = {
    flag: 1,
    maxTokens: openaiReq.max_tokens || 128000,
    budgetTokens: 400,
    temperature: openaiReq.temperature ?? 1.0,
    topK: 40,
    topP: openaiReq.top_p ?? 0.95,
  };

  const request = {
    clientInfo,
    systemPrompt,
    messages,
    modelIndex,
    generationConfig: genConfig,
    tools: toolDefs,
    sessionId: getStableSessionId(),
    chatFlag: 1,
    modelName,
    orgRequestId: randomUUID(),
  };

  return _GetChatMessageRequest.create(request);
}

/**
 * Stable session ID — generated once per process lifetime.
 * Looks like a single long-running Devin CLI session to the server.
 * (Devin CLI reuses one session_id for all messages in a conversation)
 */
let _cachedSessionId = null;
function getStableSessionId() {
  if (!_cachedSessionId) {
    _cachedSessionId = randomUUID();
  }
  return _cachedSessionId;
}

/**
 * Map model name to numeric index used by Devin API.
 */
function modelNameToIndex(name) {
  // Model indices from GetCliModelConfigs response (positional order)
  const map = {
    "claude-opus-4-8-medium": 0,
    "claude-5-fable-medium": 1,
    "claude-sonnet-5-medium": 2,
    "glm-5-2": 3,
    "glm-5.2": 3,
    "gpt-5-5-low": 4,
    "kimi-k2-7": 5,
    "kimi-k2.7": 5,
    "swe-1-7": 6,
    "swe-1-7-lightning": 7,
    "adaptive": 8,
    "swe-1-6-fast": 21,
  };
  return map[name] || 8; // default to adaptive
}

/**
 * Generate a stable machine ID (128-byte hex string).
 * Devin CLI generates this from hardware fingerprint — we hash
 * hostname+username to get a stable value that looks like a real install.
 * Random per-request would look suspicious to server-side fingerprinting.
 */
let _cachedMachineId = null;
function getStableMachineId() {
  if (_cachedMachineId) return _cachedMachineId;
  const crypto = require("crypto");
  const seed = `${os.hostname()}:${os.userInfo().username}:windsurf-provider`;
  // Generate 128 bytes deterministically from seed (256 hex chars)
  let result = "";
  let counter = 0;
  while (result.length < 256) {
    const h = crypto.createHash("sha512").update(seed + ":" + counter).digest("hex");
    result += h;
    counter++;
  }
  _cachedMachineId = result.substring(0, 256);
  return _cachedMachineId;
}

/**
 * Send GetChatMessage request to server.codeium.com and stream response.
 * Returns a readable stream (the HTTPS response).
 */
function sendWindsurfRequest(protoRequest, credentials) {
  loadProto();

  const frame = buildConnectFrame(protoRequest);
  const serverUrl = new URL(credentials.apiServerUrl);
  const hostname = serverUrl.hostname;

  const options = {
    hostname,
    port: 443,
    path: "/exa.api_server_pb.ApiServerService/GetChatMessage",
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Authorization": `Basic ${Buffer.from(credentials.sessionToken + ":" + credentials.sessionToken).toString("base64")}`,
      "Accept": "*/*",
      "Content-Length": frame.length.toString(),
      "Host": hostname,
    },
    servername: hostname,
    rejectUnauthorized: false,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = "";
        res.on("data", (c) => (errBody += c.toString()));
        res.on("end", () => {
          reject(new Error(`Windsurf API returned ${res.statusCode}: ${errBody.substring(0, 300)}`));
        });
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    req.write(frame);
    req.end();
  });
}

/**
 * Convert a Connect+proto response frame → OpenAI SSE chunk.
 */
function windsurfFrameToOpenAISSE(decoded, requestId, modelName) {
  const chunks = [];

  // Delta text (field 3)
  if (decoded.deltaText) {
    chunks.push({
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{
        index: 0,
        delta: { content: decoded.deltaText },
        finish_reason: null,
      }],
    });
  }

  // Stop reason (field 5 = 2 means stop)
  if (decoded.stopReason === 2) {
    const usage = decoded.metadata || {};
    chunks.push({
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop",
      }],
      usage: usage.inputTokens || usage.outputTokens ? {
        prompt_tokens: usage.inputTokens || 0,
        completion_tokens: usage.outputTokens || 0,
        total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
      } : undefined,
    });
  }

  return chunks;
}

/**
 * Main executor function.
 * Called by 9router when a request targets the "windsurf" provider.
 *
 * Credentials are auto-refreshed from credentials.toml (with file watcher).
 * On expired token errors, a clear error message is returned.
 *
 * @param {object} openaiReq - OpenAI /v1/chat/completions request body
 * @param {object} credentials - { sessionToken, apiServerUrl } (optional, auto-read if not provided)
 * @returns {object} { stream: ReadableStream, abort: Function }
 */
async function execute(openaiReq, credentials) {
  loadProto();

  // Use provided credentials or read from Devin CLI config (with cache + auto-refresh)
  if (!credentials) {
    credentials = readDevinCredentials();
  }

  // Convert OpenAI → Windsurf protobuf
  const protoRequest = openAIToWindsurf(openaiReq, credentials);
  const requestId = `chatcmpl-${randomUUID()}`;
  const modelName = openaiReq.model?.replace(/^windsurf\//, "") || "glm-5-2";

  // Send to Windsurf API
  const upstream = await sendWindsurfRequest(protoRequest, credentials);

  // Create a transform stream that converts Connect+proto → OpenAI SSE
  const { Transform } = require("stream");

  const transform = new Transform({
    objectMode: false,
    transform(chunk, encoding, callback) {
      // Accumulate data and parse Connect frames
      if (!this._buffer) this._buffer = Buffer.alloc(0);
      this._buffer = Buffer.concat([this._buffer, chunk]);

      // Try to parse complete frames
      while (this._buffer.length >= 5) {
        const msgLen = this._buffer.readUInt32BE(1);
        const frameLen = 5 + msgLen;
        if (this._buffer.length < frameLen) break; // incomplete frame

        const flags = this._buffer[0];
        const isTrailer = Boolean(flags & 0x02);
        const frameData = this._buffer.subarray(5, frameLen);
        this._buffer = this._buffer.subarray(frameLen);

        if (isTrailer) {
          // Trailer is JSON — check for errors
          try {
            const trailer = JSON.parse(frameData.toString());
            if (trailer.error) {
              const errMsg = trailer.error.message || "Unknown error";
              // Check if this is a session/token error that could be fixed by re-login
              const isSessionError = /cascade session|update your editor|internal error/i.test(errMsg);
              const hint = isSessionError
                ? "\n[Hint: Your Devin session may have expired. Run 'devin auth login' to refresh.]"
                : "";
              // Emit error as SSE
              const errChunk = {
                id: requestId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{
                  index: 0,
                  delta: { content: `\n[Error: ${errMsg}]${hint}` },
                  finish_reason: "stop",
                }],
              };
              this.push(`data: ${JSON.stringify(errChunk)}\n\n`);

              // Log session errors for debugging
              if (isSessionError) {
                console.error(`[windsurf-provider] Session error: ${errMsg}`);
                // Try to refresh token in background (non-blocking)
                tryRefreshDevinToken();
              }
            }
          } catch {}
          // Trailer means end of stream
          this.push("data: [DONE]\n\n");
          continue;
        }

        // Decode protobuf frame
        try {
          const decoded = _GetChatMessageResponse.decode(frameData);
          const sseChunks = windsurfFrameToOpenAISSE(decoded, requestId, modelName);
          for (const sse of sseChunks) {
            this.push(`data: ${JSON.stringify(sse)}\n\n`);
          }
        } catch (e) {
          // Skip unparseable frames
        }
      }
      callback();
    },
    flush(callback) {
      // Ensure [DONE] is sent if not already
      if (!this._doneSent) {
        this.push("data: [DONE]\n\n");
        this._doneSent = true;
      }
      callback();
    },
  });

  // Pipe upstream through transform
  upstream.pipe(transform);

  return {
    stream: transform,
    abort: () => {
      try { upstream.destroy(); } catch {}
    },
  };
}

/**
 * Non-streaming executor (collects all chunks, returns single response).
 */
async function executeNonStreaming(openaiReq, credentials) {
  const { stream } = await execute({ ...openaiReq, stream: false }, credentials);

  return new Promise((resolve, reject) => {
    let fullContent = "";
    let usage = null;
    let buffer = "";

    stream.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          if (chunk.choices?.[0]?.delta?.content) {
            fullContent += chunk.choices[0].delta.content;
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.choices?.[0]?.finish_reason === "stop" && !usage) {
            usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          }
        } catch {}
      }
    });

    stream.on("end", () => {
      resolve({
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: openaiReq.model?.replace(/^windsurf\//, "") || "glm-5-2",
        choices: [{
          index: 0,
          message: { role: "assistant", content: fullContent },
          finish_reason: "stop",
        }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    });

    stream.on("error", reject);
  });
}

module.exports = {
  execute,
  executeNonStreaming,
  readDevinCredentials,
  tryRefreshDevinToken,
  findCredentialsFile,
  openAIToWindsurf,
  windsurfFrameToOpenAISSE,
};
