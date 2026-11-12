// Serves the voice library page (cache/library.html) and its voices, to listen to them from a phone
// or another computer on the same network.
//
//   npm run library            → http://<this PC>:8080
//   npm run library -- 9000    → on another port
//
// Only the page and the voice files are served, nothing else from cache/ (recap, jingle…).

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE = path.join(__dirname, "..", "cache");
const PORT = Number(process.argv[2]) || 8080;

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)) || "library.html";
  const isPage = name === "library.html";
  if (!isPage && !/^[0-9a-f]{40}\.mp3$/.test(name)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const file = path.join(CACHE, name);
  fs.stat(file, (err, st) => {
    if (err) {
      res.writeHead(404).end(isPage ? "No library yet: run npm run pregenerate" : "Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": isPage ? "text/html; charset=utf-8" : "audio/mpeg",
      "Content-Length": st.size,
      "Cache-Control": isPage ? "no-cache" : "max-age=86400",
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, () => {
  const addresses = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
  console.log("Voice library:");
  console.log(`  on this PC:          http://localhost:${PORT}`);
  for (const a of addresses) console.log(`  from the network:    http://${a}:${PORT}`);
  console.log("Ctrl+C to stop.");
});
