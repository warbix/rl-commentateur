// Playback on the PC speakers, to test without Discord (Windows only).
// The mp3 is converted to wav with FFmpeg, then played by the built-in Windows player.

const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, () => resolve()));

class LocalPlayer {
  constructor() {
    this.chain = Promise.resolve();
  }

  async start() {}

  enqueue(file) {
    const wav = file.replace(/\.mp3$/, ".wav");
    this.chain = this.chain
      .then(() => run(ffmpegPath, ["-y", "-loglevel", "error", "-i", file, wav]))
      .then(() => run("powershell", ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${wav.replace(/'/g, "''")}').PlaySync()`]));
  }
}

module.exports = { LocalPlayer };
