// Solo variabili locali extra
let pendingPlayAiMove = false;

function resolvePlayAiBackendBaseUrl() {
  const queryValue = new URLSearchParams(window.location.search).get(
    "backendUrl",
  );
  const storedValue = localStorage.getItem("chessmind_backend_url");
  const globalValue = window.CHESSMIND_BACKEND_URL;
  const rawBaseUrl = queryValue || storedValue || globalValue;

  if (rawBaseUrl) {
    return rawBaseUrl.replace(/\/$/, "");
  }

  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  const isAndroidClient = /Android/i.test(navigator.userAgent || "");

  if (protocol === "http:" || protocol === "https:") {
    const resolvedHost = hostname || "127.0.0.1";
    return `${window.location.protocol}//${resolvedHost}:8000`;
  }

  if (isAndroidClient) {
    return "http://10.0.2.2:8000";
  }

  return "http://127.0.0.1:8000";
}

// Carica Stockfish WASM
function playAiLoadStockfish() {
  console.log("Caricamento Stockfish...");
  try {
    const candidates = [
      "components/stockfish.js",
      "../components/stockfish.js",
    ];
    stockfish = null;
    for (const path of candidates) {
      try {
        stockfish = new Worker(path);
        break;
      } catch (e) {
        stockfish = null;
      }
    }
    if (!stockfish) {
      throw new Error("Worker Stockfish non disponibile");
    }
    console.log("Stockfish Worker creato");

    let stockfishLoaded = false;
    const timeout = setTimeout(() => {
      if (!stockfishLoaded) {
        console.warn("Stockfish timeout - usando fallback");
        stockfish = null;
      }
    }, 5000);

    stockfish.onmessage = function (event) {
      stockfishLoaded = true;
      clearTimeout(timeout);
      const line = event.data;

      if (line.includes("bestmove")) {
        const move = line.split("bestmove ")[1].split(" ")[0];

        if (move === "(none)") return;

        game.move({
          from: move.substring(0, 2),
          to: move.substring(2, 4),
          promotion: "q",
        });

        document.getElementById("ai-move").innerText = move;
        board.position(game.fen());
      }
    };

    stockfish.onerror = function (e) {
      console.error("Errore Stockfish Worker:", e);
      stockfish = null;
    };
  } catch (e) {
    console.error("Errore caricamento Stockfish:", e);
    stockfish = null;
  }
}

// Inizializza la scacchiera
function playAiInitBoard() {
  console.log("Inizializzazione scacchiera...");
  const boardElement = document.getElementById("board");
  console.log("Elemento board trovato:", boardElement);

  if (!boardElement) {
    console.error("Elemento board non trovato!");
    return;
  }

  if (typeof Chessboard === "undefined") {
    console.error("Chessboard.js non caricato!");
    return;
  }

  board = Chessboard("board", {
    draggable: true,
    position: "start",
    onDrop: playAiOnDrop,
    onSnapEnd: playAiOnSnapEnd,
    pieceTheme:
      "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
  });
  console.log("Scacchiera creata:", board);
}

function playAiOnSnapEnd() {
  if (pendingPlayAiMove) {
    pendingPlayAiMove = false;
    makeAIMove();
  }
}

// Quando l’utente muove un pezzo
function playAiOnDrop(source, target) {
  const move = game.move({
    from: source,
    to: target,
    promotion: "q",
  });

  if (move === null) return "snapback";

  if (typeof registerNewMove === "function") registerNewMove();
  pendingPlayAiMove = true;
}

// IA: chiama il backend FastAPI o usa fallback
function makeAIMove() {
  if (game.game_over()) {
    document.getElementById("ai-move").innerText = "Partita terminata!";
    return;
  }

  const fen = game.fen();
  console.log("Richiesta AI mossa per FEN:", fen);

  const apiUrl =
    resolvePlayAiBackendBaseUrl() + "/analysis/?fen=" + encodeURIComponent(fen);
  console.log("URL API:", apiUrl);

  // Fetch con timeout di 10 secondi
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    console.log("⏱️ Timeout API - uso Stockfish locale");
    useFallbackMove();
  }, 10000);

  // Prova con il backend FastAPI
  fetch(apiUrl, { mode: "cors", signal: controller.signal })
    .then((response) => {
      clearTimeout(timeout);
      console.log("Risposta status:", response.status, response.statusText);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      console.log("Risposta JSON:", data);
      if (data.best_move) {
        console.log("Mossa dal backend:", data.best_move);
        const move = game.move({
          from: data.best_move.substring(0, 2),
          to: data.best_move.substring(2, 4),
          promotion: "q",
        });
        if (move) {
          board.position(game.fen());
          document.getElementById("ai-move").innerText =
            data.best_move + " (API)";
          if (typeof registerNewMove === "function") registerNewMove();
          console.log("✅ Mossa IA (API):", data.best_move);
        }
      } else {
        console.warn("Nessuna best_move:", data);
        useFallbackMove();
      }
    })
    .catch((error) => {
      clearTimeout(timeout);
      console.error("❌ Errore API:", error);
      useFallbackMove();
    });
}

// Fallback: Stockfish locale, altrimenti mossa casuale
function useFallbackMove() {
  if (stockfish) {
    console.log("Usando fallback - Stockfish locale");
    stockfish.postMessage("position fen " + game.fen());
    stockfish.postMessage("go depth " + (Number(aiDepth) || 10));
    return;
  }

  console.log("Usando fallback finale - mossa casuale");
  const moves = game.moves({ verbose: true });
  if (moves.length > 0) {
    const randomMove = moves[Math.floor(Math.random() * moves.length)];
    game.move(randomMove);
    board.position(game.fen());
    if (typeof registerNewMove === "function") registerNewMove();
    document.getElementById("ai-move").innerText =
      randomMove.san + " (casuale)";
    console.log("✅ Mossa IA (fallback):", randomMove.san);
  }
}

// Cambia livello AI
function updateDifficulty() {
  aiDepth = document.getElementById("difficulty").value;
}

// Reset partita
function resetGame() {
  pendingPlayAiMove = false;
  game = new Chess();
  board.position("start");
  if (typeof resetMoveNavigation === "function") resetMoveNavigation();
  document.getElementById("ai-move").innerText = "In attesa...";
}
