const https = require("https");
const path = require("path");
const fs = require("fs");
const os = require("os");
const protobuf = require("protobufjs");

const PROTO_PATH = path.join(__dirname, "proto", "windsurf.proto");
const root = protobuf.loadSync(PROTO_PATH);
const GetCliModelConfigsRequest = root.lookupType("exa.api_server_pb.GetCliModelConfigsRequest");
const GetCliModelConfigsResponse = root.lookupType("exa.api_server_pb.GetCliModelConfigsResponse");

const credPath = path.join(os.homedir(), ".local", "share", "devin", "credentials.toml");
const content = fs.readFileSync(credPath, "utf8");
const m = content.match(/windsurf_api_key\s*=\s*"([^"]+)"/);
if (!m) { console.error("No windsurf_api_key found in credentials.toml"); process.exit(1); }
const token = m[1];
const serverUrl = content.match(/api_server_url\s*=\s*"([^"]+)"/)?.[1] || "https://server.codeium.com";
const hostname = new URL(serverUrl).hostname;

const clientInfo = {
  clientName: "chisel", clientVersion: "3000.1.27", apiKey: token,
  language: "en", platform: "mac", version: "3000.1.27",
  clientName2: "chisel", machineId: "a".repeat(128),
};
const request = GetCliModelConfigsRequest.create({ clientInfo });
const buffer = GetCliModelConfigsRequest.encode(request).finish();

const options = {
  hostname, port: 443,
  path: "/exa.api_server_pb.ApiServerService/GetCliModelConfigs",
  method: "POST",
  headers: {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    "Authorization": `Basic ${Buffer.from(token + ":" + token).toString("base64")}`,
    "Content-Length": buffer.length.toString(),
    "Host": hostname,
  },
  servername: hostname,
};

const req = https.request(options, (res) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => {
    const buf = Buffer.concat(chunks);
    const decoded = GetCliModelConfigsResponse.decode(buf).toJSON();
    // Show all fields for glm-5-2, swe-1-7, kimi models
    decoded.clientModelConfigs.forEach((m, i) => {
      if (m.modelUid && (m.modelUid.startsWith("glm-5-2") || m.modelUid.startsWith("swe-1-7") || m.modelUid.startsWith("kimi-k2-7"))) {
        console.log(JSON.stringify({
          index: i,
          modelUid: m.modelUid,
          displayName: m.displayName,
          isPremium: m.isPremium,
          isRecommended: m.isRecommended,
          tier: m.tier,
          maxTokens: m.maxTokens,
          contextWindow: m.modelInfo?.contextWindow,
          maxOutputTokens: m.modelInfo?.maxOutputTokens,
          promoStatus: m.promoStatus,
          pricingType: m.pricingType,
          modelCostTier: m.modelCostTier,
          isCapacityLimited: m.isCapacityLimited,
          description: m.description,
        }, null, 2));
      }
    });
  });
});
req.on("error", (e) => console.error("Error:", e.message));
req.write(buffer);
req.end();
