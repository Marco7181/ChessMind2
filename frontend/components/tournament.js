// Carica classifica da localStorage
function loadLeaderboard() {
  const list = document.getElementById("leaderboard-list");
  list.innerHTML = "";

  const players = JSON.parse(localStorage.getItem("tournament_players")) || [];

  players
    .sort((a, b) => b.points - a.points)
    .forEach((p) => {
      const li = document.createElement("li");
      li.innerText = `${p.name} — ${p.points} pts`;
      list.appendChild(li);
    });
}

// Partecipa al torneo
function joinTournament() {
  const username = localStorage.getItem("username") || "Giocatore";

  let players = JSON.parse(localStorage.getItem("tournament_players")) || [];

  if (!players.find((p) => p.name === username)) {
    players.push({ name: username, points: 0 });
    localStorage.setItem("tournament_players", JSON.stringify(players));
    alert("Sei entrato nel torneo!");
  } else {
    alert("Sei già iscritto al torneo!");
  }

  loadLeaderboard();
}

// Simula una partita
function simulateMatch() {
  const username = localStorage.getItem("username") || "Giocatore";

  let players = JSON.parse(localStorage.getItem("tournament_players")) || [];

  const player = players.find((p) => p.name === username);

  if (!player) {
    alert("Prima devi iscriverti al torneo!");
    return;
  }

  // Simulazione semplice
  const win = Math.random() < 0.5;

  if (win) {
    player.points += 3;
    alert("Hai vinto la partita! +3 punti");
  } else {
    alert("Hai perso la partita!");
  }

  localStorage.setItem("tournament_players", JSON.stringify(players));
  loadLeaderboard();
}

window.onload = loadLeaderboard;
