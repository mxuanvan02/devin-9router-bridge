const https = require("https");
const path = require("path");
const fs = require("fs");
const os = require("os");
const protobuf = require("protobufjs");

const PROTO_PATH = path.join("/Users/van/Projects/devin-9router-bridge/proto", "windsurf.proto");
const root = protobuf.loadSync(PROTO_PATH);
const GetCliModelConfigsRequest = root.lookupType("exa.api_server_pb.GetCliModelConfigsRequest");
const GetCliModelConfigsResponse = root.lookupType("exa.api_server_pb.GetCliModelConfigsResponse");

const credPath = path.join(os.homedir(), ".local", "share", "devin", "credentials.toml");
const content = fs.readFileSync(credPath, "utf8");
const token = content.match(/windsurf_api_key\s*=\s*"([^"]+)"/)[1];
const hostname = "server.codeium.com";

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
  servername: hostname, rejectUnauthorized: false,
};

const req = https.request(options, (res) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => {
    const buf = Buffer.concat(chunks);
    const decoded = GetCliModelConfigsResponse.decode(buf);
    
    // For each model, re-encode and manually parse raw bytes to find ALL fields
    [5,6,7,8].forEach(i => {
      const m = decoded.clientModelConfigs[i];
      // Get the raw encoded bytes for this ClientModelConfig
      const subWriter = protobuf.Writer.create();
      m.$type.encode(m, subWriter);
      const rawBytes = subWriter.finish();
      
      // Parse raw protobuf fields manually
      const fields = [];
      let pos = 0;
      while (pos < rawBytes.length) {
        const tag = rawBytes.readVarint32(pos);
        const fieldNum = tag >>> 3;
        const wireType = tag & 7;
        pos += rawBytes.readVarint32.bytesRead || 1;
        
        let value = '';
        if (wireType === 0) { // varint
          const val = rawBytes.readVarint32(pos);
          value = val.toString();
          pos += rawBytes.readVarint32.bytesRead || 1;
        } else if (wireType === 2) { // length-delimited
          const len = rawBytes.readVarint32(pos);
          pos += rawBytes.readVarint32.bytesRead || 1;
          const data = rawBytes.slice(pos, pos + len);
          value = data.toString('utf8').substring(0, 50);
          pos += len;
        } else if (wireType === 5) { // 32-bit
          value = '32bit';
          pos += 4;
        } else if (wireType === 1) { // 64-bit
          value = '64bit';
          pos += 8;
        }
        fields.push({fieldNum, wireType, value});
      }
      console.log(`\n--- ${m.modelUid} (raw ${rawBytes.length} bytes) ---`);
      fields.forEach(f => console.log(`  field ${f.fieldNum} (wt=${f.wireType}): ${f.value}`));
    });
  });
});
req.on("error", (e) => console.error("Error:", e.message));
req.write(buffer);
req.end();
