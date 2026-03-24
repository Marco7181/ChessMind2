let solutionMoves = [];
let currentMoveIndex = 0;
let puzzleLibrary = [];
let puzzleLibraryLoaded = false;
let puzzleCursor = -1;
let puzzleUserSide = "w";
let puzzleAutoSide = "b";
let currentPuzzle = null;
let puzzleStartFen = null;
let puzzleStartDescription = "Trova la mossa migliore.";
let puzzleStartUserMovesToFind = 0;
let autoRetryTimer = null;
let pendingPuzzleUserMove = null;
const supportedPuzzleThemes = new Set([
  "mate",
  "matein1",
  "matein2",
  "matein3",
  "fork",
  "pin",
  "skewer",
  "hangingpiece",
  "doublecheck",
  "discoveredattack",
  "deflection",
  "attraction",
  "interference",
  "sacrifice",
  "trappedpiece",
  "xrayattack",
]);
const excludedPuzzleThemes = new Set(
  ["quietmove", "defensivemove", "oneMove"].map((theme) => theme.toLowerCase()),
);

function updateRetryButtonState(disabled) {
  const retryButton = document.getElementById("retry-puzzle-btn");
  if (retryButton) {
    retryButton.disabled = !!disabled;
  }
}

function setPuzzleStartState(fen, description, userMovesToFind) {
  puzzleStartFen = fen || null;
  puzzleStartDescription = description || "Trova la mossa migliore.";
  puzzleStartUserMovesToFind = Math.max(0, Number(userMovesToFind) || 0);
  updateRetryButtonState(!puzzleStartFen);
}

function finishPuzzle(message = "Puzzle risolto.") {
  if (autoRetryTimer) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }
  pendingPuzzleUserMove = null;
  document.getElementById("result").innerText = message;
}

function scheduleAutoRetry(delayMs = 250) {
  if (!puzzleStartFen) return;

  if (autoRetryTimer) {
    clearTimeout(autoRetryTimer);
  }

  autoRetryTimer = setTimeout(() => {
    autoRetryTimer = null;
    retryPuzzle();
  }, delayMs);
}

function resolvePuzzleBackendBaseUrl() {
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

function normalizeUci(move) {
  return (move || "").toLowerCase().trim();
}

function normalizePuzzleThemes(themes) {
  return Array.isArray(themes)
    ? themes
        .map((theme) =>
          String(theme || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean)
    : [];
}

function isSupportedPuzzleForApp(puzzle) {
  if (
    !puzzle ||
    typeof puzzle.fen !== "string" ||
    !Array.isArray(puzzle.solution)
  ) {
    return false;
  }

  const themes = normalizePuzzleThemes(puzzle.themes);
  const rating = Number(puzzle.rating);
  const moveCount = puzzle.solution.length;

  if (moveCount < 4 || moveCount > 12) return false;
  if (Number.isFinite(rating) && (rating < 1200 || rating > 2800)) return false;
  if (themes.some((theme) => excludedPuzzleThemes.has(theme))) return false;
  if (
    themes.length > 0 &&
    !themes.some((theme) => supportedPuzzleThemes.has(theme))
  ) {
    return false;
  }

  return true;
}

function orientPuzzleBoard() {
  if (board && typeof board.orientation === "function") {
    board.orientation(puzzleUserSide === "w" ? "white" : "black");
  }
}

function getSideLabel(side) {
  return side === "b" ? "Nero" : "Bianco";
}

function updatePuzzleLabels(userMovesToFind, description) {
  const descriptionElement = document.getElementById("puzzle-desc");
  const turnIndicator = document.getElementById("turn-indicator");
  const moveSide = getSideLabel(puzzleUserSide);

  if (descriptionElement) {
    descriptionElement.innerText = `${description} (Muovi il ${moveSide}; mosse da trovare: ${userMovesToFind})`;
  }

  if (turnIndicator) {
    turnIndicator.innerText = `Muovi: ${moveSide}`;
    turnIndicator.classList.toggle("black-turn", puzzleUserSide === "b");
  }
}

window.getTurnIndicatorText = function () {
  const indicator = document.getElementById("puzzle-container");
  if (!indicator) return null;
  return `Muovi: ${getSideLabel(puzzleUserSide)}`;
};

function toUciFromDrop(source, target, promotion) {
  return `${source}${target}${promotion || ""}`.toLowerCase();
}

function movesMatchUci(actualMove, expectedMove) {
  const normalizedActual = normalizeUci(actualMove);
  const normalizedExpected = normalizeUci(expectedMove);

  if (!normalizedActual || !normalizedExpected) return false;
  if (normalizedActual === normalizedExpected) return true;

  return (
    normalizedActual.substring(0, 4) === normalizedExpected.substring(0, 4)
  );
}

function loadPgnOnGame(chessGame, pgnText) {
  if (typeof chessGame.load_pgn === "function") {
    return chessGame.load_pgn(pgnText, { sloppy: true });
  }
  if (typeof chessGame.loadPgn === "function") {
    return chessGame.loadPgn(pgnText, { sloppy: true });
  }
  return false;
}

function buildFenFromPgnAtPly(pgnText, initialPly) {
  const replay = new Chess();
  const loaded = loadPgnOnGame(replay, pgnText);
  if (!loaded) return null;

  const history = replay.history({ verbose: true });
  const boardAtPly = new Chess();
  const limit = Math.min(Number(initialPly) || 0, history.length);

  for (let i = 0; i < limit; i++) {
    boardAtPly.move(history[i]);
  }

  return boardAtPly.fen();
}

function normalizeLichessPayload(data) {
  if (!data) return null;

  if (typeof data.fen === "string" && Array.isArray(data.solution)) {
    return {
      id: data.id || "lichess-daily",
      description: data.description || "Lichess Daily",
      fen: data.fen,
      solution: data.solution,
    };
  }

  const puzzle = data.puzzle || {};
  const gameData = data.game || {};
  if (!puzzle.solution || !Array.isArray(puzzle.solution) || !gameData.pgn) {
    return null;
  }

  const fen = buildFenFromPgnAtPly(gameData.pgn, puzzle.initialPly || 0);
  if (!fen) return null;

  const themes = Array.isArray(puzzle.themes) ? puzzle.themes : [];
  const description = themes.length
    ? `Lichess Daily - ${themes.slice(0, 3).join(", ")}`
    : "Lichess Daily";

  return {
    id: puzzle.id || "lichess-daily",
    description,
    fen,
    solution: puzzle.solution,
  };
}

async function fetchLichessDailyPuzzle() {
  const sources = [
    `${resolvePuzzleBackendBaseUrl()}/puzzles/lichess/daily`,
    "https://lichess.org/api/puzzle/daily",
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source, { cache: "no-store" });
      if (!response.ok) continue;
      const data = await response.json();
      const normalized = normalizeLichessPayload(data);
      if (normalized) return normalized;
    } catch (error) {
      // prova la sorgente successiva
    }
  }

  return null;
}

async function fetchBackendPuzzleLibrary() {
  const url = `${resolvePuzzleBackendBaseUrl()}/puzzles/lichess/library?limit=200`;

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return [];

    const data = await response.json();
    const puzzles = Array.isArray(data?.puzzles) ? data.puzzles : [];
    return puzzles.filter((p) => isSupportedPuzzleForApp(p));
  } catch (error) {
    return [];
  }
}

function applyPuzzleFromLibrary(puzzle) {
  const validateGame = new Chess();
  let loaded = false;
  try {
    loaded = validateGame.load(puzzle.fen);
  } catch (e) {
    loaded = false;
  }
  if (!loaded) return false;

  const normalizedSolution = (puzzle.solution || []).map((m) =>
    normalizeUci(m),
  );
  if (normalizedSolution.length < 2) return false;

  const setupMove = normalizedSolution[0];
  const setupValid = validateGame.move({
    from: setupMove.substring(0, 2),
    to: setupMove.substring(2, 4),
    promotion: setupMove.substring(4, 5) || "q",
  });
  if (!setupValid) return false;

  const playableSolution = normalizedSolution.slice(1);
  const userSide = validateGame.turn();
  let userMovesToFind = 0;
  const normalizedThemes = normalizePuzzleThemes(puzzle.themes);
  const isMatePuzzle = normalizedThemes.some((theme) =>
    theme.startsWith("mate"),
  );

  for (const moveUci of playableSolution) {
    if (moveUci.length < 4) return false;

    if (validateGame.turn() === userSide) {
      userMovesToFind++;
    }

    const valid = validateGame.move({
      from: moveUci.substring(0, 2),
      to: moveUci.substring(2, 4),
      promotion: moveUci.substring(4, 5) || "q",
    });

    if (!valid) return false;
  }

  const isCheckmate =
    typeof validateGame.in_checkmate === "function" &&
    validateGame.in_checkmate();
  if (isMatePuzzle && !isCheckmate) return false;
  if (isCheckmate) {
    const winningSide = validateGame.turn() === "w" ? "b" : "w";
    if (winningSide !== userSide) return false;
  }

  loaded = false;
  try {
    loaded = game.load(puzzle.fen);
  } catch (e) {
    loaded = false;
  }
  if (!loaded) return false;

  const setupApplied = game.move({
    from: setupMove.substring(0, 2),
    to: setupMove.substring(2, 4),
    promotion: setupMove.substring(4, 5) || "q",
  });
  if (!setupApplied) return false;

  puzzleUserSide = userSide;
  puzzleAutoSide = puzzleUserSide === "w" ? "b" : "w";
  currentPuzzle = {
    id: puzzle.id || null,
    description: puzzle.description || "Trova la mossa migliore.",
    fen: game.fen(),
    solution: [...playableSolution],
    userMovesToFind,
  };
  setPuzzleStartState(
    currentPuzzle.fen,
    currentPuzzle.description,
    currentPuzzle.userMovesToFind,
  );

  solutionMoves = playableSolution;
  currentMoveIndex = 0;

  orientPuzzleBoard();
  board.position(game.fen());
  updatePuzzleLabels(userMovesToFind, currentPuzzle.description);
  document.getElementById("result").innerText = "";
  updateRetryButtonState(false);
  if (typeof resetMoveNavigation === "function") resetMoveNavigation();
  return true;
}

function retryPuzzle() {
  if (autoRetryTimer) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }

  pendingPuzzleUserMove = null;

  if (!puzzleStartFen) {
    document.getElementById("result").innerText = "Nessun puzzle da riprovare.";
    return;
  }

  let loaded = false;
  try {
    loaded = game.load(puzzleStartFen);
  } catch (e) {
    loaded = false;
  }
  if (!loaded) return;

  if (currentPuzzle && Array.isArray(currentPuzzle.solution)) {
    solutionMoves = [...currentPuzzle.solution];
  }
  currentMoveIndex = 0;
  puzzleUserSide = game.turn();
  puzzleAutoSide = puzzleUserSide === "w" ? "b" : "w";

  orientPuzzleBoard();
  board.position(game.fen());
  updatePuzzleLabels(puzzleStartUserMovesToFind, puzzleStartDescription);
  document.getElementById("result").innerText = "Riprova il puzzle.";
  if (typeof resetMoveNavigation === "function") resetMoveNavigation();
}

function showPuzzleSolution() {
  if (
    !game ||
    !board ||
    !Array.isArray(solutionMoves) ||
    !solutionMoves.length
  ) {
    document.getElementById("result").innerText =
      "Puzzle non pronto. Premi Nuovo Puzzle.";
    return;
  }

  const nextMoveUci = normalizeUci(solutionMoves[currentMoveIndex]);
  if (!nextMoveUci || nextMoveUci.length < 4) {
    document.getElementById("result").innerText =
      "Nessuna soluzione disponibile in questo momento.";
    return;
  }

  const movePayload = {
    from: nextMoveUci.substring(0, 2),
    to: nextMoveUci.substring(2, 4),
    promotion: nextMoveUci.substring(4, 5) || "q",
  };

  let readableMove = nextMoveUci;
  try {
    const preview = new Chess(game.fen());
    const moveObj = preview.move(movePayload);
    if (!moveObj) {
      document.getElementById("result").innerText =
        "Impossibile applicare la soluzione in questa posizione.";
      return;
    }

    if (moveObj.san) {
      readableMove = `${moveObj.san} (${nextMoveUci})`;
    }
  } catch (e) {
    document.getElementById("result").innerText =
      "Impossibile applicare la soluzione in questa posizione.";
    return;
  }

  document.getElementById("result").innerText = `Soluzione: ${readableMove}`;
}

async function loadPuzzleLibrary() {
  if (puzzleLibraryLoaded) return;

  try {
    const backendPuzzles = await fetchBackendPuzzleLibrary();
    if (backendPuzzles.length > 0) {
      puzzleLibrary = backendPuzzles;
      return;
    }

    const puzzlePath =
      typeof withAssetVersion === "function"
        ? withAssetVersion("data/puzzles.json")
        : "data/puzzles.json";

    const response = await fetch(puzzlePath, { cache: "no-store" });
    if (!response.ok) throw new Error("puzzle file not available");

    const data = await response.json();
    if (Array.isArray(data)) {
      puzzleLibrary = data.filter((p) => isSupportedPuzzleForApp(p));
    }
  } catch (error) {
    puzzleLibrary = [];
  } finally {
    puzzleLibraryLoaded = true;
  }
}

// Carica Stockfish WASM
function puzzleLoadStockfish() {
  const candidates = ["components/stockfish.js", "../components/stockfish.js"];

  let worker = null;
  for (const path of candidates) {
    try {
      worker = new Worker(path);
      break;
    } catch (e) {
      worker = null;
    }
  }

  if (!worker) {
    stockfish = null;
    return;
  }

  stockfish = worker;
  stockfish.onerror = function () {
    stockfish = null;
  };

  stockfish.onmessage = function (event) {
    const line = event.data;

    if (typeof line === "string" && line.includes(" pv ")) {
      const pv = line.split(" pv ")[1];
      solutionMoves = pv.split(" ").slice(0, 4); // 2 mosse per lato
      currentMoveIndex = 0;
    }
  };
}

// Inizializza la scacchiera
function puzzleInitBoard() {
  board = Chessboard("board", {
    draggable: true,
    position: "start",
    onDrop: puzzleOnDrop,
    onSnapEnd: puzzleOnSnapEnd,
    pieceTheme:
      "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
  });
}

function puzzleOnSnapEnd() {
  if (pendingPuzzleUserMove) {
    const userMove = pendingPuzzleUserMove;
    pendingPuzzleUserMove = null;
    checkMove(userMove);
  }
}

function playPuzzleSequenceMove(moveUci) {
  if (!moveUci || moveUci.length < 4) return false;

  const played = game.move({
    from: moveUci.substring(0, 2),
    to: moveUci.substring(2, 4),
    promotion: moveUci.substring(4, 5) || "q",
  });

  if (!played) return false;

  board.position(game.fen());
  if (typeof registerNewMove === "function") registerNewMove();
  return true;
}

function advancePuzzleAfterUserMove() {
  while (
    currentMoveIndex < solutionMoves.length &&
    game.turn() === puzzleAutoSide
  ) {
    const autoMove = normalizeUci(solutionMoves[currentMoveIndex]);
    if (!playPuzzleSequenceMove(autoMove)) {
      finishPuzzle("Puzzle non valido. Caricane un altro.");
      return;
    }
    currentMoveIndex++;
  }

  if (currentMoveIndex >= solutionMoves.length) {
    finishPuzzle("Puzzle risolto.");
    return;
  }

  document.getElementById("result").innerText = "Bravo! Continua.";
}

// Quando l’utente muove un pezzo
function puzzleOnDrop(source, target) {
  if (!game || !board || game.turn() !== puzzleUserSide) {
    return "snapback";
  }

  const attemptedMove = toUciFromDrop(source, target);
  const correctMove = normalizeUci(solutionMoves[currentMoveIndex]);

  if (correctMove && !movesMatchUci(attemptedMove, correctMove)) {
    document.getElementById("result").innerText =
      "Mossa sbagliata. Riprovo automaticamente...";
    scheduleAutoRetry();
    return "snapback";
  }

  const move = game.move({
    from: source,
    to: target,
    promotion: "q",
  });

  if (move === null) return "snapback";

  pendingPuzzleUserMove = toUciFromDrop(source, target, move.promotion);
}

// Controlla se la mossa è corretta
function checkMove(userMove) {
  const correctMove = normalizeUci(solutionMoves[currentMoveIndex]);

  if (!correctMove) {
    finishPuzzle("Puzzle risolto.");
    return;
  }

  if (movesMatchUci(userMove, correctMove)) {
    currentMoveIndex++;
    if (typeof registerNewMove === "function") registerNewMove();
    advancePuzzleAfterUserMove();
  } else {
    document.getElementById("result").innerText =
      "Mossa sbagliata. Premi Riprova.";
  }
}

// Genera un nuovo puzzle
async function nextPuzzle() {
  if (autoRetryTimer) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }

  pendingPuzzleUserMove = null;

  document.getElementById("result").innerText = "";
  updateRetryButtonState(true);
  await loadPuzzleLibrary();

  game = new Chess();
  puzzleUserSide = game.turn();
  puzzleAutoSide = puzzleUserSide === "w" ? "b" : "w";

  if (puzzleLibrary.length > 0) {
    for (let tries = 0; tries < puzzleLibrary.length; tries++) {
      puzzleCursor = (puzzleCursor + 1) % puzzleLibrary.length;
      const loaded = applyPuzzleFromLibrary(puzzleLibrary[puzzleCursor]);
      if (loaded) return;
    }
  }

  const lichessPuzzle = await fetchLichessDailyPuzzle();
  if (lichessPuzzle) {
    game = new Chess();
    const loaded = applyPuzzleFromLibrary(lichessPuzzle);
    if (loaded) return;
  }

  document.getElementById("puzzle-desc").innerText =
    "Calcola la mossa migliore! (fallback)";
  setPuzzleStartState(game.fen(), "Calcola la mossa migliore! (fallback)", 0);
  orientPuzzleBoard();
  board.position(game.fen());
  currentPuzzle = null;
  if (typeof resetMoveNavigation === "function") resetMoveNavigation();

  if (stockfish) {
    stockfish.postMessage("position fen " + game.fen());
    stockfish.postMessage("go depth 16");
  }
}

window.retryPuzzle = retryPuzzle;
window.nextPuzzle = nextPuzzle;
window.showPuzzleSolution = showPuzzleSolution;

// Avvio
// (Rimosso per evitare esecuzione prematura)
