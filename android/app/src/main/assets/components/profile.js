let importedGames = [];

function backendBaseUrl() {
  return "http://localhost:8000";
}

function setImportStatus(message, isError = false) {
  const status = document.getElementById("games-import-status");
  if (!status) return;

  status.innerText = message;
  status.classList.toggle("error", isError);
}

function formatGameLabel(game) {
  const when = game.played_at
    ? new Date(game.played_at).toLocaleString()
    : "Data sconosciuta";
  const resultMap = {
    win: "Vittoria",
    loss: "Sconfitta",
    draw: "Patta",
    unknown: "Risultato sconosciuto",
  };
  const result = resultMap[game.result] || game.result || "-";
  return `${when} - vs ${game.opponent || "?"} - ${result}`;
}

function renderImportedGames() {
  const container = document.getElementById("imported-games-container");
  if (!container) return;

  if (!importedGames.length) {
    container.innerHTML = "";
    return;
  }

  const itemsHtml = importedGames
    .map((game, index) => {
      const safeLabel = formatGameLabel(game)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");

      const gameUrl = (game.url || "").trim();
      const linkHtml = gameUrl
        ? `<a href="${gameUrl}" target="_blank" rel="noopener noreferrer">Apri</a>`
        : "";

      return `<li>
                <span>${safeLabel}</span>
                <div class="imported-game-actions">
                    ${linkHtml}
                    <button class="btn" onclick="downloadSingleImportedGame(${index})">PGN</button>
                </div>
            </li>`;
    })
    .join("");

  container.innerHTML = `
        <h4>Partite importate (${importedGames.length})</h4>
        <ul class="imported-games-list">${itemsHtml}</ul>
    `;
}

function saveImportedStats() {
  if (!importedGames.length) return;

  const wins = importedGames.filter((g) => g.result === "win").length;
  localStorage.setItem("games", importedGames.length);
  localStorage.setItem("wins", wins);
  loadProfile();
}

function downloadTextAsFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function importPlatformGames() {
  const platform =
    document.getElementById("platform-select")?.value || "chesscom";
  const usernameInput = document.getElementById("platform-username");
  const limitInput = document.getElementById("games-limit");
  const lichessTokenInput = document.getElementById("lichess-token");

  const username = (usernameInput?.value || "").trim();
  const limit = Number(limitInput?.value || 25);

  if (!username) {
    setImportStatus("Inserisci uno username valido.", true);
    return;
  }

  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.floor(limit)))
    : 25;

  let endpoint = "";
  if (platform === "lichess") {
    endpoint = `${backendBaseUrl()}/games/lichess/${encodeURIComponent(username)}?max_games=${safeLimit}`;
  } else {
    endpoint = `${backendBaseUrl()}/games/chesscom/${encodeURIComponent(username)}?limit=${safeLimit}`;
  }

  setImportStatus("Download partite in corso...");

  try {
    const headers = {};
    if (platform === "lichess") {
      const token = (lichessTokenInput?.value || "").trim();
      if (token) {
        headers["X-Lichess-Token"] = token;
      }
    }

    const response = await fetch(endpoint, { headers });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || "Import fallito");
    }

    importedGames = Array.isArray(payload.games) ? payload.games : [];
    renderImportedGames();
    saveImportedStats();

    if (!importedGames.length) {
      setImportStatus("Nessuna partita trovata per questo utente.", true);
      return;
    }

    setImportStatus(
      `Importate ${importedGames.length} partite da ${payload.platform}.`,
    );
  } catch (error) {
    setImportStatus(`Errore import: ${error.message}`, true);
  }
}

function exportImportedGamesPgn() {
  if (!importedGames.length) {
    setImportStatus("Importa prima almeno una partita.", true);
    return;
  }

  const pgn = importedGames
    .map((game) => (game.pgn || "").trim())
    .filter(Boolean)
    .join("\n\n");

  if (!pgn) {
    setImportStatus("Nessun PGN disponibile nelle partite importate.", true);
    return;
  }

  downloadTextAsFile("chessmind2-games.pgn", pgn);
  setImportStatus("File PGN esportato con successo.");
}

function downloadSingleImportedGame(index) {
  const game = importedGames[index];
  if (!game || !game.pgn) {
    setImportStatus("PGN non disponibile per questa partita.", true);
    return;
  }

  const safeId = (game.id || `game-${index + 1}`)
    .toString()
    .replaceAll("/", "-");
  downloadTextAsFile(`${safeId}.pgn`, game.pgn);
}

// Carica dati da localStorage
function loadProfile() {
  const username = localStorage.getItem("username") || "Marco";
  const avatarSeed = localStorage.getItem("avatar") || "Marco";

  const usernameEl = document.getElementById("username");
  const avatarEl = document.getElementById("avatar");
  const gamesEl = document.getElementById("games");
  const winsEl = document.getElementById("wins");
  const puzzlesEl = document.getElementById("puzzles");

  if (usernameEl) usernameEl.innerText = username;
  if (avatarEl) {
    avatarEl.src = `https://api.dicebear.com/7.x/bottts/svg?seed=${avatarSeed}`;
  }
  if (gamesEl) gamesEl.innerText = localStorage.getItem("games") || 0;
  if (winsEl) winsEl.innerText = localStorage.getItem("wins") || 0;
  if (puzzlesEl) puzzlesEl.innerText = localStorage.getItem("puzzles") || 0;

  const usernameInput = document.getElementById("platform-username");
  if (usernameInput && !usernameInput.value) {
    usernameInput.value = username;
  }
}

// Cambia nome
function changeName() {
  const newName = prompt("Inserisci il nuovo nome:");
  if (!newName) return;

  localStorage.setItem("username", newName.trim());
  loadProfile();
}

// Cambia avatar
function changeAvatar() {
  const seed = Math.random().toString(36).substring(2, 10);
  localStorage.setItem("avatar", seed);
  loadProfile();
}

// Reset statistiche
function resetStats() {
  if (!confirm("Sei sicuro di voler resettare le statistiche?")) return;

  localStorage.setItem("games", 0);
  localStorage.setItem("wins", 0);
  localStorage.setItem("puzzles", 0);
  importedGames = [];
  renderImportedGames();
  setImportStatus("Statistiche resettate.");
  loadProfile();
}

function initProfilePage() {
  loadProfile();
  renderImportedGames();
}
