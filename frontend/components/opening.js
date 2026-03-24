let board = null;
let game = new Chess();

let currentOpening = null;

const openings = {
  italian: {
    title: "Apertura Italiana",
    desc: "Una delle aperture più classiche: sviluppa rapidamente cavallo e alfiere.",
    moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"],
  },
  sicilian: {
    title: "Difesa Siciliana",
    desc: "Una delle difese più aggressive contro 1.e4.",
    moves: ["e4", "c5"],
  },
  french: {
    title: "Difesa Francese",
    desc: "Solida difesa che mira a contrattaccare il centro.",
    moves: ["e4", "e6", "d4", "d5"],
  },
  caro: {
    title: "Difesa Caro-Kann",
    desc: "Difesa molto solida e posizionale.",
    moves: ["e4", "c6", "d4", "d5"],
  },
  queen_gambit: {
    title: "Gambetto di Donna",
    desc: "Una delle aperture più famose e strategiche.",
    moves: ["d4", "d5", "c4"],
  },
};

// Carica scacchiera
window.onload = function () {
  board = Chessboard("board", {
    draggable: false,
    position: "start",
  });
};

// Carica apertura selezionata
function loadOpening(key) {
  currentOpening = openings[key];

  document.getElementById("opening-title").innerText = currentOpening.title;
  document.getElementById("opening-desc").innerText = currentOpening.desc;

  game.reset();
  board.position("start");
}

// Riproduce l'apertura mossa per mossa
function playOpening() {
  if (!currentOpening) return;

  game.reset();
  board.position("start");

  let i = 0;

  function playMove() {
    if (i >= currentOpening.moves.length) return;

    game.move(currentOpening.moves[i]);
    board.position(game.fen());

    i++;
    setTimeout(playMove, 700);
  }

  playMove();
}
``;
