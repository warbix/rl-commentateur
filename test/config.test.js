const test = require("node:test");
const assert = require("node:assert");
const { migrate } = require("../src/config");

test("a config with the former French keys is migrated to the English ones", () => {
  const old = {
    discord: { token: "x", salonVocalId: "1", salonTexteId: "2", suivre: ["MonPseudoDiscord"] },
    commenter: "notre-equipe",
    surnoms: { A: ["a"] },
    prononciation: { MVP: "aime vie pie" },
    voix: { jingle: true, rotation: "aleatoire", liste: ["v"], vitesse: "+0%", hauteur: "+0Hz", volume: 1 },
    pregenerer: true,
    enregistrerMatchs: false,
    seuils: { tapinMaxDist: 800, presqueMarge: 0.2 },
    rocketLeague: { hote: "127.0.0.1", port: 49123, verifierApi: true, packetSendRate: 30, cheminsJeu: [] },
  };
  assert.strictEqual(migrate(old), true);
  assert.deepStrictEqual(old, {
    discord: { token: "x", voiceChannelId: "1", textChannelId: "2", follow: ["MonPseudoDiscord"] },
    target: "our-team",
    nicknames: { A: ["a"] },
    pronunciation: { MVP: "aime vie pie" },
    voice: { jingle: true, rotation: "random", list: ["v"], rate: "+0%", pitch: "+0Hz", volume: 1 },
    pregenerate: true,
    recordMatches: false,
    thresholds: { tapInMaxDistance: 800, nearMissMargin: 0.2 },
    rocketLeague: { host: "127.0.0.1", port: 49123, checkApi: true, packetSendRate: 30, gamePaths: [] },
  });
  assert.strictEqual(migrate(old), false, "already migrated: nothing changes");
});
