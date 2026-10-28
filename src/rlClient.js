// Connection to the Rocket League Stats API (local TCP socket).
// Emits "event" (name, data) for each message, and reconnects on its own.

const net = require("net");
const EventEmitter = require("events");

// The game sends JSON objects glued to each other: they are split by following
// the depth of the braces (ignoring those inside strings).
function createJsonSplitter(onObject) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let depth = 0, inString = false, escaped = false, start = -1, consumed = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") { if (depth++ === 0) start = i; }
      else if (c === "}" && depth > 0 && --depth === 0) {
        onObject(buf.slice(start, i + 1));
        consumed = i + 1;
      }
    }
    buf = buf.slice(consumed);
  };
}

class RLClient extends EventEmitter {
  constructor({ host = "127.0.0.1", port = 49123 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.connected = false;
  }

  start() {
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setEncoding("utf8");
    socket.on("connect", () => { this.connected = true; this.emit("connected"); });
    socket.on("data", createJsonSplitter((text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      let data = msg.Data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch {} }
      this.emit("event", msg.Event, data);
    }));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.connected) this.emit("disconnected");
      this.connected = false;
      setTimeout(() => this.start(), 3000);
    });
  }
}

module.exports = { RLClient, createJsonSplitter };
