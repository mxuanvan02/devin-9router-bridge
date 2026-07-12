#!/usr/bin/env node
/**
 * Check Windsurf/Devin message rate limit by calling
 * CheckUserMessageRateLimit RPC on server.codeium.com.
 *
 * Usage: node scripts/check-rate-limit.js
 *
 * Output: prints rate limit info (remaining, max, reset time, etc.)
 */

const https = require("https");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const protobuf = require("protobufjs");

const PROTO_PATH = path.join(__dirname, "..", "proto", "windsurf.proto");

// ─── Proto loading ──────────────────────────────────────────────────────────

let _root = null;
let _CheckRateLimitRequest = null;
let _CheckRateLimitResponse = null;

function loadProto() {
  if (_root) return;
  _root = protobuf.loadSync(PROTO_PATH);
  _CheckRateLimitRequest = _root.lookupType("exa.api_server_pb.CheckRateLimitRequest");
  _CheckRateLimitResponse = _root.lookupType("exa.api_server_pb.CheckRateLimitResponse");
}

// ─── Credentials ────────────────────────────────────────────────────────────

function findCredentialsFile() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "share", "devin", "credentials.toml"),
    path.join(home, ".local", "share", "devin", "cli", "credentials.toml"),
    path.join(home, ".codeium", "windsurf", "credentials.toml"),
    path.join(home, ".config", "devin", "cli", "credentials.toml"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readCredentials() {
  const credPath = findCredentialsFile();
  if (!credPath) {
    console.error("Error: Devin credentials not found.");
    console.error("Run 'devin auth login' first.");
    process.exit(1);
  }
  const content = fs.readFileSync(credPath, "utf8");
  const tokenMatch = content.match(/windsurf_api_key\s*=\s*"([^"]+)"/);
  const serverMatch = content.match(/api_server_url\s*=\s*"([^"]+)"/);
  if (!tokenMatch) {
    console.error("Error: No windsurf_api_key found in credentials.toml");
    process.exit(1);
  }
  return {
    sessionToken: tokenMatch[1],
    apiServerUrl: serverMatch ? serverMatch[1] : "https://server.codeium.com",
  };
}

// ─── Machine ID (same logic as windsurf-provider) ───────────────────────────

function getStableMachineId() {
  const seed = `${os.hostname()}:${os.userInfo().username}:windsurf-provider`;
  let result = "";
  let counter = 0;
  while (result.length < 256) {
    const h = crypto.createHash("sha512").update(seed + ":" + counter).digest("hex");
    result += h;
    counter++;
  }
  return result.substring(0, 256);
}

// ─── Call CheckUserMessageRateLimit ─────────────────────────────────────────

function checkRateLimit() {
  loadProto();
  const credentials = readCredentials();

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

  const request = { clientInfo };
  const protoBuf = _CheckRateLimitRequest.encode(request).finish();

  const serverUrl = new URL(credentials.apiServerUrl);
  const hostname = serverUrl.hostname;

  const options = {
    hostname,
    port: 443,
    path: "/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit",
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "Authorization": `Basic ${Buffer.from(credentials.sessionToken + ":" + credentials.sessionToken).toString("base64")}`,
      "Accept": "*/*",
      "Content-Length": protoBuf.length.toString(),
    },
    rejectUnauthorized: false,
  };

  console.log(`Checking rate limit on ${hostname}...`);
  console.log(`Endpoint: ${options.path}`);
  console.log();

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      // Log all response headers
      console.log("─── Response Headers ───");
      for (const [key, value] of Object.entries(res.headers)) {
        // Don't print full auth-related headers, but show rate-limit ones
        if (/rate|limit|retry|reset|remaining|credit|quota/i.test(key)) {
          console.log(`  ${key}: ${value}`);
        }
      }
      console.log(`  Status: ${res.statusCode}`);
      console.log();

      let body = Buffer.alloc(0);
      res.on("data", (chunk) => { body = Buffer.concat([body, chunk]); });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.log("─── Error Response ───");
          console.log(`  HTTP ${res.statusCode}`);
          // Try to parse as JSON error
          try {
            const errJson = JSON.parse(body.toString());
            console.log(`  Error: ${JSON.stringify(errJson, null, 2)}`);
          } catch {
            console.log(`  Body: ${body.toString().substring(0, 500)}`);
          }
          // Still check for rate-limit headers
          const rlHeaders = Object.entries(res.headers).filter(([k]) =>
            /rate|limit|retry|reset|remaining|credit|quota/i.test(k)
          );
          if (rlHeaders.length > 0) {
            console.log();
            console.log("─── Rate Limit Headers ───");
            for (const [k, v] of rlHeaders) {
              console.log(`  ${k}: ${v}`);
            }
          }
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        // Parse protobuf response
        try {
          // Check if response uses Connect framing (5-byte header)
          let protoData = body;
          if (body.length >= 5 && body[0] === 0x00) {
            const msgLen = body.readUInt32BE(1);
            if (body.length >= 5 + msgLen) {
              protoData = body.subarray(5, 5 + msgLen);
            }
          }

          // Dump raw hex for field analysis
          console.log("─── Raw Protobuf ───");
          console.log(`  Length: ${protoData.length} bytes`);
          console.log(`  Hex: ${protoData.toString("hex")}`);
          console.log();

          // Parse raw protobuf fields manually
          console.log("─── Raw Field Parse ───");
          let off = 0;
          while (off < protoData.length) {
            const tagByte = protoData[off];
            const fieldNum = tagByte >> 3;
            const wireType = tagByte & 0x07;
            off++;
            if (wireType === 0) { // varint
              let val = 0n;
              let shift = 0n;
              while (off < protoData.length) {
                const b = protoData[off++];
                val |= BigInt(b & 0x7f) << shift;
                shift += 7n;
                if (!(b & 0x80)) break;
              }
              console.log(`  Field ${fieldNum} (varint): ${val}`);
            } else if (wireType === 2) { // length-delimited
              let len = 0;
              let shift = 0;
              while (off < protoData.length) {
                const b = protoData[off++];
                len |= (b & 0x7f) << shift;
                shift += 7;
                if (!(b & 0x80)) break;
              }
              const data = protoData.subarray(off, off + len);
              off += len;
              // Try as UTF-8 string
              const str = data.toString("utf8");
              const isPrintable = /^[\x20-\x7e]*$/.test(str) && str.length > 0;
              console.log(`  Field ${fieldNum} (bytes, len=${len}): ${isPrintable ? `"${str}"` : data.toString("hex")}`);
            } else if (wireType === 5) { // 32-bit
              const val = protoData.readUInt32LE(off);
              off += 4;
              console.log(`  Field ${fieldNum} (32-bit): ${val}`);
            } else if (wireType === 1) { // 64-bit
              const val = protoData.readBigUInt64LE(off);
              off += 8;
              console.log(`  Field ${fieldNum} (64-bit): ${val}`);
            } else {
              console.log(`  Field ${fieldNum} (wireType=${wireType}): unknown`);
              break;
            }
          }
          console.log();

          const decoded = _CheckRateLimitResponse.decode(protoData);
          const obj = decoded.toJSON();

          console.log("─── Rate Limit Info ───");
          console.log();

          const isLimited = obj.isRateLimited === true;
          const remaining = obj.remainingMessages;
          const max = obj.maxMessages;

          if (isLimited) {
            console.log("  ⚠  You are currently RATE LIMITED.");
            console.log("  The server does not provide remaining/max counts while limited.");
            console.log("  The reset time is shown in the error message when you try to send a message.");
            console.log("  (e.g. \"Your limit will reset in 19 minutes\")");
          } else {
            console.log("  ✓  You are NOT rate limited.");
            if (remaining !== undefined && remaining >= 0) {
              console.log(`  Remaining messages: ${remaining}`);
            }
            if (max !== undefined && max > 0) {
              console.log(`  Max messages (window): ${max}`);
            }
            if (remaining !== undefined && max !== undefined && max > 0) {
              console.log(`  Used messages: ${max - remaining}`);
              console.log(`  Usage: ${((max - remaining) / max * 100).toFixed(1)}%`);
            }
          }
          console.log();
          console.log(`  Raw decoded: ${JSON.stringify(obj)}`);
        } catch (e) {
          console.log("─── Failed to decode protobuf ───");
          console.log(`  Error: ${e.message}`);
          console.log(`  Raw hex: ${body.toString("hex").substring(0, 200)}`);
          console.log(`  Raw text: ${body.toString().substring(0, 500)}`);
        }
        resolve();
      });
    });

    req.on("error", (e) => {
      console.error(`Request error: ${e.message}`);
      reject(e);
    });

    req.write(protoBuf);
    req.end();
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

checkRateLimit().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
