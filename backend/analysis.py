from fastapi import APIRouter
import chess
import chess.pgn
import io as _io
import logging
from typing import Any
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

# Stockfish lazy-loaded (caricato solo quando richiesto)
stockfish = None

def get_stockfish(force_new: bool = False):
    """Carica Stockfish solo quando necessario"""
    global stockfish
    if force_new:
        stockfish = None
    if stockfish is None:
        try:
            from stockfish import Stockfish
            stockfish = Stockfish(depth=10)
            logger.info("✅ Stockfish inizializzato")
        except Exception as e:
            logger.error(f"❌ Errore Stockfish: {e}")
            stockfish = False  # Marker per "tentato ma fallito"

    return stockfish if stockfish is not False else None


PIECE_VALUES = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
}


def _material_balance(board: chess.Board) -> dict[str, Any]:
    white = 0
    black = 0

    for piece_type, value in PIECE_VALUES.items():
        white += len(board.pieces(piece_type, chess.WHITE)) * value
        black += len(board.pieces(piece_type, chess.BLACK)) * value

    return {
        "white": white,
        "black": black,
        "balance": white - black,
    }


def _game_phase(board: chess.Board) -> str:
    non_pawn_material = 0
    for piece_type, value in PIECE_VALUES.items():
        if piece_type == chess.PAWN:
            continue
        non_pawn_material += (
            len(board.pieces(piece_type, chess.WHITE))
            + len(board.pieces(piece_type, chess.BLACK))
        ) * value

    if non_pawn_material >= 42:
        return "apertura"
    if non_pawn_material >= 18:
        return "mediogioco"
    return "finale"


def _center_control(board: chess.Board) -> dict[str, int]:
    center = [chess.D4, chess.E4, chess.D5, chess.E5]
    white = 0
    black = 0
    for square in center:
        white += len(board.attackers(chess.WHITE, square))
        black += len(board.attackers(chess.BLACK, square))
    return {"white": white, "black": black}


def _tactical_alerts(board: chess.Board) -> list[str]:
    alerts: list[str] = []

    if board.is_check():
        alerts.append("Re sotto scacco: priorita assoluta a mosse difensive.")

    turn = board.turn
    enemy = not turn
    hanging_enemy = 0
    hanging_own = 0

    for square, piece in board.piece_map().items():
        attacked_by_turn = board.is_attacked_by(turn, square)
        defended_by_owner = board.is_attacked_by(piece.color, square)

        if piece.color == enemy and attacked_by_turn and not defended_by_owner:
            hanging_enemy += 1
        if piece.color == turn and board.is_attacked_by(enemy, square) and not defended_by_owner:
            hanging_own += 1

    if hanging_enemy:
        alerts.append(
            f"Ci sono {hanging_enemy} pezzi avversari poco difesi: valuta tattiche immediate."
        )
    if hanging_own:
        alerts.append(
            f"Attenzione: {hanging_own} tuoi pezzi risultano poco difesi."
        )

    legal_captures = 0
    for mv in board.legal_moves:
        if board.is_capture(mv):
            legal_captures += 1

    if legal_captures:
        alerts.append(
            f"Sono disponibili {legal_captures} catture legali: confronta il miglior guadagno materiale."
        )

    return alerts


def _build_plans(
    board: chess.Board,
    best_move_san: str | None,
    evaluation: dict[str, Any] | None,
) -> dict[str, Any]:
    phase = _game_phase(board)
    material = _material_balance(board)
    center = _center_control(board)

    side = "Bianco" if board.turn == chess.WHITE else "Nero"
    opp = "Nero" if board.turn == chess.WHITE else "Bianco"

    score_text = "equilibrio"
    if evaluation and evaluation.get("type") == "cp":
        cp_white = int(evaluation.get("value") or 0)
        cp = cp_white if board.turn == chess.WHITE else -cp_white
        pawns = cp / 100.0
        if pawns > 0.8:
            score_text = "vantaggio chiaro"
        elif pawns > 0.25:
            score_text = "leggero vantaggio"
        elif pawns < -0.8:
            score_text = "svantaggio netto"
        elif pawns < -0.25:
            score_text = "leggero svantaggio"
    elif evaluation and evaluation.get("type") == "mate":
        mate_white = int(evaluation.get("value") or 0)
        mate = mate_white if board.turn == chess.WHITE else -mate_white
        score_text = "attacco decisivo" if mate > 0 else "difesa critica"

    strategic_plan = [
        f"Fase della partita: {phase}.",
        f"Valutazione generale: {score_text} per il lato al tratto ({side}).",
    ]

    if best_move_san:
        strategic_plan.append(f"Mossa candidata principale: {best_move_san}.")

    material_balance = material["balance"] if board.turn == chess.WHITE else -material["balance"]
    if material_balance > 0:
        strategic_plan.append("Hai vantaggio materiale: semplifica quando possibile.")
    elif material_balance < 0:
        strategic_plan.append("Sei sotto materiale: cerca iniziativa e complicazioni tattiche.")
    else:
        strategic_plan.append("Materiale in equilibrio: dai priorita a coordinazione e attivita pezzi.")

    center_delta = center["white"] - center["black"]
    center_side_delta = center_delta if board.turn == chess.WHITE else -center_delta
    if center_side_delta >= 2:
        strategic_plan.append("Controllo centrale favorevole: consolida e prepara espansione sui lati.")
    elif center_side_delta <= -2:
        strategic_plan.append("Centro sfavorevole: valuta rotture pedonali per riequilibrare lo spazio.")
    else:
        strategic_plan.append("Centro conteso: migliora i pezzi minori verso case centrali forti.")

    opponent_plan = [
        f"Piano probabile di {opp}: contestare il centro e limitare l'attivita dei tuoi pezzi.",
        "Attesi cambi favorevoli se l'avversario e in vantaggio materiale.",
        "Verifica sempre minacce su re e pezzi non difesi prima di eseguire il piano strategico.",
    ]

    summary = (
        f"{side} al tratto, fase {phase}. "
        f"Piano consigliato: {strategic_plan[-1]}"
    )

    return {
        "phase": phase,
        "material": material,
        "center_control": center,
        "strategic_plan": strategic_plan,
        "opponent_plan": opponent_plan,
        "summary": summary,
    }


def _uci_to_san(board: chess.Board, uci_move: str | None) -> str | None:
    if not uci_move:
        return None
    try:
        move = chess.Move.from_uci(uci_move)
        if move not in board.legal_moves:
            return None
        return board.san(move)
    except Exception:
        return None


def _to_white_pov(board: chess.Board, value: int | None) -> int | None:
    if value is None:
        return None
    raw = int(value)
    return raw if board.turn == chess.WHITE else -raw


def _normalize_top_moves(
    board: chess.Board,
    top_moves: list[dict[str, Any]] | None,
    fallback_best_move: str | None,
    fallback_eval: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []

    for item in top_moves or []:
        uci = item.get("Move")
        if not uci:
            continue

        cp = _to_white_pov(board, item.get("Centipawn"))
        mate = _to_white_pov(board, item.get("Mate"))
        lines.append(
            {
                "move_uci": uci,
                "move_san": _uci_to_san(board, uci),
                "score_cp": cp,
                "mate": mate,
                "pv_uci": [uci],
                "pv_san": [_uci_to_san(board, uci)] if _uci_to_san(board, uci) else [],
            }
        )

    if not lines and fallback_best_move:
        lines.append(
            {
                "move_uci": fallback_best_move,
                "move_san": _uci_to_san(board, fallback_best_move),
                "score_cp": _to_white_pov(
                    board,
                    fallback_eval.get("value") if (fallback_eval or {}).get("type") == "cp" else None,
                ),
                "mate": _to_white_pov(
                    board,
                    fallback_eval.get("value") if (fallback_eval or {}).get("type") == "mate" else None,
                ),
                "pv_uci": [fallback_best_move],
                "pv_san": [_uci_to_san(board, fallback_best_move)] if _uci_to_san(board, fallback_best_move) else [],
            }
        )

    # Manteniamo l'ordine originale fornito da Stockfish senza alterazioni.
    return lines

class GameAnalysisRequest(BaseModel):
    pgn: str
    depth: int = 10


def _is_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    """True se la mossa porta il pezzo su una casa attaccata (possibile sacrificio)."""
    moving_piece = board.piece_at(move.from_square)
    if not moving_piece:
        return False
    if PIECE_VALUES.get(moving_piece.piece_type, 0) < 3:
        return False  # i pedoni non sono sacrifici significativi
    captured = board.piece_at(move.to_square)
    board_after = board.copy()
    board_after.push(move)
    if not board_after.is_attacked_by(not board.turn, move.to_square):
        return False  # il pezzo non rimane sotto attacco
    if captured is None:
        return True  # mossa su casa attaccata senza cattura = sacrificio
    return PIECE_VALUES.get(moving_piece.piece_type, 0) > PIECE_VALUES.get(captured.piece_type, 0)


def _classify_move(cp_loss: int, board_before: chess.Board, move: chess.Move) -> tuple[str, str]:
    """Classifica una mossa con i simboli scacchistici FIDE standard."""
    if cp_loss <= 5 and _is_sacrifice(board_before, move):
        return "!!", "Geniale"
    if cp_loss <= 10:
        return "!", "Ottima"
    if cp_loss <= 30:
        return "!?", "Interessante"
    if cp_loss <= 100:
        return "?!", "Imprecisione"
    if cp_loss <= 250:
        return "?", "Errore"
    return "??", "Gaffe"


def _calc_game_stats(moves: list[dict]) -> dict:
    """Calcola statistiche qualità mosse per bianco e nero."""
    def stats_for(color_moves: list[dict]) -> dict:
        if not color_moves:
            return {"brilliant": 0, "good": 0, "interesting": 0,
                    "inaccuracy": 0, "mistake": 0, "blunder": 0,
                    "total": 0, "good_pct": 0.0}
        counts: dict[str, int] = {"!!": 0, "!": 0, "!?": 0, "?!": 0, "?": 0, "??": 0}
        for m in color_moves:
            sym = m.get("symbol", "!?")
            counts[sym] = counts.get(sym, 0) + 1
        total = len(color_moves)
        good_count = counts["!!"] + counts["!"] + counts["!?"]
        return {
            "brilliant": counts["!!"],
            "good": counts["!"],
            "interesting": counts["!?"],
            "inaccuracy": counts["?!"],
            "mistake": counts["?"],
            "blunder": counts["??"],
            "total": total,
            "good_pct": round(good_count / total * 100, 1),
        }

    white_moves = [m for m in moves if m["color"] == "white"]
    black_moves = [m for m in moves if m["color"] == "black"]
    return {"white": stats_for(white_moves), "black": stats_for(black_moves)}


@router.post("/game")
def analyze_game(request: GameAnalysisRequest):
    pgn_text = (request.pgn or "").strip()
    depth = max(6, min(16, int(request.depth or 10)))

    if not pgn_text:
        return {"error": "PGN vuoto", "moves": [], "stats": {}}

    try:
        game_pgn = chess.pgn.read_game(_io.StringIO(pgn_text))
    except Exception as exc:
        return {"error": f"Errore parsing PGN: {exc}", "moves": [], "stats": {}}

    if not game_pgn:
        return {"error": "PGN non valido o mancante di mosse", "moves": [], "stats": {}}

    board = game_pgn.board()
    annotated: list[dict[str, Any]] = []

    sf = get_stockfish(force_new=True)
    if not sf:
        return {"error": "Stockfish non disponibile", "moves": [], "stats": {}}

    try:
        sf.set_depth(depth)

        for move in game_pgn.mainline_moves():
            if board.is_game_over():
                break

            is_white = board.turn == chess.WHITE
            move_number = board.fullmove_number

            # Analizza posizione prima della mossa
            fen_before = board.fen()
            sf.set_fen_position(fen_before)
            top_before = sf.get_top_moves(1)

            best_cp: int | None = None
            best_mate: int | None = None
            best_move_uci: str | None = None
            if top_before:
                best_move_uci = top_before[0].get("Move")
                best_cp = _to_white_pov(board, top_before[0].get("Centipawn"))
                best_mate = _to_white_pov(board, top_before[0].get("Mate"))

            move_san = board.san(move)
            move_uci = move.uci()
            best_move_san_val = _uci_to_san(board, best_move_uci)

            # Salva stato prima del push (per classificazione sacrifici)
            board_before = board.copy()
            board.push(move)
            is_checkmate_move = board.is_checkmate()

            # Analizza posizione dopo la mossa
            actual_cp: int | None = None
            actual_mate: int | None = None
            if not board.is_game_over():
                sf.set_fen_position(board.fen())
                top_after = sf.get_top_moves(1)
                if top_after:
                    actual_cp = _to_white_pov(board, top_after[0].get("Centipawn"))
                    actual_mate = _to_white_pov(board, top_after[0].get("Mate"))

            # Calcola perdita centipawn (sempre >= 0)
            cp_loss = 0
            if best_mate is not None:
                best_mate_favor = (best_mate > 0) if is_white else (best_mate < 0)
                if best_mate_favor:
                    if actual_mate is None:
                        cp_loss = 500  # matto mancato
                    else:
                        actual_mate_favor = (actual_mate > 0) if is_white else (actual_mate < 0)
                        cp_loss = 0 if actual_mate_favor else 500
            elif best_cp is not None and actual_cp is not None:
                cp_loss = (best_cp - actual_cp) if is_white else (actual_cp - best_cp)
                cp_loss = max(0, cp_loss)

            if is_checkmate_move:
                cp_loss = 0
                symbol, label = "!!", "Scacco matto"
            else:
                symbol, label = _classify_move(cp_loss, board_before, move)

            eval_before_d: dict[str, Any] | None = None
            if best_mate is not None:
                eval_before_d = {"type": "mate", "value": best_mate}
            elif best_cp is not None:
                eval_before_d = {"type": "cp", "value": best_cp}

            eval_after_d: dict[str, Any] | None = None
            if actual_mate is not None:
                eval_after_d = {"type": "mate", "value": actual_mate}
            elif actual_cp is not None:
                eval_after_d = {"type": "cp", "value": actual_cp}
            elif is_checkmate_move:
                eval_after_d = {
                    "type": "mate",
                    "value": 1 if is_white else -1,
                }

            annotated.append({
                "move_number": move_number,
                "color": "white" if is_white else "black",
                "move_san": move_san,
                "move_uci": move_uci,
                "best_move_san": best_move_san_val,
                "symbol": symbol,
                "label": label,
                "cp_loss": cp_loss,
                "eval_before": eval_before_d,
                "eval_after": eval_after_d,
            })

    except Exception as exc:
        logger.error(f"❌ Errore analisi partita: {exc}")
        if annotated:
            return {
                "moves": annotated,
                "stats": _calc_game_stats(annotated),
                "engine_error": str(exc),
            }
        return {"error": str(exc), "moves": [], "stats": {}}

    return {
        "moves": annotated,
        "stats": _calc_game_stats(annotated),
    }


@router.get("/")
def analyze(fen: str):
    logger.info(f"📥 Richiesta analisi: {fen}")
    
    try:
        board = chess.Board(fen)
        sf = get_stockfish(force_new=True)
        
        if not sf:
            logger.warning("Stockfish non disponibile")
            return {
                "fen": fen,
                "best_move": None,
                "evaluation": None,
                "error": "Stockfish non disponibile"
            }
        
        sf.set_fen_position(fen)
        best_move = sf.get_best_move()
        evaluation = sf.get_evaluation()
        if evaluation and evaluation.get("value") is not None:
            evaluation = {
                "type": evaluation.get("type"),
                "value": _to_white_pov(board, evaluation.get("value")),
            }

        logger.info(f"✅ Mossa trovata: {best_move}")

        return {
            "fen": fen,
            "best_move": best_move,
            "evaluation": evaluation,
        }
    except Exception as e:
        logger.error(f"❌ Errore analisi: {e}")
        return {
            "fen": fen,
            "best_move": None,
            "evaluation": None,
            "error": str(e)
        }


@router.get("/deep")
def analyze_deep(fen: str, depth: int = 16, multi_pv: int = 3):
    logger.info(f"📥 Richiesta deep analysis: {fen}")

    try:
        board = chess.Board(fen)
    except Exception as e:
        logger.error(f"❌ FEN non valida: {e}")
        return {
            "fen": fen,
            "error": f"FEN non valida: {e}",
            "top_lines": [],
            "strategic_plan": [],
            "opponent_plan": [],
            "tactical_alerts": [],
        }

    depth = max(8, min(24, int(depth)))
    multi_pv = max(1, min(5, int(multi_pv)))

    sf = get_stockfish(force_new=True)
    best_move = None
    evaluation = None
    top_lines: list[dict[str, Any]] = []
    engine_error = None

    if sf:
        try:
            sf.set_depth(depth)
            sf.set_fen_position(fen)
            # Usiamo get_top_moves come unica sorgente: evita chiamate multiple
            # che possono corrompere lo stato del processo Stockfish.
            top_moves_raw = sf.get_top_moves(multi_pv)
            if top_moves_raw:
                best_move = top_moves_raw[0].get("Move")
                cp_val = _to_white_pov(board, top_moves_raw[0].get("Centipawn"))
                mate_val = _to_white_pov(board, top_moves_raw[0].get("Mate"))
                if mate_val is not None:
                    evaluation = {"type": "mate", "value": mate_val}
                elif cp_val is not None:
                    evaluation = {"type": "cp", "value": cp_val}
            top_lines = _normalize_top_moves(board, top_moves_raw, best_move, evaluation)
        except Exception as e:
            logger.error(f"❌ Errore deep analysis Stockfish (top_moves): {e}")
            # Resetta l'istanza corrotta e riprova con la sola mossa migliore
            get_stockfish(force_new=True)
            sf2 = get_stockfish()
            if sf2:
                try:
                    sf2.set_depth(depth)
                    sf2.set_fen_position(fen)
                    best_move = sf2.get_best_move()
                    evaluation = sf2.get_evaluation()
                    if evaluation and evaluation.get("value") is not None:
                        evaluation = {
                            "type": evaluation.get("type"),
                            "value": _to_white_pov(board, evaluation.get("value")),
                        }
                    top_lines = _normalize_top_moves(board, None, best_move, evaluation)
                    engine_error = "Analisi parziale (multi-pv non disponibile)"
                except Exception as e2:
                    logger.error(f"❌ Fallback Stockfish fallito: {e2}")
                    engine_error = str(e)
                    get_stockfish(force_new=True)
            else:
                engine_error = str(e)
    else:
        engine_error = "Stockfish non disponibile"

    best_move_san = _uci_to_san(board, best_move)
    plans = _build_plans(board, best_move_san, evaluation)
    alerts = _tactical_alerts(board)

    return {
        "fen": fen,
        "depth": depth,
        "multi_pv": multi_pv,
        "best_move": best_move,
        "best_move_san": best_move_san,
        "evaluation": evaluation,
        "top_lines": top_lines,
        "phase": plans["phase"],
        "material": plans["material"],
        "center_control": plans["center_control"],
        "strategic_plan": plans["strategic_plan"],
        "opponent_plan": plans["opponent_plan"],
        "tactical_alerts": alerts,
        "summary": plans["summary"],
        "engine_error": engine_error,
    }