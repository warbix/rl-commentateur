// Script of the voice library page (served by npm run library): test a text with a voice, pronunciation
// fixes, and the line editor (phrases.json). Messages are in French, for the squad.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  };
  var api = function (url, body) {
    var options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return fetch(url, options).then(function (r) {
      if (r.status === 404) throw new Error("le serveur de la page est une ancienne version : relance npm run library");
      return r;
    });
  };
  var json = function (r) {
    return r.json().then(function (d) { if (!r.ok || d.error) throw new Error(d.error || r.statusText); return d; });
  };

  // ---- Test a text ----
  function say(text, fixes, extra, out) {
    out = out || $("spoken");
    out.textContent = "Génération…";
    return api("api/preview", { text: text, voice: $("voice").value, fixes: fixes, extra: extra || {} }).then(function (r) {
      if (!r.ok) return json(r);
      out.textContent = "Texte lu : " + decodeURIComponent(r.headers.get("X-Spoken-Text") || "");
      return r.blob().then(function (b) {
        $("player").src = URL.createObjectURL(b);
        $("player").play();
      });
    }).catch(function (e) { out.textContent = "Erreur : " + e.message; });
  }
  function showFixes(p) {
    var list = Object.keys(p).map(function (w) { return "<span><b>" + esc(w) + "</b> → " + esc(p[w]) + "</span>"; });
    $("fixes-list").innerHTML = list.length ? list.join("") : "<small>Aucune correction.</small>";
  }
  api("api/info").then(json).then(function (d) {
    $("voice").innerHTML = d.voices.map(function (v, i) { return "<option value='" + i + "'>" + esc(v) + "</option>"; }).join("");
    showFixes(d.pronunciation);
  }).catch(function () {
    $("test").querySelector("p small").textContent = "Indisponible : lance npm run library et ouvre la page par son adresse.";
  });
  $("play").onclick = function () { say($("text").value, $("fixes").checked); };
  // The fix being tried is applied by the server, with the saved ones
  $("try").onclick = function () {
    var w = $("word").value.trim(), s = $("said").value.trim();
    if (!w || !s) return;
    var extra = {};
    extra[w] = s;
    say($("text").value, true, extra);
  };
  $("save").onclick = function () {
    api("api/pronunciation", { word: $("word").value, said: $("said").value }).then(json).then(function (d) {
      showFixes(d.pronunciation);
      $("status").textContent = "Enregistré dans config.json. Les phrases concernées n'ont plus de voix : « Générer les voix manquantes » plus bas.";
    }).catch(function (e) { $("status").textContent = "Erreur : " + e.message; });
  };

  // ---- Line editor ----
  var situations = [];
  var current = null;
  var dirty = false;
  var variables = function (text) {
    var found = [], re = /\{(\w+)\}/g, m;
    while ((m = re.exec(text))) found.push(m[1]);
    return found;
  };
  // A line must name at least one declared variable, and only declared ones
  function check(text) {
    var used = variables(text);
    if (!text.trim()) return "phrase vide";
    if (!used.length) return "aucun nom entre accolades";
    for (var i = 0; i < used.length; i++) if (current.variables.indexOf(used[i]) < 0) return "{" + used[i] + "} n'existe pas ici";
    return "";
  }
  function addLine(text) {
    var div = document.createElement("div");
    div.className = "edit-line";
    div.innerHTML = "<textarea></textarea><button title='Écouter avec les surnoms'>Écouter</button><button title='Supprimer'>✕</button>";
    var area = div.querySelector("textarea");
    area.value = text;
    area.oninput = function () {
      dirty = true;
      div.classList.toggle("bad", !!check(area.value));
      $("edit-status").textContent = check(area.value) ? "Erreur : " + check(area.value) : "Modifié, pas encore enregistré.";
    };
    div.querySelectorAll("button")[0].onclick = function () {
      api("api/render", { key: current.key, line: area.value }).then(json).then(function (d) {
        say(d.text, false, null, $("edit-status"));
      }).catch(function (e) { $("edit-status").textContent = "Erreur : " + e.message; });
    };
    div.querySelectorAll("button")[1].onclick = function () {
      div.remove();
      dirty = true;
      $("edit-status").textContent = "Supprimée, pas encore enregistré.";
    };
    $("lines").appendChild(div);
    return area;
  }
  function show(key) {
    current = situations.find(function (s) { return s.key === key; });
    $("lines").innerHTML = "";
    $("vars").textContent = "Noms possibles : " + current.variables.map(function (v) { return "{" + v + "}"; }).join(", ");
    current.phrases.forEach(addLine);
    dirty = false;
    $("edit-status").textContent = current.phrases.length + " phrases.";
  }
  function load(key) {
    return api("api/phrases").then(json).then(function (d) {
      situations = d.situations;
      $("situation").innerHTML = situations.map(function (s) {
        return "<option value='" + esc(s.key) + "'>" + esc(s.label) + " (" + s.phrases.length + ")</option>";
      }).join("");
      $("situation").value = key || situations[0].key;
      show($("situation").value);
    });
  }
  $("situation").onchange = function () {
    if (dirty && !confirm("Les modifications de cette situation ne sont pas enregistrées. Changer quand même ?")) {
      $("situation").value = current.key;
      return;
    }
    show($("situation").value);
  };
  $("add").onclick = function () {
    addLine("").focus();
    dirty = true;
  };
  $("save-lines").onclick = function () {
    var texts = Array.prototype.map.call($("lines").querySelectorAll("textarea"), function (a) { return a.value.trim(); });
    for (var i = 0; i < texts.length; i++) {
      var problem = check(texts[i]);
      if (problem) { $("edit-status").textContent = "Erreur phrase " + (i + 1) + " : " + problem; return; }
    }
    api("api/phrases", { key: current.key, phrases: texts }).then(json).then(function (d) {
      return load(current.key).then(function () {
        $("edit-status").textContent = "Enregistré (" + texts.length + " phrases). " + (d.missing ? d.missing + " voix à générer." : "");
      });
    }).catch(function (e) { $("edit-status").textContent = "Erreur : " + e.message; });
  };
  window.addEventListener("beforeunload", function (e) { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  // ---- Voices of the new lines ----
  function poll() {
    api("api/generate").then(json).then(function (d) {
      if (d.running) {
        $("gen-status").textContent = "Génération : " + d.done + " / " + d.total + "…";
        setTimeout(poll, 2000);
      } else {
        $("gen-status").textContent = d.total ? "Terminé : " + d.done + " voix générées" + (d.errors ? ", " + d.errors + " en échec" : "") + ". Recharge la page pour les écouter plus bas." : d.missing + " voix manquantes.";
      }
    }).catch(function (e) { $("gen-status").textContent = "Erreur : " + e.message; });
  }
  $("generate").onclick = function () {
    api("api/generate", {}).then(json).then(poll).catch(function (e) { $("gen-status").textContent = "Erreur : " + e.message; });
  };
  load().then(poll).catch(function () {});
})();
