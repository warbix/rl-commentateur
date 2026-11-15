// Serves the voice library page (cache/library.html) and its voices, to listen to them from a phone
// or another computer on the same network. The page also has a test area: any text, said live by one
// of the voices, the pronunciation fixes of config.json, which can be tried and saved from there, and an editor
// for the lines of phrases.json, with a button to generate the voices of the new lines.
//
//   npm run library            → http://<this PC>:8080
//   npm run library -- 9000    → on another port
//
// Only the page, its script and the voice files are served, nothing else from cache/ (recap, jingle…). Only the
// "pronunciation" section of config.json can be changed (the token and the rest are never sent), and only the
// lines of phrases.json (not the situations or their variables).

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Phrases } = require("./phrases");
const { TTS } = require("./tts");
const { readConfig, CONFIG_FILE } = require("./config");
const library = require("./library");
const { LABELS } = require("./feedback");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, "cache");
const PORT = Number(process.argv[2]) || 8080;
const PHRASES_FILE = path.join(ROOT, "phrases.json");
const phrases = new Phrases(PHRASES_FILE);
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

// The situations and their lines, for the editor
function listPhrases(res) {
  const all = phrases.all();
  const situations = library.situations(all).map((key) => {
    const node = phrases.node(key, all);
    return { key, label: LABELS[key] || key, help: node._variables || "", variables: library.roles(key, node).declared, phrases: node.phrases };
  });
  json(res, 200, { situations });
}

// Replaces the lines of one situation: { key, phrases: [...] }. Each line names at least one of its variables,
// and only those.
async function savePhrases(req, res) {
  const { key, phrases: lines } = await readBody(req);
  const all = phrases.all();
  if (!library.situations(all).includes(key)) return json(res, 400, { error: "Situation inconnue" });
  const node = phrases.node(key, all);
  const declared = library.roles(key, node).declared;
  if (!Array.isArray(lines) || !lines.length) return json(res, 400, { error: "Il faut au moins une phrase" });
  const clean = lines.map((l) => String(l).replace(/\s+/g, " ").trim());
  for (const [i, line] of clean.entries()) {
    const used = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (!used.length) return json(res, 400, { error: `Phrase ${i + 1} : aucun nom entre accolades` });
    const unknown = used.find((v) => !declared.includes(v));
    if (unknown) return json(res, 400, { error: `Phrase ${i + 1} : {${unknown}} n'existe pas ici` });
  }
  node.phrases = clean;
  fs.writeFileSync(PHRASES_FILE, JSON.stringify(all, null, 2) + "\n");
  console.log(`Lines: ${key} saved (${clean.length})`);
  json(res, 200, { ok: true, missing: library.status(phrases, tts).missing.length });
}

// A line with the squad's names, as the voice would say it: { key, line } → { text }
async function render(req, res) {
  const { key, line } = await readBody(req);
  if (!library.situations(phrases.all()).includes(key)) return json(res, 400, { error: "Situation inconnue" });
  json(res, 200, { text: library.sample(phrases, key, String(line || "")) });
}

// Voices of the lines that have none yet (free voices only: the paid ones go through npm run pregenerate)
const job = { running: false, done: 0, total: 0, errors: 0 };
async function generate(req, res) {
  const st = library.status(phrases, tts);
  if (req.method === "GET") return json(res, 200, { ...job, missing: st.missing.length });
  if (job.running) return json(res, 200, job);
  if (st.settings.provider !== "edge") return json(res, 400, { error: "Voix payantes : lance npm run pregenerate (il annonce le coût)" });
  Object.assign(job, { running: true, done: 0, total: st.missing.length, errors: 0 });
  json(res, 200, job);
  const errors = await library.generate(tts, st.missing, { parallel: 3, onProgress: (done) => { job.done = done; } });
  job.errors = errors.length;
  job.running = false;
  // The page lists the voices that exist: rewritten with the new ones
  const now = library.status(phrases, tts);
  library.writePage(path.join(CACHE, "library.html"), now.entries.filter((e) => fs.existsSync(e.file)));
  console.log(`Voices: ${job.done} generated, ${job.errors} failed`);
}

const server = http.createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)) || "library.html";
  try {
    if (req.method === "GET" && name === "library.html") return sendFile(res, path.join(CACHE, name), "text/html; charset=utf-8", "no-cache");
    if (req.method === "GET" && /^[0-9a-f]{40}\.mp3$/.test(name)) return sendFile(res, path.join(CACHE, name), "audio/mpeg", "max-age=86400");
    if (req.method === "GET" && name === "library-page.js") return sendFile(res, path.join(__dirname, "web", name), "text/javascript; charset=utf-8", "no-cache");
    if (req.method === "GET" && name === "api/info") return info(res);
    if (req.method === "GET" && name === "api/phrases") return listPhrases(res);
    if (req.method === "POST" && name === "api/phrases") return await savePhrases(req, res);
    if (req.method === "POST" && name === "api/render") return await render(req, res);
    if (name === "api/generate") return await generate(req, res);
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
