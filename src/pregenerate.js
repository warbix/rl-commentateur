// Generates in advance every line the bot can say about the squad, and a page to listen to them.
//
//   npm run pregenerate              → counts the lines, generates the missing ones (asks first if it costs money)
//   npm run pregenerate -- --yes     → generates without asking (paid voices)
//   npm run pregenerate -- --prune   → also removes the voices no line uses any more
//   npm run pregenerate -- --dry-run → only counts
//
// The page is cache/library.html: open it in a browser to listen to everything.

const path = require("path");
const { Phrases } = require("./phrases");
const { TTS } = require("./tts");
const library = require("./library");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, "cache");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

async function main() {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  const tts = new TTS({ cacheDir: CACHE });
  const st = library.status(phrases, tts);
  const s = st.settings;
  const voice = s.provider === "openai" ? `OpenAI ${s.openai.model}` : "Edge (free)";

  console.log(`${st.entries.length} lines in the library, ${st.missing.length} to generate (${st.chars} characters) with ${voice}.`);
  if (s.rotation !== "line" && s.rotation !== "fixed") {
    console.log(`⚠️ voice.rotation is "${s.rotation}": the bot will not find these lines. Set it to "line" in config.json.`);
  }
  if (st.missing.length && s.provider === "openai") console.log(`Estimated cost: about ${st.cost.toFixed(2)} dollars.`);

  if (st.missing.length && !flag("--dry-run")) {
    if (s.provider === "openai" && !flag("--yes")) {
      console.log("Nothing generated. Run again with --yes to go ahead: npm run pregenerate -- --yes");
    } else {
      const started = Date.now();
      const errors = await library.generate(tts, st.missing, {
        parallel: s.provider === "openai" ? 6 : 4,
        onProgress: (done, total) => {
          if (done % 50 === 0 || done === total) console.log(`  ${done}/${total} (${Math.round((Date.now() - started) / 1000)} s)`);
        },
      });
      if (errors.length) {
        console.log(`${errors.length} lines failed (run again to retry them):`);
        for (const e of errors.slice(0, 5)) console.log(`  ${e}`);
      }
    }
  }

  if (flag("--prune")) console.log(`${library.prune(CACHE, st.entries)} unused voice files removed.`);
  const page = path.join(CACHE, "library.html");
  library.writePage(page, st.entries);
  console.log(`To listen to everything: ${page}`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
