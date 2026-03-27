let navbarResizeBound = false;
const ASSET_VERSION = window.APP_VERSION || Date.now().toString();
const withAssetVersion = (path) => `${path}?v=${ASSET_VERSION}`;
let redoMoves = [];

function updateMoveNavButtons() {
  const controls = document.querySelectorAll(".move-nav-controls");
  if (!controls.length || !game) return;

  const hasBack = game.history().length > 0;
  const hasForward = redoMoves.length > 0;

  controls.forEach((group) => {
    const startBtn = group.querySelector('[data-nav="start"]');
    const backBtn = group.querySelector('[data-nav="back"]');
    const forwardBtn = group.querySelector('[data-nav="forward"]');
    const endBtn = group.querySelector('[data-nav="end"]');

    if (startBtn) startBtn.disabled = !hasBack;
    if (backBtn) backBtn.disabled = !hasBack;
    if (forwardBtn) forwardBtn.disabled = !hasForward;
    if (endBtn) endBtn.disabled = !hasForward;
  });
}

function updateTurnIndicator() {
  const indicator = document.getElementById("turn-indicator");
  if (!indicator || !game) return;

  if (typeof window.getTurnIndicatorText === "function") {
    const customIndicator = window.getTurnIndicatorText();
    if (customIndicator) {
      indicator.innerText = customIndicator;
      indicator.classList.toggle("black-turn", game.turn() === "b");
      return;
    }
  }

  const isWhiteTurn = game.turn() === "w";
  indicator.innerText = `Tocca a: ${isWhiteTurn ? "Bianco" : "Nero"}`;
  indicator.classList.toggle("black-turn", !isWhiteTurn);
}

function syncBoardToGame() {
  if (board && game) {
    board.position(game.fen());
  }
  if (typeof analysisQueueLiveEval === "function") {
    analysisQueueLiveEval();
  }
  updateMoveNavButtons();
  updateTurnIndicator();
}

function resetMoveNavigation() {
  redoMoves = [];
  updateMoveNavButtons();
  updateTurnIndicator();
}

function registerNewMove() {
  redoMoves = [];
  if (typeof analysisQueueLiveEval === "function") {
    analysisQueueLiveEval();
  }
  updateMoveNavButtons();
  updateTurnIndicator();
}

function moveToStart() {
  if (!game) return;

  while (true) {
    const undone = game.undo();
    if (!undone) break;
    redoMoves.push(undone);
  }
  syncBoardToGame();
}

function moveBack() {
  if (!game) return;

  const undone = game.undo();
  if (undone) {
    redoMoves.push(undone);
    syncBoardToGame();
  }
}

function moveForward() {
  if (!game || redoMoves.length === 0) return;

  const nextMove = redoMoves.pop();
  if (nextMove) {
    game.move(nextMove);
    syncBoardToGame();
  }
}

function moveToEnd() {
  if (!game || redoMoves.length === 0) return;

  while (redoMoves.length > 0) {
    game.move(redoMoves.pop());
  }
  syncBoardToGame();
}

function setPositionToolStatus(message, isError = false) {
  const status = document.getElementById("fen-pgn-status");
  if (!status) return;

  status.innerText = message;
  status.classList.toggle("error", isError);
}

function applyFenFromInput() {
  if (!game || !board) return;

  const fenInput = document.getElementById("fen-input");
  if (!fenInput) return;

  const fen = fenInput.value.trim();
  if (!fen) {
    setPositionToolStatus("Inserisci una FEN valida.", true);
    return;
  }

  let loaded = false;
  try {
    loaded = game.load(fen);
  } catch (e) {
    loaded = false;
  }

  if (!loaded) {
    setPositionToolStatus("FEN non valida.", true);
    return;
  }

  resetMoveNavigation();
  syncBoardToGame();
  setPositionToolStatus("FEN caricata correttamente.");
}

function importPgnFromInput() {
  if (!game || !board) return;

  const pgnInput = document.getElementById("pgn-input");
  if (!pgnInput) return;

  const pgnRaw = pgnInput.value.trim();
  if (!pgnRaw) {
    setPositionToolStatus("Inserisci un PGN da importare.", true);
    return;
  }

  // Supporta anche notazione italiana (C,A,T,D,R) convertendola in SAN inglese.
  const pgn = normalizeImportedPgn(pgnRaw);

  game.reset();

  let loaded = false;
  try {
    if (typeof game.load_pgn === "function") {
      loaded = game.load_pgn(pgn, { sloppy: true });
    } else if (typeof game.loadPgn === "function") {
      loaded = game.loadPgn(pgn, { sloppy: true });
    }
  } catch (e) {
    loaded = false;
  }

  if (!loaded) {
    game.reset();
    syncBoardToGame();
    setPositionToolStatus("PGN non valido.", true);
    return;
  }

  resetMoveNavigation();
  syncBoardToGame();
  setPositionToolStatus("PGN importato correttamente.");

  // Non avviare analisi automaticamente: l'utente decide quando premere il pulsante.
}

function normalizeImportedPgn(rawPgn) {
  const pieceMap = {
    C: "N", // Cavallo -> Knight
    A: "B", // Alfiere -> Bishop
    T: "R", // Torre -> Rook
    D: "Q", // Donna -> Queen
    R: "K", // Re -> King
  };

  const tokens = rawPgn.split(/\s+/).filter(Boolean);
  const hasItalianMarkers = tokens.some((token) => /^[CATD]/.test(token));
  if (!hasItalianMarkers) {
    // PGN gia in notazione inglese SAN: non alterare nulla.
    return rawPgn.trim();
  }

  return tokens
    .map((token) => {
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) return token;
      if (/^\d+\.+$/.test(token)) return token;

      const first = token[0];
      if (pieceMap[first]) {
        return pieceMap[first] + token.slice(1);
      }
      return token;
    })
    .join(" ")
    .trim();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "absolute";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

async function copyCurrentFen() {
  if (!game) return;

  try {
    await copyTextToClipboard(game.fen());
    setPositionToolStatus("FEN copiata negli appunti.");
  } catch (e) {
    setPositionToolStatus("Impossibile copiare la FEN.", true);
  }
}

async function exportCurrentPgn() {
  if (!game) return;

  let pgnText = "";
  if (typeof game.pgn === "function") {
    pgnText = game.pgn();
  }

  if (!pgnText || !pgnText.trim()) {
    setPositionToolStatus("Nessun PGN da esportare.", true);
    return;
  }

  try {
    await copyTextToClipboard(pgnText);
    setPositionToolStatus("PGN copiato negli appunti.");
  } catch (e) {
    setPositionToolStatus("Impossibile esportare il PGN.", true);
  }
}

function syncAppOffsetWithNavbar() {
  const navbar = document.querySelector(".navbar");
  const app = document.getElementById("app");
  if (!navbar || !app) return;

  app.style.marginTop = `${navbar.offsetHeight + 12}px`;
}

function closeNavbarMenu() {
  const links = document.getElementById("main-nav-links");
  const toggle = document.querySelector(".nav-toggle");
  if (!links) return;

  links.classList.remove("open");
  if (toggle) {
    toggle.setAttribute("aria-expanded", "false");
  }
  syncAppOffsetWithNavbar();
}

function toggleNavbarMenu() {
  const links = document.getElementById("main-nav-links");
  const toggle = document.querySelector(".nav-toggle");
  if (!links) return;

  const isOpen = links.classList.toggle("open");
  if (toggle) {
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }
  syncAppOffsetWithNavbar();
}

function initNavbar() {
  closeNavbarMenu();
  syncAppOffsetWithNavbar();

  if (!navbarResizeBound) {
    window.addEventListener("resize", () => {
      if (window.innerWidth > 760) {
        closeNavbarMenu();
      } else {
        syncAppOffsetWithNavbar();
      }
    });
    navbarResizeBound = true;
  }
}

function loadPage(page) {
  board = null;
  if (typeof Chess !== "undefined") {
    game = new Chess();
    resetMoveNavigation();
  }
  if (stockfish) {
    try {
      stockfish.terminate();
    } catch (e) {}
    stockfish = null;
  }

  fetch(withAssetVersion(`pages/${page}.html`), { cache: "no-store" })
    .then((res) => res.text())
    .then((html) => {
      const app = document.getElementById("app");

      // Inserisce la pagina
      app.innerHTML = html;

      // Applica animazione
      app.classList.add("fade-in");

      // Rimuove l’animazione dopo 400ms
      setTimeout(() => {
        app.classList.remove("fade-in");
      }, 400);

      setTimeout(() => {
        const scripts = app.querySelectorAll("script");
        scripts.forEach((script) => {
          if (script.innerHTML) {
            eval(script.innerHTML);
          }
        });
      }, 300);

      // Torna in alto
      window.scrollTo(0, 0);

      // Mantiene la distanza corretta dal menu in alto
      syncAppOffsetWithNavbar();
      updateMoveNavButtons();
      updateTurnIndicator();
    });
}
