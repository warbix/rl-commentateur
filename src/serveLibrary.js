// Serves the voice library page (cache/library.html) and its voices, to listen to them from a phone
// or another computer on the same network. The page also has a test area: any text, said live by one
// of the voices, and the pronunciation fixes of config.json, which can be tried and saved from there.
//
//   npm run library            → http://<this PC>:8080
//   npm run library -- 9000    → on another port
//
// Only the page and the voice files are served, nothing else from cache/ (recap, jingle…), and only the
// "pronunciation" section of config.json can be changed (the token and the rest are never sent).

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Phrases } = require("./phrases");
const { TTS } = require("./tts");
const { readConfig, CONFIG_FILE } = require("./config");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, "cache");
const PORT = Number(process.argv[2]) || 8080;
const phrases = new Phrases(path.join(ROOT, "phrases.json"));
const tts = new TTS({ cacheDir: CACHE });

const json = (res, status, data) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10000) { reject(new Error("too long")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); } });
  });
}

function sendFile(res, file, type, cache) {
  fs.stat(file, (err, st) => {
    if (err) return res.writeHead(404).end(type.startsWith("text/html") ? "No library yet: run npm run pregenerate" : "Not found");
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Cache-Control": cache });
    fs.createReadStream(file).pipe(res);
  });
}

// The voices and the pronunciation fixes, for the test area
function info(res) {
  const s = tts.settings();
  json(res, 200, { voices: s.list.map((v) => v.label), pronunciation: readConfig().pronunciation || {} });
}

// Says a text with one voice: { text, voice (index), fixes (apply the pronunciation fixes) } → mp3.
// The text actually sent to the voice comes back in the X-Spoken-Text header.
async function preview(req, res) {
  const { text, voice = 0, fixes = true, extra = {} } = await readBody(req);
  const said = String(text || "").trim().slice(0, 500);
  if (!said) return json(res, 400, { error: "Texte vide" });
  const s = tts.settings();
  const v = s.list[Number(voice)] || s.list[0];
  // extra: a fix being tried, not saved yet ({ "seum": "sœum" })
  const spoken = fixes ? phrases.pronounce(said, { ...(readConfig().pronunciation || {}), ...extra }) : said;
  const file = await tts.synth(spoken, v);
  res.setHeader("X-Spoken-Text", encodeURIComponent(spoken));
  sendFile(res, file, "audio/mpeg", "no-cache");
}

// Saves a pronunciation fix in config.json: { word, said }. An empty "said" removes the fix.
async function savePronunciation(req, res) {
  const { word, said } = await readBody(req);
  const w = String(word || "").trim();
  if (!w) return json(res, 400, { error: "Mot vide" });
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  config.pronunciation = config.pronunciation || {};
  if (String(said || "").trim()) config.pronunciation[w] = String(said).trim();
  else delete config.pronunciation[w];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  console.log(`Pronunciation: ${w} → ${config.pronunciation[w] || "(removed)"}`);
  json(res, 200, { pronunciation: config.pronunciation });
}

const server = http.createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)) || "library.html";
  try {
    if (req.method === "GET" && name === "library.html") return sendFile(res, path.join(CACHE, name), "text/html; charset=utf-8", "no-cache");
    if (req.method === "GET" && /^[0-9a-f]{40}\.mp3$/.test(name)) return sendFile(res, path.join(CACHE, name), "audio/mpeg", "max-age=86400");
    if (req.method === "GET" && name === "api/info") return info(res);
    if (req.method === "POST" && name === "api/preview") return await preview(req, res);
    if (req.method === "POST" && name === "api/pronunciation") return await savePronunciation(req, res);
    res.writeHead(404).end("Not found");
  } catch (e) {
    console.error("Library page:", e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const addresses = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
  console.log("Voice library:");
  console.log(`  on this PC:          http://localhost:${PORT}`);
  for (const a of addresses) console.log(`  from the network:    http://${a}:${PORT}`);
  console.log("Ctrl+C to stop.");
});
