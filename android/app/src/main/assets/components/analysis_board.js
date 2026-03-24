function analysisBackendUrl() {
  return "http://localhost:8000/analysis/deep";
}

function analysisSetStatus(message, isError = false) {
  const status = document.getElementById("analysis-status");
  if (!status) return;

  status.innerText = message;
  status.classList.toggle("error", isError);
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
      const score =
        line.mate !== null && line.mate !== undefined
          ? `M${line.mate}`
          : line.score_cp !== null && line.score_cp !== undefined
            ? (line.score_cp / 100).toFixed(2)
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

  if (evalEl) {
    if (!data || !data.evaluation) {
      evalEl.innerText = "n/d";
    } else if (data.evaluation.type === "cp") {
      evalEl.innerText = (Number(data.evaluation.value || 0) / 100).toFixed(2);
    } else if (data.evaluation.type === "mate") {
      evalEl.innerText = `M${data.evaluation.value}`;
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
    const line = event.data;
    if (typeof line !== "string") return;

    if (line.includes("score cp")) {
      const cp = line.split("score cp ")[1]?.split(" ")[0];
      if (cp) {
        const evalScore = (Number(cp) / 100).toFixed(2);
        document.getElementById("eval").innerText = evalScore;
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

  stockfish.postMessage("position fen " + game.fen());
  stockfish.postMessage("go depth 18");
  analysisSetStatus("Backend non disponibile: uso analisi locale WASM.", true);
}

async function analysisRunDeep() {
  if (!game) return;

  const depthInput = document.getElementById("analysis-depth");
  const multiPvInput = document.getElementById("analysis-multipv");
  const depth = Math.max(8, Math.min(24, Number(depthInput?.value || 16)));
  const multiPv = Math.max(1, Math.min(5, Number(multiPvInput?.value || 3)));

  analysisSetStatus("Analisi approfondita in corso...");

  try {
    const url = `${analysisBackendUrl()}?fen=${encodeURIComponent(game.fen())}&depth=${depth}&multi_pv=${multiPv}`;
    const response = await fetch(url, { mode: "cors" });
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || "Errore durante l'analisi approfondita");
    }

    analysisRenderDeepAnalysis(data);
    if (data.engine_error) {
      analysisSetStatus(`Analisi parziale: ${data.engine_error}`, true);
    } else {
      analysisSetStatus("Analisi completa disponibile.");
    }
  } catch (error) {
    console.error("Deep analysis error:", error);
    analysisLocalFallback();
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
function analysisOnDrop(source, target) {
  const move = game.move({
    from: source,
    to: target,
    promotion: "q",
  });

  if (move === null) return "snapback";

  if (typeof registerNewMove === "function") registerNewMove();
  analysisRunDeep();
}

// Avvio
// (Rimosso per evitare esecuzione prematura)
