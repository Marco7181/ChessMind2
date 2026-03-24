function analysisBackendUrl() {
  const queryValue = new URLSearchParams(window.location.search).get(
    "backendUrl",
  );
  const storedValue = localStorage.getItem("chessmind_backend_url");
  const globalValue = window.CHESSMIND_BACKEND_URL;
  const rawBaseUrl = queryValue || storedValue || globalValue;

  if (rawBaseUrl) {
    return `${rawBaseUrl.replace(/\/$/, "")}/analysis/deep`;
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

let analysisAbortController = null;
let analysisRequestToken = 0;
let analysisUseLocalWorkerScores = false;

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
      return `<li><strong>#${idx + 1}</strong> ${move} (${score})<br/><span>${pv}</span></li>`;
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

function analysisRenderDeepAnalysis(data) {
  const evalEl = document.getElementById("eval");
  const summaryEl = document.getElementById("analysis-summary");
  const evalData = data?.evaluation;

  if (evalEl) {
    if (!evalData) {
      evalEl.innerText = "n/d";
    } else if (evalData.type === "cp") {
      evalEl.innerText = analysisFormatCpScore(evalData.value);
    } else if (evalData.type === "mate") {
      evalEl.innerText = analysisFormatMateScore(evalData.value);
    } else {
      evalEl.innerText = "n/d";
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

  if (!stockfish) return;

  stockfish.onmessage = function (event) {
    if (!analysisUseLocalWorkerScores) return;

    const line = event.data;
    if (typeof line !== "string") return;

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
        .slice(0, 5)
        .map((m, idx) => `<li><strong>#${idx + 1}</strong> ${m}</li>`)
        .join("");
    }
  };
}

function analysisLocalFallback() {
  if (!game) {
    analysisSetStatus("Partita non inizializzata.", true);
    return;
  }

  if (!stockfish) {
    analysisSetStatus(
      "Backend non raggiungibile e Stockfish locale non disponibile.",
      true,
    );
    return;
  }

  analysisUseLocalWorkerScores = true;
  stockfish.postMessage("position fen " + game.fen());
  stockfish.postMessage("go depth 18");
  analysisSetStatus("Backend non disponibile: uso analisi locale WASM.", true);
}

async function analysisRunDeep() {
  if (!game) return;

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
  const depth = Math.max(8, Math.min(24, Number(depthInput?.value || 16)));
  const multiPv = Math.max(1, Math.min(5, Number(multiPvInput?.value || 3)));

  analysisSetStatus("Analisi approfondita in corso...");

  try {
    const url = `${analysisBackendUrl()}?fen=${encodeURIComponent(game.fen())}&depth=${depth}&multi_pv=${multiPv}&_=${Date.now()}`;
    const fetchOptions = {
      mode: "cors",
      cache: "no-store",
    };
    if (analysisAbortController) {
      fetchOptions.signal = analysisAbortController.signal;
    }

    const response = await Promise.race([
      fetch(url, fetchOptions),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AnalysisTimeout")), 20000),
      ),
    ]);
    const data = await response.json();

    if (requestToken !== analysisRequestToken) {
      return;
    }

    if (!response.ok || data.error) {
      throw new Error(data.error || "Errore durante l'analisi approfondita");
    }

    analysisUseLocalWorkerScores = false;
    analysisRenderDeepAnalysis(data);
    if (data.engine_error) {
      analysisSetStatus(`Analisi parziale: ${data.engine_error}`, true);
    } else {
      analysisSetStatus("Analisi completa disponibile.");
    }
  } catch (error) {
    if (error?.message === "AnalysisTimeout") {
      analysisSetStatus("Timeout analisi: uso fallback locale.", true);
      analysisLocalFallback();
      return;
    }
    if (error?.name === "AbortError") {
      return;
    }
    console.error("Deep analysis error:", error);
    analysisLocalFallback();
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
}

function analysisOnSnapEnd() {
  if (board && game) {
    board.position(game.fen());
  }
}

// Quando l’utente muove un pezzo
let analysisMovesList = [];

function analysisBuildPgnText() {
  if (!analysisMovesList.length) return "";

  let pgn = "";
  for (let i = 0; i < analysisMovesList.length; i++) {
    if (i % 2 === 0) {
      const moveNum = Math.floor(i / 2) + 1;
      pgn += (i > 0 ? " " : "") + moveNum + ". " + analysisMovesList[i];
    } else {
      pgn += " " + analysisMovesList[i];
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

  if (typeof registerNewMove === "function") registerNewMove();
  analysisRunDeep();
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

function analysisRenderGameAnalysis(data) {
  const panel = document.getElementById("game-analysis-panel");
  if (panel) panel.style.display = "";

  const statsEl = document.getElementById("game-analysis-stats");
  const movesEl = document.getElementById("game-analysis-moves");

  // Simbolo colorato
  const symSpan = (s) => {
    const cls = ["!!", "!", "!?"].includes(s)
      ? "ga-sym ga-good"
      : "ga-sym ga-bad";
    return `<span class="${cls}">${s}</span>`;
  };

  // Statistiche bianco/nero
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

  // Lista mosse annotate
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
