function analysisBackendUrl() {
  const queryValue = new URLSearchParams(window.location.search).get(
    "backendUrl",
  );
  const storedValue = localStorage.getItem("chessmind_backend_url");
  const globalValue = window.CHESSMIND_BACKEND_URL;
  const rawBaseUrl = queryValue || storedValue || globalValue;

  if (rawBaseUrl && !/^(undefined|null)$/i.test(String(rawBaseUrl).trim())) {
    const normalizedBase = String(rawBaseUrl)
      .trim()
      .replace(/\/$/, "")
      .replace(/\/(analysis\/deep|analysis\/game|openings\/detect)$/i, "");
    return `${normalizedBase}/analysis/deep`;
  }

  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  const isAndroidClient = /Android/i.test(navigator.userAgent || "");

  if (protocol === "http:" || protocol === "https:") {
    const resolvedHost = hostname || "127.0.0.1";
    return `${protocol}//${resolvedHost}:8000/analysis/deep`;
  }

  if (isAndroidClient) {
    return "http://10.0.2.2:8000/analysis/deep";
  }

  return "http://127.0.0.1:8000/analysis/deep";
}

function analysisOpeningsUrl() {
  return analysisBackendUrl().replace("/analysis/deep", "/openings/detect");
}

function analysisDeepEndpointCandidates() {
  const candidates = [analysisBackendUrl()];
  const isAndroidClient = /Android/i.test(navigator.userAgent || "");

  candidates.push("http://127.0.0.1:8000/analysis/deep");
  if (isAndroidClient) {
    candidates.push("http://10.0.2.2:8000/analysis/deep");
  }

  return Array.from(new Set(candidates));
}

async function analysisFetchDeepWithRetry(queryString, fetchOptions) {
  const endpoints = analysisDeepEndpointCandidates();
  let lastError = null;
  let hadTimeout = false;
  const attempts = [];

  for (const endpoint of endpoints) {
    const url = `${endpoint}?${queryString}`;
    try {
      const response = await Promise.race([
        fetch(url, fetchOptions),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("AnalysisTimeout")), 45000),
        ),
      ]);

      let data;
      try {
        data = await response.json();
      } catch (_jsonErr) {
        throw new Error(`Risposta non valida dal backend: ${endpoint}`);
      }

      if (!response.ok || data?.error) {
        throw new Error(
          data?.error || `Errore backend (${response.status}) su ${endpoint}`,
        );
      }

      return { data, endpoint };
    } catch (err) {
      if (err?.name === "AbortError") {
        throw err;
      }
      if (err?.message === "AnalysisTimeout") {
        hadTimeout = true;
      }
      attempts.push(`${endpoint} -> ${err?.message || "errore sconosciuto"}`);
      lastError = err;
    }
  }

  if (hadTimeout) {
    const detail = attempts.slice(0, 3).join(" | ");
    throw new Error(`AnalysisTimeout (${detail})`);
  }
  const detail = attempts.slice(0, 3).join(" | ");
  throw lastError || new Error(`Backend non raggiungibile (${detail})`);
}

function analysisRenderOpening(data) {
  const nameEl = document.getElementById("opening-name");
  const ecoEl = document.getElementById("opening-eco");
  const lineEl = document.getElementById("opening-line");
  if (!nameEl || !ecoEl || !lineEl) return;

  if (!data || !data.found) {
    nameEl.innerText = "Fuori libro";
    ecoEl.innerText = "ECO: -";
    lineEl.innerText = "";
    return;
  }

  nameEl.innerText = data.name || "Apertura rilevata";
  ecoEl.innerText = `ECO: ${data.eco || "-"} | Completamento: ${data.completion_pct || 0}%`;
  lineEl.innerText = (data.line || []).join(" ");
}

async function analysisDetectOpening() {
  if (!game) return;
  const moves = analysisGetSanMoves();
  if (!moves.length) {
    analysisRenderOpening(null);
    return;
  }

  try {
    const response = await fetch(analysisOpeningsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves }),
      mode: "cors",
    });
    if (!response.ok) return;
    const data = await response.json();
    analysisRenderOpening(data);
  } catch (_err) {
    // Non blocchiamo il flusso analisi se il servizio aperture non risponde.
  }
}

let analysisAbortController = null;
let analysisRequestToken = 0;
let analysisUseLocalWorkerScores = false;
let analysisLiveEvalTimer = null;
let analysisLiveEvalTurn = "w";
let analysisLiveEngineFen = "";
let analysisLiveEngineWatchdog = null;
let analysisLastLiveInfoAt = 0;
let analysisLiveTargetDepth = 25;
let analysisLiveDepthReached = 0;
let analysisLiveComplete = false;
let analysisLiveHadScore = false;
let analysisEngineUciReady = false;
let analysisEngineReady = false;
let analysisPendingFen = "";
let analysisPendingForceRestart = false;
let analysisUseBackendLiveEval = false;
let analysisLiveBackendLoop = null;
let analysisLiveBackendBusy = false;

function analysisCpToWhitePct(cp, mate) {
  if (Number.isFinite(mate)) {
    return mate > 0 ? 98 : 2;
  }
  const bounded = Math.max(-600, Math.min(600, Number(cp) || 0));
  return Math.max(2, Math.min(98, 50 + bounded / 12));
}

function analysisUpdateEvalBar(cp, mate) {
  const blackEl = document.getElementById("eval-bar-black");
  const whiteEl = document.getElementById("eval-bar-white");
  const markerEl = document.getElementById("eval-bar-marker");
  const scoreEl = document.getElementById("eval-bar-score");
  if (!blackEl || !whiteEl || !markerEl) return;

  const whitePct = analysisCpToWhitePct(cp, mate);
  const blackPct = 100 - whitePct;
  blackEl.style.height = `${blackPct}%`;
  whiteEl.style.height = `${whitePct}%`;
  markerEl.style.top = `${blackPct}%`;

  if (scoreEl) {
    if (Number.isFinite(mate)) {
      scoreEl.innerText = `M${mate}`;
    } else {
      scoreEl.innerText = analysisFormatCpScore(cp);
    }
  }
}

function analysisQueueLiveEval() {
  if (!game) return;

  if (analysisUseBackendLiveEval) {
    analysisUpdateLiveEvalFromBackend(true);
    return;
  }

  if (!stockfish) return;

  if (analysisLiveEvalTimer) {
    clearTimeout(analysisLiveEvalTimer);
  }

  analysisLiveEvalTurn = game.turn();
  analysisLiveEvalTimer = setTimeout(() => {
    analysisStartContinuousLiveEval(false);
  }, 10);
}

async function analysisUpdateLiveEvalFromBackend(force = false) {
  if (!game) return;
  if (!force && analysisLiveBackendBusy) return;

  analysisLiveBackendBusy = true;
  try {
    const query = `fen=${encodeURIComponent(game.fen())}&depth=10&multi_pv=1&detail_level=breve&_=${Date.now()}`;
    const url = `${analysisBackendUrl()}?${query}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return;

    const data = await response.json();
    const evaluation = data?.evaluation;
    if (!evaluation) return;

    const evalEl = document.getElementById("eval");
    if (evaluation.type === "cp") {
      const cp = Number(evaluation.value || 0);
      if (evalEl) evalEl.innerText = analysisFormatCpScore(cp);
      analysisUpdateEvalBar(cp, null);
    } else if (evaluation.type === "mate") {
      const mate = Number(evaluation.value || 0);
      if (evalEl) evalEl.innerText = analysisFormatMateScore(mate);
      analysisUpdateEvalBar(null, mate);
    }
  } catch (_err) {
    // Mantieni silenzioso il fallback live.
  } finally {
    analysisLiveBackendBusy = false;
  }
}

function analysisStartBackendLiveLoop() {
  if (analysisLiveBackendLoop) return;
  analysisUseBackendLiveEval = true;
  analysisSetStatus("", false);
  analysisUpdateLiveEvalFromBackend(true);
  analysisLiveBackendLoop = setInterval(() => {
    analysisUpdateLiveEvalFromBackend(false);
  }, 1200);
}

function analysisStopBackendLiveLoop() {
  if (analysisLiveBackendLoop) {
    clearInterval(analysisLiveBackendLoop);
    analysisLiveBackendLoop = null;
  }
  analysisUseBackendLiveEval = false;
}

function analysisStartContinuousLiveEval(forceRestart = false) {
  if (analysisUseBackendLiveEval) {
    if (forceRestart) {
      analysisUpdateLiveEvalFromBackend(true);
    }
    return;
  }

  if (!game || !stockfish) return;

  const fen = game.fen();
  if (!analysisEngineReady) {
    analysisPendingFen = fen;
    analysisPendingForceRestart = forceRestart;
    return;
  }

  // Evita restart multipli sulla stessa posizione: lascia proseguire la ricerca in corso.
  if (!forceRestart && fen === analysisLiveEngineFen) {
    return;
  }

  analysisLiveEngineFen = fen;
  analysisLiveEvalTurn = game.turn();
  analysisLiveDepthReached = 0;
  analysisLiveComplete = false;
  analysisLiveHadScore = false;
  try {
    stockfish.postMessage("stop");
    stockfish.postMessage("position fen " + fen);
    stockfish.postMessage(`go depth ${analysisLiveTargetDepth}`);
    analysisLastLiveInfoAt = Date.now();
  } catch (_err) {
    // Ignora errori del worker: l'analisi backend resta disponibile.
  }
}

function analysisEnsureLiveEvalWatchdog() {
  if (analysisLiveEngineWatchdog) {
    clearInterval(analysisLiveEngineWatchdog);
  }

  analysisLiveEngineWatchdog = setInterval(() => {
    if (!game) return;
    if (analysisUseBackendLiveEval) {
      analysisUpdateLiveEvalFromBackend(false);
      return;
    }
    if (!stockfish) return;
    if (!analysisEngineReady) return;
    const staleMs = Date.now() - analysisLastLiveInfoAt;
    if (staleMs > 4500) {
      analysisStartContinuousLiveEval(true);
    }
  }, 2500);
}

function analysisSetRunButtonState(isRunning) {
  const runButton = document.querySelector(
    '.analysis-controls button.btn[onclick="analysisRunDeep()"]',
  );
  if (!runButton) return;

  runButton.disabled = !!isRunning;
  runButton.innerText = isRunning ? "Analisi in corso..." : "Analisi Posizione";
}

function analysisSetStatus(message, isError = false) {
  const status = document.getElementById("analysis-status");
  if (!status) return;

  status.innerText = message;
  status.classList.toggle("error", isError);
}

function analysisFormatCpScore(cpValue) {
  const value = Number(cpValue || 0) / 100;
  if (!Number.isFinite(value)) return "n/d";
  return value.toFixed(2);
}

function analysisFormatMateScore(mateValue) {
  const value = Number(mateValue || 0);
  if (!Number.isFinite(value)) return "n/d";
  return `M${value}`;
}

function analysisEscapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function analysisRenderBestMoves(items) {
  const list = document.getElementById("best-moves");
  if (!list) return;

  if (!items || !items.length) {
    list.innerHTML = "<li>Nessuna linea disponibile.</li>";
    return;
  }

  const linesHtml = items
    .map((line, idx) => {
      const move = line.move_san || line.move_uci || "-";
      const scoreCp = line.score_cp;
      const scoreMate = line.mate;
      const score =
        scoreMate !== null && scoreMate !== undefined
          ? analysisFormatMateScore(scoreMate)
          : scoreCp !== null && scoreCp !== undefined
            ? analysisFormatCpScore(scoreCp)
            : "n/d";
      const pv = (line.pv_san || []).length
        ? line.pv_san.join(" ")
        : (line.pv_uci || []).join(" ");
      const commentary = line.commentary || "";
      const commentaryHtml = commentary
        ? `<div class="analysis-line-commentary">${analysisEscapeHtml(commentary)}</div>`
        : "";
      return `<li><strong>#${idx + 1}</strong> ${analysisEscapeHtml(move)} (${analysisEscapeHtml(score)})<br/><span>${analysisEscapeHtml(pv)}</span>${commentaryHtml}</li>`;
    })
    .join("");

  list.innerHTML = linesHtml;
}

function analysisRenderTextList(containerId, items, emptyMessage) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!items || !items.length) {
    container.innerHTML = `<li>${emptyMessage}</li>`;
    return;
  }

  container.innerHTML = items.map((item) => `<li>${item}</li>`).join("");
}

function analysisRenderNarrative(items) {
  const container = document.getElementById("analysis-narrative");
  if (!container) return;

  if (!items || !items.length) {
    container.innerHTML = "<p>Nessun commento discorsivo disponibile.</p>";
    return;
  }

  container.innerHTML = items
    .map((item) => `<p>${analysisEscapeHtml(item)}</p>`)
    .join("");
}

function analysisRenderDeepAnalysis(data) {
  const evalEl = document.getElementById("eval");
  const summaryEl = document.getElementById("analysis-summary");
  const evalData = data?.evaluation;

  if (evalEl) {
    if (!evalData) {
      evalEl.innerText = "n/d";
      analysisUpdateEvalBar(0, null);
    } else if (evalData.type === "cp") {
      evalEl.innerText = analysisFormatCpScore(evalData.value);
      analysisUpdateEvalBar(Number(evalData.value || 0), null);
    } else if (evalData.type === "mate") {
      evalEl.innerText = analysisFormatMateScore(evalData.value);
      analysisUpdateEvalBar(null, Number(evalData.value || 0));
    } else {
      evalEl.innerText = "n/d";
      analysisUpdateEvalBar(0, null);
    }
  }

  analysisRenderBestMoves(data?.top_lines || []);
  analysisRenderTextList(
    "strategic-plan",
    data?.strategic_plan || [],
    "Nessun piano disponibile.",
  );
  analysisRenderTextList(
    "opponent-plan",
    data?.opponent_plan || [],
    "Nessun piano avversario disponibile.",
  );
  analysisRenderTextList(
    "tactical-alerts",
    data?.tactical_alerts || [],
    "Nessun alert tattico rilevante.",
  );
  analysisRenderNarrative(data?.narrative_sections || []);

  if (summaryEl) {
    summaryEl.innerText = data?.summary || "Analisi completata.";
  }
}

function analysisLoadStockfish() {
  const candidates = ["components/stockfish.js", "../components/stockfish.js"];
  for (const path of candidates) {
    try {
      stockfish = new Worker(path);
      break;
    } catch (e) {
      stockfish = null;
    }
  }

  if (!stockfish) {
    analysisStartBackendLiveLoop();
    return;
  }

  analysisEngineUciReady = false;
  analysisEngineReady = false;
  analysisPendingFen = "";
  analysisPendingForceRestart = false;

  stockfish.postMessage("uci");

  stockfish.onerror = function (err) {
    console.error("Stockfish worker error:", err);
    analysisStartBackendLiveLoop();
  };

  stockfish.onmessage = function (event) {
    const raw = event?.data;
    const line =
      typeof raw === "string"
        ? raw
        : raw === undefined || raw === null
          ? ""
          : String(raw);
    if (!line) return;

    if (line.includes("uciok")) {
      analysisEngineUciReady = true;
      stockfish.postMessage("isready");
      return;
    }

    if (line.includes("readyok")) {
      analysisStopBackendLiveLoop();
      analysisSetStatus("", false);
      analysisEngineReady = true;
      analysisLastLiveInfoAt = Date.now();
      if (game) {
        const fenToStart = analysisPendingFen || game.fen();
        analysisPendingFen = "";
        const force = analysisPendingForceRestart || true;
        analysisPendingForceRestart = false;
        analysisLiveEngineFen = "";
        try {
          stockfish.postMessage("position fen " + fenToStart);
          stockfish.postMessage(`go depth ${analysisLiveTargetDepth}`);
        } catch (_err) {
          analysisStartContinuousLiveEval(force);
        }
      }
      return;
    }

    const depthMatch = line.match(/\bdepth\s+(\d+)\b/);
    if (depthMatch) {
      const d = Number(depthMatch[1]);
      if (Number.isFinite(d) && d > analysisLiveDepthReached) {
        analysisLiveDepthReached = d;
        if (
          analysisLiveDepthReached >= analysisLiveTargetDepth &&
          !analysisLiveComplete
        ) {
          analysisLiveComplete = true;
          try {
            stockfish.postMessage("stop");
          } catch (_err) {}
        }
      }
    }
    if (line.includes("bestmove")) {
      analysisLiveComplete = true;
      if (!analysisLiveHadScore) {
        setTimeout(() => {
          analysisStartContinuousLiveEval(true);
        }, 0);
      }
    }

    // Eval live sempre attiva per la barra valutazione.
    if (line.includes("score cp")) {
      const cpRaw = Number((line.match(/score\s+cp\s+(-?\d+)/) || [])[1]);
      if (Number.isFinite(cpRaw)) {
        analysisLiveHadScore = true;
        analysisLastLiveInfoAt = Date.now();
        const whiteCp = analysisLiveEvalTurn === "w" ? cpRaw : -cpRaw;
        const evalEl = document.getElementById("eval");
        if (evalEl) {
          evalEl.innerText = analysisFormatCpScore(whiteCp);
        }
        analysisUpdateEvalBar(whiteCp, null);
      }
    } else if (line.includes("score mate")) {
      const mateRaw = Number((line.match(/score\s+mate\s+(-?\d+)/) || [])[1]);
      if (Number.isFinite(mateRaw)) {
        analysisLiveHadScore = true;
        analysisLastLiveInfoAt = Date.now();
        const whiteMate = analysisLiveEvalTurn === "w" ? mateRaw : -mateRaw;
        const evalEl = document.getElementById("eval");
        if (evalEl) {
          evalEl.innerText = analysisFormatMateScore(whiteMate);
        }
        analysisUpdateEvalBar(null, whiteMate);
      }
    }

    if (!analysisUseLocalWorkerScores) return;

    if (line.includes("score cp")) {
      const cp = line.split("score cp ")[1]?.split(" ")[0];
      if (cp) {
        document.getElementById("eval").innerText = analysisFormatCpScore(cp);
      }
    }

    if (line.includes(" pv ")) {
      const pv = line.split(" pv ")[1] || "";
      const moves = pv.split(" ").filter(Boolean);
      const list = document.getElementById("best-moves");
      if (!list) return;
      list.innerHTML = moves
        .slice(0, 8)
        .map((m, idx) => `<li><strong>#${idx + 1}</strong> ${m}</li>`)
        .join("");
    }
  };
}

function analysisLocalFallback(reasonMessage) {
  if (!game) {
    analysisSetStatus("Partita non inizializzata.", true);
    return;
  }

  if (!stockfish) {
    analysisSetStatus(
      reasonMessage ||
        "Backend non raggiungibile e Stockfish locale non disponibile.",
      true,
    );
    return;
  }

  analysisUseLocalWorkerScores = true;
  stockfish.postMessage("position fen " + game.fen());
  stockfish.postMessage("go depth 18");
  analysisSetStatus(
    reasonMessage || "Backend non disponibile: uso analisi locale WASM.",
    true,
  );
}

async function analysisRunDeep() {
  if (!game) return;

  analysisDetectOpening();

  if (
    analysisAbortController &&
    typeof analysisAbortController.abort === "function"
  ) {
    analysisAbortController.abort();
  }

  const requestToken = ++analysisRequestToken;
  analysisAbortController =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  analysisSetRunButtonState(true);

  const depthInput = document.getElementById("analysis-depth");
  const multiPvInput = document.getElementById("analysis-multipv");
  const detailLevelInput = document.getElementById("analysis-detail-level");
  const depth = Math.max(8, Math.min(24, Number(depthInput?.value || 16)));
  const multiPv = Math.max(1, Math.min(5, Number(multiPvInput?.value || 3)));
  const allowedLevels = ["breve", "coach", "approfondita"];
  const selectedLevel = String(
    detailLevelInput?.value || "coach",
  ).toLowerCase();
  const detailLevel = allowedLevels.includes(selectedLevel)
    ? selectedLevel
    : "coach";

  analysisSetStatus("Analisi approfondita in corso...");

  try {
    const queryString = `fen=${encodeURIComponent(game.fen())}&depth=${depth}&multi_pv=${multiPv}&detail_level=${encodeURIComponent(detailLevel)}&_=${Date.now()}`;
    const fetchOptions = {
      cache: "no-store",
    };
    if (analysisAbortController) {
      fetchOptions.signal = analysisAbortController.signal;
    }

    const { data } = await analysisFetchDeepWithRetry(
      queryString,
      fetchOptions,
    );

    if (requestToken !== analysisRequestToken) {
      return;
    }

    analysisUseLocalWorkerScores = false;
    analysisRenderDeepAnalysis(data);
    if (data.engine_error) {
      analysisSetStatus(`Analisi parziale: ${data.engine_error}`, true);
    } else {
      analysisSetStatus("Analisi completa disponibile.");
    }
  } catch (error) {
    if (String(error?.message || "").startsWith("AnalysisTimeout")) {
      // Retry automatico con parametri piu leggeri prima del fallback WASM.
      try {
        const reducedDepth = Math.max(10, Math.min(depth, 12));
        const reducedMultiPv = Math.max(1, Math.min(multiPv, 2));
        const queryLight = `fen=${encodeURIComponent(game.fen())}&depth=${reducedDepth}&multi_pv=${reducedMultiPv}&detail_level=${encodeURIComponent(detailLevel)}&_=${Date.now()}`;
        const fetchOptionsLight = {
          cache: "no-store",
        };
        if (analysisAbortController) {
          fetchOptionsLight.signal = analysisAbortController.signal;
        }
        const { data } = await analysisFetchDeepWithRetry(
          queryLight,
          fetchOptionsLight,
        );
        if (requestToken !== analysisRequestToken) {
          return;
        }
        analysisUseLocalWorkerScores = false;
        analysisRenderDeepAnalysis(data);
        analysisSetStatus(
          `Analisi completata in modalita rapida (depth=${reducedDepth}, multiPV=${reducedMultiPv}).`,
          true,
        );
        return;
      } catch (retryError) {
        analysisLocalFallback(
          `Timeout backend. Uso analisi locale WASM. Dettagli: ${retryError?.message || error.message}`,
        );
        return;
      }
    }
    if (error?.name === "AbortError") {
      return;
    }
    console.error("Deep analysis error:", error);
    analysisLocalFallback(
      `Errore backend: ${error?.message || "sconosciuto"}. Uso analisi locale WASM.`,
    );
  } finally {
    if (requestToken === analysisRequestToken) {
      analysisAbortController = null;
      analysisSetRunButtonState(false);
    }
  }
}

// Inizializza la scacchiera
function analysisInitBoard() {
  board = Chessboard("board", {
    draggable: true,
    position: "start",
    onDrop: analysisOnDrop,
    onSnapEnd: analysisOnSnapEnd,
    pieceTheme:
      "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
  });

  analysisUpdateEvalBar(0, null);
  const evalEl = document.getElementById("eval");
  if (evalEl) {
    evalEl.innerText = "0.00";
  }
  analysisEnsureLiveEvalWatchdog();
  analysisStartContinuousLiveEval(true);
}

function analysisOnSnapEnd() {
  if (board && game) {
    board.position(game.fen());
  }
  analysisQueueLiveEval();
}

// Quando l’utente muove un pezzo
let analysisMovesList = [];

function analysisGetSanMoves() {
  if (game && typeof game.history === "function") {
    try {
      const history = game.history();
      if (Array.isArray(history)) return history;
    } catch (_err) {
      // fallback su array locale
    }
  }
  return analysisMovesList.slice();
}

function analysisBuildPgnText() {
  const moves = analysisGetSanMoves();
  if (!moves.length) return "";

  let pgn = "";
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) {
      const moveNum = Math.floor(i / 2) + 1;
      pgn += (i > 0 ? " " : "") + moveNum + ". " + moves[i];
    } else {
      pgn += " " + moves[i];
    }
  }
  return pgn;
}

function analysisOnDrop(source, target) {
  const move = game.move({
    from: source,
    to: target,
    promotion: "q",
  });

  if (move === null) return "snapback";

  // Aggiungi mossa all'array e aggiorna il campo PGN
  analysisMovesList.push(move.san);
  const pgnInput = document.getElementById("pgn-input");
  if (pgnInput) {
    pgnInput.value = analysisBuildPgnText();
  }

  analysisDetectOpening();

  if (typeof registerNewMove === "function") registerNewMove();
  // Non lanciare analisi deep in automatico alla mossa.
  analysisQueueLiveEval();
}

// Avvio
// (Rimosso per evitare esecuzione prematura)

// ─────────────────────────────────────────────
// ANALISI PARTITA
// ─────────────────────────────────────────────

function analysisGameBackendUrl() {
  return analysisBackendUrl().replace("/analysis/deep", "/analysis/game");
}

function analysisSetGameButtonState(isRunning) {
  const btn = document.querySelector(
    '.analysis-controls button.btn[onclick="analysisRunGameAnalysis()"]',
  );
  if (!btn) return;
  btn.disabled = !!isRunning;
  btn.innerText = isRunning ? "Analisi in corso..." : "Analisi partita";
}

async function analysisRunGameAnalysis() {
  const pgnInput = document.getElementById("pgn-input");
  const pgn = pgnInput ? pgnInput.value : "";
  const status = document.getElementById("game-analysis-status");

  if (!pgn || !pgn.trim()) {
    if (status) {
      status.innerText =
        "Incolla un PGN nel campo apposito per analizzare la partita.";
      status.classList.add("error");
    }
    return;
  }

  const depthInput = document.getElementById("analysis-depth");
  const depth = Math.max(6, Math.min(16, Number(depthInput?.value || 10)));

  analysisSetGameButtonState(true);
  const panel = document.getElementById("game-analysis-panel");
  if (panel) panel.style.display = "none";

  if (status) {
    status.innerText =
      "Analisi partita in corso… (può richiedere alcuni minuti)";
    status.classList.remove("error");
  }

  try {
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), 180000)
      : null;

    const response = await fetch(analysisGameBackendUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pgn: pgn.trim(), depth }),
      mode: "cors",
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (timeoutId) clearTimeout(timeoutId);

    const data = await response.json();

    if (data.error) {
      if (status) {
        status.innerText = "Errore: " + data.error;
        status.classList.add("error");
      }
      return;
    }

    analysisRenderGameAnalysis(data);

    if (status) {
      status.innerText = data.engine_error
        ? "Analisi parziale: " + data.engine_error
        : "Analisi partita completata.";
      status.classList.toggle("error", !!data.engine_error);
    }
  } catch (err) {
    if (status) {
      status.innerText =
        err.name === "AbortError"
          ? "Timeout: partita troppo lunga. Riprova con depth minore."
          : "Errore: " + err.message;
      status.classList.add("error");
    }
  } finally {
    analysisSetGameButtonState(false);
  }
}

function analysisEvalToCp(evalObj) {
  if (!evalObj || typeof evalObj !== "object") return null;

  if (evalObj.type === "cp") {
    const cp = Number(evalObj.value);
    return Number.isFinite(cp) ? cp : null;
  }

  if (evalObj.type === "mate") {
    const mate = Number(evalObj.value);
    if (!Number.isFinite(mate) || mate === 0) return null;
    return mate > 0 ? 1200 : -1200;
  }

  return null;
}

// --- Evaluation chart state ---
let _gaChartState = null;

function analysisRenderGameChart(moves) {
  const canvas = document.getElementById("game-analysis-chart");
  if (!canvas) return;

  const values = (moves || []).map(
    (m) => analysisEvalToCp(m?.eval_after) ?? analysisEvalToCp(m?.eval_before),
  );
  _gaChartState = { moves, values };

  if (!canvas._gaChartInit) {
    canvas._gaChartInit = true;
    canvas.addEventListener("mousemove", _gaChartOnMouseMove);
    canvas.addEventListener("mouseleave", _gaChartOnMouseLeave);
  }

  _gaChartDraw(canvas, _gaChartState, -1);
}

function _gaChartDraw(canvas, state, hoverIdx) {
  const { values, moves } = state;
  const valid = values.filter((v) => Number.isFinite(v));

  const dpr = window.devicePixelRatio || 1;
  const wrap = canvas.parentElement;
  const wrapW = (wrap ? wrap.clientWidth : 0) || 600;

  const PX_PER_MOVE = 28;
  const cssW = Math.max(wrapW - 2, Math.max(300, values.length * PX_PER_MOVE));
  const cssH = 200;

  const newW = Math.round(cssW * dpr);
  const newH = Math.round(cssH * dpr);
  if (canvas.width !== newW || canvas.height !== newH) {
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = newW;
    canvas.height = newH;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#161616";
  ctx.fillRect(0, 0, cssW, cssH);

  if (!valid.length) {
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "12px Segoe UI, Arial";
    ctx.textAlign = "left";
    ctx.fillText("Valutazioni non disponibili.", 12, 24);
    return;
  }

  const L = 40,
    R = 10,
    T = 12,
    B = 28;
  const plotW = cssW - L - R;
  const plotH = cssH - T - B;
  const MIN_V = -650,
    MAX_V = 650;
  const clamp = (v) => Math.max(MIN_V, Math.min(MAX_V, v));
  const toX = (i) => {
    if (values.length <= 1) return L + plotW / 2;
    return L + (i / (values.length - 1)) * plotW;
  };
  const toY = (v) => T + ((MAX_V - clamp(v)) / (MAX_V - MIN_V)) * plotH;
  const zeroY = toY(0);

  // Grid lines
  const gridLines = [
    { v: 500, label: "+5", dim: true },
    { v: 300, label: "+3", dim: true },
    { v: 200, label: "+2", dim: false },
    { v: 100, label: "+1", dim: false },
    { v: 0, label: "0", zero: true },
    { v: -100, label: "\u22121", dim: false },
    { v: -200, label: "\u22122", dim: false },
    { v: -300, label: "\u22123", dim: true },
    { v: -500, label: "\u22125", dim: true },
  ];

  ctx.textAlign = "right";
  gridLines.forEach(({ v, label, zero, dim }) => {
    const y = toY(v);
    ctx.strokeStyle = zero ? "#4a4a4a" : dim ? "#1e1e1e" : "#252525";
    ctx.lineWidth = zero ? 1.5 : 1;
    ctx.setLineDash(zero ? [] : [3, 5]);
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(cssW - R, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = zero ? "#aaaaaa" : dim ? "#444444" : "#6a6a6a";
    ctx.font = `${zero ? "11" : "10"}px Segoe UI, Arial`;
    ctx.fillText(label, L - 4, y + 4);
  });

  // Gradient fills
  const gradUp = ctx.createLinearGradient(0, T, 0, zeroY);
  gradUp.addColorStop(0, "rgba(100,210,110,0.30)");
  gradUp.addColorStop(1, "rgba(100,210,110,0.04)");
  const gradDown = ctx.createLinearGradient(0, zeroY, 0, T + plotH);
  gradDown.addColorStop(0, "rgba(210,70,70,0.04)");
  gradDown.addColorStop(1, "rgba(210,70,70,0.30)");

  const pts = [];
  values.forEach((v, i) => {
    if (Number.isFinite(v)) pts.push({ i, x: toX(i), y: toY(v), v });
  });

  if (pts.length > 0) {
    const x0 = pts[0].x,
      xN = pts[pts.length - 1].x;

    // Positive area fill
    ctx.beginPath();
    ctx.moveTo(x0, zeroY);
    pts.forEach((p) => ctx.lineTo(p.x, Math.min(p.y, zeroY)));
    ctx.lineTo(xN, zeroY);
    ctx.closePath();
    ctx.fillStyle = gradUp;
    ctx.fill();

    // Negative area fill
    ctx.beginPath();
    ctx.moveTo(x0, zeroY);
    pts.forEach((p) => ctx.lineTo(p.x, Math.max(p.y, zeroY)));
    ctx.lineTo(xN, zeroY);
    ctx.closePath();
    ctx.fillStyle = gradDown;
    ctx.fill();

    // Main evaluation line
    ctx.strokeStyle = "#5ecf6e";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // Hover vertical crosshair
    if (hoverIdx >= 0 && Number.isFinite(values[hoverIdx])) {
      const hx = toX(hoverIdx);
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(hx, T);
      ctx.lineTo(hx, T + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Dots (color-coded, hover dot is larger)
    pts.forEach((p) => {
      const isHover = p.i === hoverIdx;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHover ? 5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = p.v >= 0 ? "#7de88a" : "#e87d7d";
      ctx.fill();
      if (isHover) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });
  }

  // X-axis move number labels
  const labStep =
    values.length > 60
      ? 10
      : values.length > 30
        ? 5
        : values.length > 15
          ? 2
          : 1;
  ctx.fillStyle = "#585858";
  ctx.font = "10px Segoe UI, Arial";
  ctx.textAlign = "center";
  values.forEach((v, i) => {
    if (!Number.isFinite(v) || i % 2 !== 0) return;
    const moveNum = Math.floor(i / 2) + 1;
    if (moveNum === 1 || moveNum % labStep === 0) {
      ctx.fillText(moveNum, toX(i), cssH - 8);
    }
  });

  canvas._gaToX = toX;
  canvas._gaLayout = { L, R, T, B, plotW, plotH, cssW, cssH };
}

function _gaChartOnMouseMove(e) {
  const canvas = e.currentTarget;
  if (!_gaChartState) return;
  const { values, moves } = _gaChartState;
  if (!values || !values.length) return;

  const layout = canvas._gaLayout;
  const toX = canvas._gaToX;
  if (!layout || !toX) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = layout.cssW / rect.width;
  const mx = (e.clientX - rect.left) * scaleX;

  let bestIdx = -1,
    bestDist = Infinity;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const d = Math.abs(toX(i) - mx);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  });

  if (bestIdx < 0 || bestDist > 24) {
    _gaChartHideTooltip();
    _gaChartDraw(canvas, _gaChartState, -1);
    return;
  }

  _gaChartDraw(canvas, _gaChartState, bestIdx);

  const v = values[bestIdx];
  const m = moves[bestIdx];
  const san = m?.move_san || m?.san || "";
  const moveNum = Math.floor(bestIdx / 2) + 1;
  const colorLabel = bestIdx % 2 === 0 ? "Bianco" : "Nero";
  const evalStr =
    v >= 1200
      ? "+Matto"
      : v <= -1200
        ? "\u2212Matto"
        : (v > 0 ? "+" : "") + (v / 100).toFixed(2);
  const evalColor = v >= 0 ? "#7de88a" : "#e87d7d";

  let tt = document.getElementById("_ga-chart-tip");
  if (!tt) {
    tt = document.createElement("div");
    tt.id = "_ga-chart-tip";
    tt.style.cssText =
      "position:fixed;pointer-events:none;display:none;background:#1c1c1c;border:1px solid #3a3a3a;border-radius:7px;padding:7px 12px;font-size:12px;color:#ddd;font-family:Segoe UI,Arial,sans-serif;z-index:9999;box-shadow:0 3px 12px rgba(0,0,0,.7);white-space:nowrap;line-height:1.6";
    document.body.appendChild(tt);
  }
  tt.innerHTML = `<b>Mossa ${moveNum} \u2013 ${colorLabel}</b>${san ? ` (${san})` : ""}<br>Valutazione: <span style="color:${evalColor};font-weight:600">${evalStr}</span>`;
  tt.style.display = "block";
  const ttW = 210;
  const tx =
    e.clientX + 16 + ttW > window.innerWidth - 8
      ? e.clientX - ttW - 10
      : e.clientX + 16;
  tt.style.left = tx + "px";
  tt.style.top = e.clientY - 16 + "px";
}

function _gaChartOnMouseLeave() {
  _gaChartHideTooltip();
  const canvas = document.getElementById("game-analysis-chart");
  if (canvas && _gaChartState) _gaChartDraw(canvas, _gaChartState, -1);
}

function _gaChartHideTooltip() {
  const tt = document.getElementById("_ga-chart-tip");
  if (tt) tt.style.display = "none";
}

function analysisRenderGameAnalysis(data) {
  const panel = document.getElementById("game-analysis-panel");
  if (panel) panel.style.display = "";

  const statsEl = document.getElementById("game-analysis-stats");
  const movesEl = document.getElementById("game-analysis-moves");

  analysisRenderGameChart(data?.moves || []);

  const symSpan = (s) => {
    const cls = ["!!", "!", "!?"].includes(s)
      ? "ga-sym ga-good"
      : "ga-sym ga-bad";
    return `<span class="${cls}">${s}</span>`;
  };

  if (statsEl && data.stats) {
    const w = data.stats.white || {};
    const b = data.stats.black || {};
    statsEl.innerHTML = `
      <div class="ga-stats">
        <div class="ga-stats-row">
          <strong>⬜ Bianco</strong>
          <span class="ga-pct">${w.good_pct ?? 0}% mosse buone</span>
          ${symSpan("!!")} ${w.brilliant ?? 0} &nbsp;
          ${symSpan("!")} ${w.good ?? 0} &nbsp;
          ${symSpan("!?")} ${w.interesting ?? 0} &nbsp;
          ${symSpan("?!")} ${w.inaccuracy ?? 0} &nbsp;
          ${symSpan("?")} ${w.mistake ?? 0} &nbsp;
          ${symSpan("??")} ${w.blunder ?? 0}
        </div>
        <div class="ga-stats-row">
          <strong>⬛ Nero</strong>
          <span class="ga-pct">${b.good_pct ?? 0}% mosse buone</span>
          ${symSpan("!!")} ${b.brilliant ?? 0} &nbsp;
          ${symSpan("!")} ${b.good ?? 0} &nbsp;
          ${symSpan("!?")} ${b.interesting ?? 0} &nbsp;
          ${symSpan("?!")} ${b.inaccuracy ?? 0} &nbsp;
          ${symSpan("?")} ${b.mistake ?? 0} &nbsp;
          ${symSpan("??")} ${b.blunder ?? 0}
        </div>
      </div>`;
  }

  if (movesEl && data.moves && data.moves.length) {
    const byNum = {};
    for (const m of data.moves) {
      if (!byNum[m.move_number]) byNum[m.move_number] = {};
      byNum[m.move_number][m.color] = m;
    }

    const fmtMove = (m) => {
      if (!m) return '<span class="ga-empty">…</span>';
      const isGood = ["!!", "!", "!?"].includes(m.symbol);
      const symClass = isGood ? "ga-sym ga-good" : "ga-sym ga-bad";
      const cpLossText =
        m.cp_loss > 10
          ? `<span class="ga-cploss">-${(m.cp_loss / 100).toFixed(2)}</span>`
          : "";
      const bestAlt =
        m.best_move_san && m.best_move_san !== m.move_san
          ? `<span class="ga-best">(miglior: ${m.best_move_san})</span>`
          : "";
      return `<span class="ga-move">${m.move_san} <span class="${symClass}">${m.symbol}</span>${cpLossText}${bestAlt}</span>`;
    };

    const rows = Object.entries(byNum).map(
      ([num, pair]) =>
        `<li class="ga-row"><span class="ga-num">${num}.</span> ${fmtMove(pair.white)} ${fmtMove(pair.black)}</li>`,
    );
    movesEl.innerHTML = `<ul class="ga-moves">${rows.join("")}</ul>`;
  } else if (movesEl) {
    movesEl.innerHTML = "<p>Nessuna mossa da mostrare.</p>";
  }
}
