// Carica Stockfish WASM
function loadStockfish() {
  stockfish = new Worker("components/stockfish.js");

  stockfish.onmessage = function (event) {
    const line = event.data;
    if (line.includes("bestmove")) {
      const move = line.split("bestmove ")[1].split(" ")[0];
      game.move({
        from: move.substring(0, 2),
        to: move.substring(2, 4),
        promotion: "q",
      });
      board.position(game.fen());
      if (typeof registerNewMove === "function") registerNewMove();
    }
  };
}

// Inizializza la scacchiera
function initBoard() {
  board = Chessboard("board", {
    draggable: true,
    position: "start",
    onDrop: onDrop,
    onSnapEnd: onSnapEnd,
    pieceTheme:
      "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
  });
}

function onSnapEnd() {}

// Gestione delle mosse utente
function onDrop(source, target) {
  const move = game.move({
    from: source,
    to: target,
    promotion: "q",
  });

  if (move === null) return "snapback";

  if (typeof registerNewMove === "function") registerNewMove();

  // Chiedi la mossa all'AI
  if (stockfish) {
    stockfish.postMessage("position fen " + game.fen());
    stockfish.postMessage("go depth 15");
  }
}

// Avvio rimosso per evitare conflitti con caricamento dinamico
// (Il caricamento è gestito dalle pagine HTML)
