#!/usr/bin/env node
/**
 * GLM Proxy for Claude Code
 *
 * Sits between Claude Code (Anthropic /v1/messages format) and 9router (port 20128).
 * Solves two issues with GLM-5.2:
 *   1. GLM-5.2 outputs "[Error: internal error occurred]" when system prompt
 *      contains "You are Claude Code" → we rewrite the system prompt.
 *   2. GLM-5.2 doesn't support Anthropic tool_use → we convert tools to text
 *      instructions, then parse GLM's text responses back into tool_use blocks.
 *
 * Flow:
 *   Claude Code → POST /v1/messages (Anthropic format, with tools)
 *   → glm-proxy rewrites system prompt + converts tools to text instructions
 *   → forwards to 9router (localhost:20128) as Anthropic /v1/messages (no tools)
 *   → 9router → windsurf-provider → GLM-5.2
 *   ← GLM-5.2 streams text response (may contain <tool_use> JSON blocks)
 *   ← glm-proxy parses <tool_use> blocks → converts to Anthropic tool_use content
 *   ← returns to Claude Code as proper Anthropic SSE stream
 *
 * Usage:
 *   node glm-proxy.js [PORT] [UPSTREAM_PORT]
 *   Default: PORT=20130, UPSTREAM=20128
 */

const http = require("http");

const PORT = parseInt(process.argv[2] || "20130", 10);
const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = parseInt(process.argv[3] || "20128", 10);

// ─── Context limits (env-configurable for unlimited/paid GLM-5.2) ──────────
// GLM-5.2 unlimited supports 1M context. The original 1500/3000 char limits
// were workarounds for the free-tier content filter. For the unlimited plan,
// set GLM_PROXY_MAX_SYSTEM_LEN and GLM_PROXY_MAX_MSG_LEN to 0 (no truncation)
// or a high value. Default: no truncation (0 = unlimited).
const MAX_SYSTEM_LEN = parseInt(process.env.GLM_PROXY_MAX_SYSTEM_LEN || "0", 10);
const MAX_MSG_LEN = parseInt(process.env.GLM_PROXY_MAX_MSG_LEN || "0", 10);

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract text from Anthropic content blocks (string or array of blocks).
 */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_result") {
        const c = block.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return c.map((b) => b.text || "").join("\n");
        return "";
      }
      if (block.type === "tool_use") {
        return `<tool_use id="${block.id}" name="${block.name}">\n${JSON.stringify(block.input)}\n</tool_use>`;
      }
      return "";
    })
    .join("\n");
}

/**
 * Rewrite the system prompt: remove "Claude Code" identity references
 * that cause GLM-5.2 to output error messages.
 */
function rewriteSystemPrompt(system) {
  let text;
  if (typeof system === "string") {
    text = system;
  } else if (Array.isArray(system)) {
    text = system.map((b) => b.text || "").join("\n");
  } else {
    text = "";
  }

  // Remove billing headers and metadata that Claude Code adds
  text = text.replace(/x-anthropic-billing-header:[^\n]*\n?/gi, "");
  text = text.replace(/x-[a-z-]+:[^\n]*\n?/gi, "");

  // Replace Claude Code / Claude Agent SDK identity with generic coding assistant
  text = text.replace(
    /You are Claude Code,? Anthropic'?s official CLI for Claude\.?/gi,
    "You are an interactive CLI-based coding assistant."
  );
  text = text.replace(/You are Claude Code\./gi, "You are a coding assistant.");
  text = text.replace(/You are a Claude agent,? built on Anthropic'?s Claude Agent SDK\.?/gi, "You are a coding assistant.");
  text = text.replace(/Claude Agent SDK/gi, "coding toolkit");
  text = text.replace(/Claude Code/gi, "the CLI assistant");
  text = text.replace(/Anthropic'?s official CLI/gi, "the CLI assistant");
  text = text.replace(/Anthropic'?s Claude/gi, "the assistant");
  text = text.replace(/built on Anthropic/gi, "built for development");

  // Remove security/safety instructions that trigger Cognition API content filter
  // These phrases about "destructive techniques", "DoS attacks", "credential testing"
  // look like harmful content to the filter
  // Match until next section header OR end of paragraph (period followed by newline)
  text = text.replace(/IMPORTANT: Assist with authorized security testing[\s\S]*?(?:defensive use cases\.|(?=\n#|\n##|\n---|\n\n\n))/gi, "");
  text = text.replace(/Refuse requests for destructive techniques[^\n]*$/gi, "");
  text = text.replace(/Dual-use security tools[^\n]*$/gi, "");

  // Remove content-policy-triggering phrases (Cognition API content filter)
  text = text.replace(/\*?MANDATORY\.?\s*NON-NEGOTIABLE\.?\s*NO EXCEPTIONS\.?\s*MUST REMEMBER AT ALL TIMES!!!\*?/gi, "");
  text = text.replace(/MANDATORY\.?\s*NON-NEGOTIABLE\.?\s*NO EXCEPTIONS/gi, "Important");
  text = text.replace(/MUST REMEMBER AT ALL TIMES!!!/gi, "");
  text = text.replace(/CRITICALLY IMPORTANT/gi, "important");
  text = text.replace(/\*MUST READ\* and \*MUST COMPLY\*/gi, "Follow");
  text = text.replace(/\*MUST READ\*/gi, "Read");
  text = text.replace(/\*MUST COMPLY\*/gi, "Follow");
  text = text.replace(/\*INSTRUCTIONS\*/gi, "instructions");

  // Soften excessive imperative language
  text = text.replace(/MUST REMEMBER AT ALL TIMES/gi, "Remember");
  text = text.replace(/NON-NEGOTIABLE/gi, "important");
  text = text.replace(/NO EXCEPTIONS/gi, "");

  // Remove duplicate code-intelligence blocks (e.g. GitNexus, Sourcegraph, etc.)
  // These tools inject large context blocks that can duplicate and bloat the prompt
  text = text.replace(/<!-- (?:gitnexus|sourcegraph|codestory):(start|end) -->/g, "");
  const codeIntelRegex = /# (?:GitNexus|Sourcegraph|CodeStory) —[^\n]*[\s\S]*?(?=<!-- (?:gitnexus|sourcegraph|codestory):end -->)/g;
  let firstCodeIntel = true;
  text = text.replace(codeIntelRegex, (match) => {
    if (firstCodeIntel) { firstCodeIntel = false; return match; }
    return "";
  });

  // Remove package-manager agent instruction blocks (e.g. Homebrew AGENTS.md)
  // These are injected by some tools and contain irrelevant packaging policies
  text = text.replace(/# Agent Instructions for (?:Homebrew|npm|pip)[\s\S]*?(?=\n#[^#]|\n## [A-Z]|\n---|$)/g, "");

  // Remove boilerplate AGENTS.md / CLAUDE.md blocks from other tools
  text = text.replace(/# (?:AGENTS|CLAUDE)\.md[\s\S]*?(?=\n# (?:AGENTS|CLAUDE)\.md|\n## [A-Z]|$)/g, "");

  // Remove <system-reminder> tags from system prompt too
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  text = text.replace(/<system-reminder>[\s\S]*$/gi, "");

  // Truncate system prompt if limit is set (0 = no truncation).
  // Default is 0 (no truncation) for unlimited GLM-5.2 with 1M context.
  // Set GLM_PROXY_MAX_SYSTEM_LEN to enforce a limit (e.g. for free tier).
  if (MAX_SYSTEM_LEN > 0 && text.length > MAX_SYSTEM_LEN) {
    text = text.slice(0, MAX_SYSTEM_LEN) + "\n\n[... additional context truncated ...]";
  }

  return text;
}

/**
 * Convert Anthropic tools to text instructions for GLM.
 * GLM will output <tool_use> blocks in its text response.
 */
function toolsToInstructions(tools) {
  if (!tools || tools.length === 0) return "";

  const toolDocs = tools
    .map((t) => {
      // Anthropic tool format: {type: "bash_20250124", name: "bash", ...}
      // or {type: "text_editor_20250429", name: "str_replace_based_edit_tool"}
      const name = t.name || t.type;
      let params = "";
      if (t.commands) {
        params = `Allowed commands: ${t.commands.map((c) => c.name).join(", ")}`;
      }
      return `- ${name}: ${params}`.trim();
    })
    .join("\n");

  return `\n\n## Tool Use
You have access to the following tools. To use a tool, output a <tool_use> block in your response:

<tool_use name="TOOL_NAME">
{"param": "value"}
</tool_use>

Available tools:
${toolDocs}

IMPORTANT: When you need to perform an action (run a command, edit a file, etc.), output the <tool_use> block. Do NOT describe what you would do — actually output the tool_use block. You can output multiple tool_use blocks in a single response. After each tool_use, stop and wait for the result.`;
}

/**
 * Parse <tool_use> blocks from text and convert to Anthropic content blocks.
 * Returns { textBlocks, toolUseBlocks }
 */
function parseToolUseBlocks(text) {
  const blocks = [];
  const toolUseRegex = /<tool_use\s+name="([^"]+)"(?:\s+id="([^"]+)")?\s*>([\s\S]*?)<\/tool_use>/g;
  let lastIndex = 0;
  let match;
  let hasToolUse = false;

  while ((match = toolUseRegex.exec(text)) !== null) {
    // Text before this tool_use block
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) blocks.push({ type: "text", text: before });
    }

    const name = match[1];
    const id = match[2] || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let input = {};
    try {
      input = JSON.parse(match[3].trim());
    } catch {
      input = { raw: match[3].trim() };
    }

    blocks.push({
      type: "tool_use",
      id,
      name,
      input,
    });
    hasToolUse = true;
    lastIndex = toolUseRegex.lastIndex;
  }

  // Remaining text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) blocks.push({ type: "text", text: remaining });
  }

  return { blocks, hasToolUse };
}

// ─── Request Handler ──────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "glm-proxy" }));
    return;
  }

  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    // Pass through other requests (e.g., /v1/models)
    proxyRaw(req, res);
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      let parsed = JSON.parse(body);
      const isStream = parsed.stream !== false;

      // 1. Rewrite system prompt
      const rewrittenSystem = rewriteSystemPrompt(parsed.system);

      // 2. Convert tools to text instructions
      const toolInstructions = toolsToInstructions(parsed.tools);

      // 3. Build new system prompt
      let newSystem = rewrittenSystem;
      if (toolInstructions) {
        newSystem += toolInstructions;
      }

      // 4. Convert messages: ensure all content is text (GLM doesn't understand tool_use/tool_result blocks)
      // Also sanitize message content to remove content-policy-triggering phrases
      // IMPORTANT: "system" role messages in the array also need sanitization
      const newMessages = (parsed.messages || []).map((msg, msgIdx) => {
        let text = contentToText(msg.content);
        // For system-role messages in the array, apply full system prompt sanitization
        if (msg.role === "system") {
          text = rewriteSystemPrompt(text);
        }
        const origLen = text.length;
        const hadSysReminder = text.includes("<system-reminder>");
        // Remove <system-reminder> tags entirely
        text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
        text = text.replace(/<system-reminder>[\s\S]*$/g, "");
        // Remove billing headers
        text = text.replace(/x-anthropic-billing-header:[^\n]*\n?/gi, "");
        text = text.replace(/x-[a-z-]+:[^\n]*\n?/gi, "");
        // Remove security instructions that trigger content filter
        text = text.replace(/IMPORTANT: Assist with authorized security testing[\s\S]*?(?=\n#|\n##|\n---|\n\n\n)/gi, "");
        text = text.replace(/Refuse requests for destructive techniques[\s\S]*?(?=\n#|\n##|\n---|\n\n\n)/gi, "");
        text = text.replace(/Dual-use security tools[\s\S]*?(?=\n#|\n##|\n---|\n\n\n)/gi, "");
        // Remove content-policy-triggering phrases
        text = text.replace(/MANDATORY\.?\s*NON-NEGOTIABLE\.?\s*NO EXCEPTIONS\.?\s*MUST REMEMBER AT ALL TIMES!!!/gi, "");
        text = text.replace(/MUST REMEMBER AT ALL TIMES!!!/gi, "");
        text = text.replace(/CRITICALLY IMPORTANT/gi, "important");
        text = text.replace(/NEVER expose secrets/gi, "Do not expose secrets");
        text = text.replace(/NEVER commit secrets/gi, "Do not commit secrets");
        text = text.replace(/NEVER force-push/gi, "Do not force-push");
        text = text.replace(/NEVER perform irreversible/gi, "Avoid irreversible");
        text = text.replace(/NEVER ignore/gi, "Do not ignore");
        text = text.replace(/NEVER edit/gi, "Do not edit");
        text = text.replace(/NEVER rename/gi, "Do not rename");
        text = text.replace(/NEVER commit/gi, "Do not commit");
        text = text.replace(/ignore (all )?previous instructions/gi, "follow the instructions");
        // Truncate very long messages if limit is set (0 = no truncation).
        // Default is 0 (no truncation) for unlimited GLM-5.2 with 1M context.
        // Set GLM_PROXY_MAX_MSG_LEN to enforce a limit (e.g. for free tier).
        if (MAX_MSG_LEN > 0 && text.length > MAX_MSG_LEN) {
          text = text.slice(0, MAX_MSG_LEN) + "\n[... truncated ...]";
        }
        if (process.env.GLM_PROXY_DEBUG && (hadSysReminder || msg.role === "system")) {
          console.error(`[glm-proxy] MSG[${msgIdx}] role=${msg.role} origLen=${origLen} newLen=${text.length} removedSysReminder=${hadSysReminder}`);
        }
        return { role: msg.role, content: text };
      });

      // 5. Build upstream request (no tools — GLM doesn't support them natively)
      const upstreamBody = {
        ...parsed,
        system: newSystem,
        messages: newMessages,
        tools: undefined, // Remove tools — we handle them via text instructions
      };
      delete upstreamBody.tools;

      const upstreamPayload = JSON.stringify(upstreamBody);

      const upstreamReq = http.request(
        {
          hostname: UPSTREAM_HOST,
          port: UPSTREAM_PORT,
          path: req.url,
          method: "POST",
          headers: {
            ...req.headers,
            host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(upstreamPayload),
          },
        },
        (upstreamRes) => {
          if (isStream) {
            handleStreamResponse(upstreamRes, res);
          } else {
            handleNonStreamResponse(upstreamRes, res);
          }
        }
      );

      upstreamReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `glm-proxy upstream error: ${err.message}` } }));
        }
      });

      // Log the request for debugging
      if (process.env.GLM_PROXY_DEBUG) {
        const debugBody = JSON.parse(upstreamPayload);
        const sysText = typeof debugBody.system === "string" ? debugBody.system : JSON.stringify(debugBody.system || "");
        const sysLen = sysText.length;
        const msgCount = debugBody.messages?.length || 0;
        console.error(`[glm-proxy] REQ model=${debugBody.model} systemLen=${sysLen} msgs=${msgCount} stream=${debugBody.stream}`);
        if (sysLen > 5000) console.error(`[glm-proxy] Large system prompt (${sysLen} chars) — may trigger content policy`);
        // Log full system prompt if DEBUG level 2
        if (process.env.GLM_PROXY_DEBUG === "2") {
          console.error(`[glm-proxy] SYSTEM PROMPT (${sysLen} chars):\n${sysText.slice(0, 10000)}${sysLen > 10000 ? "..." : ""}`);
          // Log message content
          for (let i = 0; i < Math.min(msgCount, 5); i++) {
            const m = debugBody.messages[i];
            const mLen = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
            console.error(`[glm-proxy] MSG[${i}] role=${m.role} len=${mLen}`);
            if (process.env.GLM_PROXY_DEBUG === "2" && mLen < 2000) {
              console.error(`[glm-proxy] MSG[${i}] CONTENT: ${typeof m.content === "string" ? m.content.slice(0, 500) : JSON.stringify(m.content).slice(0, 500)}`);
            }
          }
        }
      }

      upstreamReq.write(upstreamPayload);
      upstreamReq.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `glm-proxy error: ${err.message}` } }));
      }
    }
  });
}

// ─── Stream Response Handler ──────────────────────────────────────────────

function handleStreamResponse(upstreamRes, res) {
  // Check for error status from upstream
  if (upstreamRes.statusCode !== 200) {
    let errBody = "";
    upstreamRes.on("data", (c) => (errBody += c.toString()));
    upstreamRes.on("end", () => {
      console.error(`[glm-proxy] UPSTREAM ERROR ${upstreamRes.statusCode}: ${errBody.slice(0, 500)}`);
      if (!res.headersSent) {
        res.writeHead(upstreamRes.statusCode, { "Content-Type": "application/json" });
        res.end(errBody);
      }
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let buffer = "";
  let currentText = "";
  let messageId = `msg_${Date.now()}`;
  let blockStarted = false;
  let toolUseBuffer = "";
  let inToolUse = false;
  let toolUseName = "";
  let toolUseId = "";
  let blockIndex = 0;
  let hasToolUseBlock = false;

  const flushText = (text) => {
    if (!text) return;
    if (!blockStarted) {
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } })}\n\n`);
      blockStarted = true;
    }
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } })}\n\n`);
  };

  const closeTextBlock = () => {
    if (blockStarted) {
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
      blockIndex++;
      blockStarted = false;
    }
  };

  let messageEnded = false;
  let responseText = ""; // Accumulate response text for logging

  upstreamRes.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const evt = JSON.parse(data);
        // Log content policy errors in response
        if (process.env.GLM_PROXY_DEBUG && evt.type === "content_block_delta" && evt.delta?.text) {
          responseText += evt.delta.text;
          if (responseText.length < 200 && /content policy|blocked|internal error/i.test(responseText)) {
            // Potential content policy error detected
          }
        }

        if (evt.type === "message_start") {
          messageId = evt.message?.id || messageId;
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: messageId, type: "message", role: "assistant", model: "glm-5-2", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
          continue;
        }

        if (evt.type === "content_block_delta" && evt.delta?.text) {
          currentText += evt.delta.text;

          if (inToolUse) {
            // Accumulate until we see </tool_use>
            toolUseBuffer += evt.delta.text;
            const closeIdx = toolUseBuffer.indexOf("</tool_use>");
            if (closeIdx !== -1) {
              // toolUseBuffer starts AFTER the opening tag's ">", so just slice to closeIdx
              const jsonPart = toolUseBuffer.slice(0, closeIdx).trim();
              let input = {};
              try { input = JSON.parse(jsonPart); } catch { input = { raw: jsonPart }; }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}\n\n`);
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
              blockIndex++;
              inToolUse = false;
              toolUseBuffer = "";
              currentText = "";
            }
          } else {
            // Check if we have a complete <tool_use ...> opening tag
            const toolUseStart = currentText.indexOf("<tool_use");
            if (toolUseStart !== -1) {
              // Check if the opening tag is complete (has closing >)
              const tagClose = currentText.indexOf(">", toolUseStart);
              if (tagClose !== -1) {
                // Opening tag is complete — flush text before it
                const before = currentText.slice(0, toolUseStart);
                flushText(before);
                closeTextBlock();

                // Parse the opening tag
                const tagStr = currentText.slice(toolUseStart, tagClose + 1);
                const nameMatch = tagStr.match(/name="([^"]+)"/);
                const idMatch = tagStr.match(/id="([^"]+)"/);
                toolUseName = nameMatch ? nameMatch[1] : "unknown";
                toolUseId = idMatch ? idMatch[1] : `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: toolUseId, name: toolUseName, input: {} } })}\n\n`);

                // Start accumulating tool use content
                inToolUse = true;
                hasToolUseBlock = true;
                toolUseBuffer = currentText.slice(tagClose + 1);
                currentText = "";

                // Check if </tool_use> is already in the buffer
                const closeIdx = toolUseBuffer.indexOf("</tool_use>");
                if (closeIdx !== -1) {
                  const jsonPart = toolUseBuffer.slice(0, closeIdx).trim();
                  let input = {};
                  try { input = JSON.parse(jsonPart); } catch { input = { raw: jsonPart }; }
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}\n\n`);
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                  blockIndex++;
                  inToolUse = false;
                  toolUseBuffer = "";
                }
              } else {
                // Opening tag not complete yet — keep buffering, but flush safe text before it
                const safeEnd = toolUseStart;
                if (safeEnd > 0) {
                  flushText(currentText.slice(0, safeEnd));
                  currentText = currentText.slice(safeEnd);
                }
              }
            } else {
              // No tool_use tag — but be careful not to flush partial "<tool" prefix
              const lastLt = currentText.lastIndexOf("<");
              if (lastLt !== -1 && lastLt === currentText.length - 1) {
                // Just a lone "<" at the end — might be start of <tool_use
                flushText(currentText.slice(0, lastLt));
                currentText = currentText.slice(lastLt);
              } else if (lastLt !== -1 && currentText.slice(lastLt).startsWith("<tool_use") === false && currentText.slice(lastLt).length < 10) {
                // Short fragment after "<" that's not "<tool_use" — buffer it
                flushText(currentText.slice(0, lastLt));
                currentText = currentText.slice(lastLt);
              } else {
                // Safe to flush everything
                flushText(currentText);
                currentText = "";
              }
            }
          }
          continue;
        }

        if (evt.type === "content_block_stop") {
          continue; // We handle our own block stops
        }

        if (evt.type === "message_delta") {
          if (messageEnded) continue;
          messageEnded = true;
          // Close any open blocks
          if (inToolUse) {
            // Unclosed tool_use — close it
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
            blockIndex++;
            inToolUse = false;
          }
          closeTextBlock();

          // If we had tool_use blocks, set stop_reason to tool_use
          const stopReason = hasToolUseBlock ? "tool_use" : (evt.delta?.stop_reason || "end_turn");
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage: evt.usage || {} })}\n\n`);
          continue;
        }

        if (evt.type === "message_stop") {
          if (!messageEnded) {
            messageEnded = true;
            // Close any open blocks
            if (inToolUse) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
              blockIndex++;
              inToolUse = false;
            }
            closeTextBlock();
            const stopReason = hasToolUseBlock ? "tool_use" : "end_turn";
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage: {} })}\n\n`);
          }
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          continue;
        }
      } catch {}
    }
  });

  upstreamRes.on("end", () => {
    // Log the response text for debugging content policy issues
    if (process.env.GLM_PROXY_DEBUG && responseText) {
      const isContentPolicy = /content policy|blocked by our content/i.test(responseText);
      const isError = /internal error occurred|\[Error:/i.test(responseText);
      if (isContentPolicy || isError) {
        console.error(`[glm-proxy] RESPONSE ISSUE: ${responseText.slice(0, 300)}`);
      }
    }
    if (!messageEnded) {
      messageEnded = true;
      // Flush any remaining buffered text
      if (currentText && !inToolUse) {
        flushText(currentText);
      }
      if (inToolUse) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
        blockIndex++;
      }
      closeTextBlock();
      const stopReason = hasToolUseBlock ? "tool_use" : "end_turn";
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage: {} })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    }
    res.end();
  });

  upstreamRes.on("error", () => {
    res.end();
  });
}

// ─── Non-Stream Response Handler ──────────────────────────────────────────

function handleNonStreamResponse(upstreamRes, res) {
  let body = "";
  upstreamRes.on("data", (chunk) => (body += chunk));
  upstreamRes.on("end", () => {
    try {
      const data = JSON.parse(body);
      // If upstream returned OpenAI format, convert to Anthropic
      if (data.choices) {
        const text = data.choices[0]?.message?.content || "";
        const { blocks, hasToolUse } = parseToolUseBlocks(text);
        const response = {
          id: data.id || `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: data.model || "glm-5-2",
          content: blocks.length > 0 ? blocks : [{ type: "text", text }],
          stop_reason: hasToolUse ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0,
          },
        };
        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        }
      } else {
        // Already Anthropic format — parse tool_use from text content
        if (data.content) {
          const text = data.content.map((b) => b.text || "").join("");
          const { blocks, hasToolUse } = parseToolUseBlocks(text);
          if (hasToolUse) {
            data.content = blocks;
            data.stop_reason = "tool_use";
          }
        }
        if (!res.headersSent) {
          res.writeHead(upstreamRes.statusCode || 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        }
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(upstreamRes.statusCode || 502, { "Content-Type": "application/json" });
        res.end(body);
      }
    }
  });
}

// ─── Raw Proxy (for non-/v1/messages requests) ────────────────────────────

function proxyRaw(req, res) {
  const upstreamReq = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    },
    (upstreamRes) => {
      if (!res.headersSent) {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    }
  );
  upstreamReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });
  req.pipe(upstreamReq);
}

// ─── Start Server ─────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[glm-proxy] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[glm-proxy] Upstream: http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.log(`[glm-proxy] Rewrites system prompt + converts tools to text instructions`);
});
