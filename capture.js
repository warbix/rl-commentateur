// Enregistre tous les événements (sauf UpdateState, dont on garde 1 exemple par seconde) dans un fichier JSONL.
// Usage : node capture.js sortie.jsonl
const net = require("net");
const fs = require("fs");
const out = process.argv[2];
let buf = "", lastState = 0, n = 0;

function connect() {
  const s = net.createConnection({ host: "127.0.0.1", port: 49123 });
  s.setEncoding("utf8");
  s.on("connect", () => console.log("Capture en cours dans", out));
  s.on("data", (chunk) => {
    buf += chunk;
    let depth = 0, inStr = false, esc = false, start = -1, used = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") { if (depth++ === 0) start = i; }
      else if (c === "}" && depth > 0 && --depth === 0) {
        try {
          const m = JSON.parse(buf.slice(start, i + 1));
          let d = m.Data; if (typeof d === "string") { try { d = JSON.parse(d); } catch {} }
          const now = Date.now();
          if (m.Event !== "UpdateState" || now - lastState > 1000) {
            if (m.Event === "UpdateState") lastState = now;
            fs.appendFileSync(out, JSON.stringify({ t: now, e: m.Event, d }) + "\n");
            if (++n % 50 === 0) console.log(n, "événements enregistrés");
          }
        } catch {}
        used = i + 1;
      }
    }
    buf = buf.slice(used);
  });
  s.on("error", () => {});
  s.on("close", () => setTimeout(connect, 3000));
}
connect();
