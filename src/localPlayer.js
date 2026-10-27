// Lecture sur les haut-parleurs du PC, pour tester sans Discord (Windows uniquement).
// Le mp3 est converti en wav avec FFmpeg, puis lu par le lecteur intégré de Windows.

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
