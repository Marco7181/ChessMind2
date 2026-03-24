from fastapi import APIRouter
import chess
import logging
from typing import Any

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
        cp = int(evaluation.get("value") or 0)
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
        mate = int(evaluation.get("value") or 0)
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

        cp = item.get("Centipawn")
        mate = item.get("Mate")
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
                "score_cp": fallback_eval.get("value") if (fallback_eval or {}).get("type") == "cp" else None,
                "mate": fallback_eval.get("value") if (fallback_eval or {}).get("type") == "mate" else None,
                "pv_uci": [fallback_best_move],
                "pv_san": [_uci_to_san(board, fallback_best_move)] if _uci_to_san(board, fallback_best_move) else [],
            }
        )

    return lines

@router.get("/")
def analyze(fen: str):
    logger.info(f"📥 Richiesta analisi: {fen}")
    
    try:
        board = chess.Board(fen)
        sf = get_stockfish()
        
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
        
        logger.info(f"✅ Mossa trovata: {best_move}")

        return {
            "fen": fen,
            "best_move": best_move,
            "evaluation": evaluation
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

    sf = get_stockfish()
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
                cp_val   = top_moves_raw[0].get("Centipawn")
                mate_val = top_moves_raw[0].get("Mate")
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