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


def _build_engine_pv(
    sf: Any,
    board: chess.Board,
    first_move_uci: str,
    target_plies: int = 8,
) -> tuple[list[str], list[str]]:
    """Costruisce una variante pratica: prima mossa candidata + continuazione engine."""
    pv_uci: list[str] = []
    pv_san: list[str] = []

    try:
        work = board.copy()
        first = chess.Move.from_uci(first_move_uci)
        if first not in work.legal_moves:
            return pv_uci, pv_san

        pv_uci.append(first_move_uci)
        pv_san.append(work.san(first))
        work.push(first)

        # Completa la linea con la miglior risposta engine a ogni ply.
        while len(pv_uci) < target_plies and not work.is_game_over():
            sf.set_fen_position(work.fen())
            nxt_uci = sf.get_best_move()
            if not nxt_uci:
                break

            nxt = chess.Move.from_uci(nxt_uci)
            if nxt not in work.legal_moves:
                break

            pv_uci.append(nxt_uci)
            pv_san.append(work.san(nxt))
            work.push(nxt)
    except Exception:
        return pv_uci, pv_san

    return pv_uci, pv_san


def _normalize_top_moves(
    board: chess.Board,
    sf: Any,
    top_moves: list[dict[str, Any]] | None,
    fallback_best_move: str | None,
    fallback_eval: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []

    for idx, item in enumerate(top_moves or []):
        uci = item.get("Move")
        if not uci:
            continue

        cp = _to_white_pov(board, item.get("Centipawn"))
        mate = _to_white_pov(board, item.get("Mate"))
        # Per performance: linea principale lunga, linee alternative piu compatte.
        target_plies = 8 if idx == 0 else 4
        pv_uci, pv_san = _build_engine_pv(sf, board, uci, target_plies=target_plies)
        if not pv_uci:
            san = _uci_to_san(board, uci)
            pv_uci = [uci]
            pv_san = [san] if san else []
        lines.append(
            {
                "move_uci": uci,
                "move_san": _uci_to_san(board, uci),
                "score_cp": cp,
                "mate": mate,
                "pv_uci": pv_uci,
                "pv_san": pv_san,
            }
        )

    if not lines and fallback_best_move:
        fallback_pv_uci, fallback_pv_san = _build_engine_pv(sf, board, fallback_best_move, target_plies=8)
        if not fallback_pv_uci:
            fallback_san = _uci_to_san(board, fallback_best_move)
            fallback_pv_uci = [fallback_best_move]
            fallback_pv_san = [fallback_san] if fallback_san else []
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
                "pv_uci": fallback_pv_uci,
                "pv_san": fallback_pv_san,
            }
        )

    # Manteniamo l'ordine originale fornito da Stockfish senza alterazioni.
    return lines


def _normalize_detail_level(detail_level: str | None) -> str:
    value = (detail_level or "coach").strip().lower()
    if value in {"breve", "coach", "approfondita"}:
        return value
    return "coach"


def _describe_top_line(
    board: chess.Board,
    line: dict[str, Any],
    rank: int,
    detail_level: str,
) -> str:
    move_uci = line.get("move_uci")
    move_san = line.get("move_san") or move_uci or "-"
    side = "Bianco" if board.turn == chess.WHITE else "Nero"
    score_cp = line.get("score_cp")
    mate = line.get("mate")

    eval_part = "posizione poco chiara"
    if mate is not None:
        if int(mate) > 0:
            eval_part = "linea forzante con iniziativa decisiva"
        else:
            eval_part = "linea difensiva necessaria per limitare i danni"
    elif score_cp is not None:
        cp = int(score_cp)
        if cp >= 120:
            eval_part = "linea molto favorevole"
        elif cp >= 35:
            eval_part = "linea con vantaggio pratico"
        elif cp <= -120:
            eval_part = "linea critica da gestire con precisione"
        elif cp <= -35:
            eval_part = "linea solida ma leggermente inferiore"
        else:
            eval_part = "linea equilibrata"

    tactical_notes: list[str] = []
    if move_uci:
        try:
            move = chess.Move.from_uci(move_uci)
            if move in board.legal_moves:
                before_piece = board.piece_at(move.from_square)
                board_after = board.copy()
                is_capture = board_after.is_capture(move)
                is_castling = board_after.is_castling(move)
                board_after.push(move)
                gives_check = board_after.is_check()

                if before_piece is not None:
                    piece_name = before_piece.piece_type
                    if piece_name == chess.KNIGHT:
                        tactical_notes.append("attiva il cavallo verso case piu incisive")
                    elif piece_name == chess.BISHOP:
                        tactical_notes.append("migliora la diagonale dell'alfiere")
                    elif piece_name == chess.ROOK:
                        tactical_notes.append("coordina la torre su colonna o traversa utile")
                    elif piece_name == chess.QUEEN:
                        tactical_notes.append("coinvolge la donna mantenendo pressione")

                if is_capture:
                    tactical_notes.append("include una semplificazione tattica immediata")
                if gives_check:
                    tactical_notes.append("porta un tempo diretto sul re avversario")
                if is_castling:
                    tactical_notes.append("mette al sicuro il re e migliora il coordinamento")

                if board_after.is_attacked_by(not board.turn, move.to_square):
                    tactical_notes.append("richiede precisione perche il pezzo attivo puo essere contestato")
        except Exception:
            pass

    note_limit = 1 if detail_level == "breve" else 2
    if detail_level == "approfondita":
        note_limit = 3

    note_text = ""
    if tactical_notes:
        note_text = "; ".join(tactical_notes[:note_limit])

    if detail_level == "breve":
        return f"#{rank} {move_san}: {eval_part}."

    return (
        f"Linea #{rank}: {move_san}. Per {side} e una {eval_part}."
        + (f" In pratica, {note_text}." if note_text else "")
    )


def _file_name(f: int) -> str:
    return chr(ord("a") + f)


def _pawn_structure_notes(board: chess.Board, side: chess.Color) -> list[str]:
    notes: list[str] = []
    opp = not side

    side_pawns = board.pieces(chess.PAWN, side)
    opp_pawns = board.pieces(chess.PAWN, opp)

    own_files: dict[int, list[int]] = {}
    for sq in side_pawns:
        own_files.setdefault(chess.square_file(sq), []).append(chess.square_rank(sq))

    opp_files: dict[int, list[int]] = {}
    for sq in opp_pawns:
        opp_files.setdefault(chess.square_file(sq), []).append(chess.square_rank(sq))

    # Pedoni isolati
    isolated = [f for f in own_files if (f - 1) not in own_files and (f + 1) not in own_files]
    if isolated:
        names = ", ".join(_file_name(f) for f in isolated[:2])
        plural = "i" if len(isolated) > 1 else "o"
        notes.append(
            f"Pedone{plural} isolat{plural} in colonna {names}: debolezza fissa che l'avversario puo pressare "
            "con pezzi pesanti. Considera di scambiarlo o di compensare con maggiore attivita dei pezzi."
        )

    # Pedoni raddoppiati
    doubled = [f for f, ranks in own_files.items() if len(ranks) >= 2]
    if doubled:
        names = ", ".join(_file_name(f) for f in doubled[:2])
        notes.append(
            f"Pedoni raddoppiati in colonna {names}: la struttura e meno dinamica. "
            "Sfrutta la semicolonna aperta adiacente per compensare con attivita della torre."
        )

    # Pedoni passati
    passed: list[int] = []
    for sq in side_pawns:
        f = chess.square_file(sq)
        r = chess.square_rank(sq)
        is_passed = True
        for adj_f in (f - 1, f, f + 1):
            if adj_f < 0 or adj_f > 7:
                continue
            for opp_sq in opp_pawns:
                if chess.square_file(opp_sq) == adj_f:
                    opp_r = chess.square_rank(opp_sq)
                    if side == chess.WHITE and opp_r > r:
                        is_passed = False
                    elif side == chess.BLACK and opp_r < r:
                        is_passed = False
        if is_passed:
            passed.append(sq)

    if passed:
        sq_names = ", ".join(chess.square_name(sq) for sq in passed[:2])
        notes.append(
            f"Pedone passato in {sq_names}: asset decisivo nel finale. "
            "Supportalo con il re o con i pezzi pesanti e spingilo al momento opportuno."
        )

    # Case deboli (outpost avversario): case del tuo campo non difese da pedoni
    opp_outposts: list[str] = []
    own_half = range(0, 4) if side == chess.WHITE else range(4, 8)
    for rank in own_half:
        for filt in range(8):
            sq = chess.square(filt, rank)
            if board.piece_at(sq) is not None:
                continue
            # Pedone bianco sotto il rango può avanzare per contrastare la casa
            # Pedone nero sopra il rango può avanzare (verso il basso) per contrastare la casa
            if side == chess.WHITE:
                can_defend = any(
                    chess.square_file(p) in (filt - 1, filt + 1) and chess.square_rank(p) < rank
                    for p in side_pawns
                )
            else:
                can_defend = any(
                    chess.square_file(p) in (filt - 1, filt + 1) and chess.square_rank(p) > rank
                    for p in side_pawns
                )
            if not can_defend and board.is_attacked_by(opp, sq):
                opp_outposts.append(chess.square_name(sq))

    if opp_outposts:
        names = ", ".join(opp_outposts[:2])
        notes.append(
            f"Case deboli nel tuo campo in {names}: l'avversario potrebbe stabilirvi un pezzo. "
            "Cerca di chiuderle con pedoni o di controllarle con i tuoi pezzi."
        )

    return notes


def _piece_activity_notes(board: chess.Board, side: chess.Color) -> list[str]:
    notes: list[str] = []
    opp = not side
    own_pawns = board.pieces(chess.PAWN, side)
    own_pawn_files = {chess.square_file(sq) for sq in own_pawns}
    opp_pawn_files = {chess.square_file(sq) for sq in board.pieces(chess.PAWN, opp)}

    # Cavalli sul bordo
    rim_knights = [
        sq for sq in board.pieces(chess.KNIGHT, side)
        if chess.square_file(sq) in (0, 7) or chess.square_rank(sq) in (0, 7)
    ]
    if rim_knights:
        names = ", ".join(chess.square_name(sq) for sq in rim_knights[:2])
        notes.append(
            f"Cavallo ai margini ({names}): un cavallo sul bordo ha mobilita ridotta e difficilmente influenza "
            "il centro. Centralizzalo per massimizzarne il valore."
        )

    # Alfiere cattivo (bloccato da propri pedoni sulle stesse case colorate)
    for bishop_sq in board.pieces(chess.BISHOP, side):
        bishop_color = (chess.square_file(bishop_sq) + chess.square_rank(bishop_sq)) % 2
        blocked_own = sum(
            1 for p in own_pawns
            if (chess.square_file(p) + chess.square_rank(p)) % 2 == bishop_color
        )
        if blocked_own >= 4:
            # Verifica che l'alfiere sia davvero immobile (mobilità effettiva ridotta)
            reachable = sum(
                1 for tgt in board.attacks(bishop_sq)
                if board.piece_at(tgt) is None or board.piece_at(tgt).color == opp
            )
            if reachable <= 2:
                notes.append(
                    f"Alfiere cattivo in {chess.square_name(bishop_sq)}: i tuoi pedoni occupano "
                    "le stesse case colorate, limitandone le diagonali. Considera uno scambio o l'apertura di diagonali."
                )
                break

    # Torre su colonna aperta / semicolonna
    for rook_sq in board.pieces(chess.ROOK, side):
        f = chess.square_file(rook_sq)
        if f not in own_pawn_files and f not in opp_pawn_files:
            notes.append(
                f"Torre in {chess.square_name(rook_sq)} su colonna completamente aperta: "
                "sfrutta questa potenza avanzando o raddoppiando le torri."
            )
        elif f not in own_pawn_files:
            notes.append(
                f"Torre in {chess.square_name(rook_sq)} su semicolonna: "
                "pressione laterale gia presente, considera di ampliarla con raddoppio o invasione."
            )

    # Coppia degli alfieri
    bishops = board.pieces(chess.BISHOP, side)
    opp_bishops = board.pieces(chess.BISHOP, opp)
    if len(bishops) == 2 and len(opp_bishops) < 2:
        notes.append(
            "Coppia degli alfieri: vantaggio strutturale a lungo termine, "
            "soprattutto in posizioni aperte. Evita di cederla senza adeguata compensazione."
        )

    return notes


def _king_safety_notes(board: chess.Board, side: chess.Color) -> list[str]:
    notes: list[str] = []
    king_sq = board.king(side)
    if king_sq is None:
        return notes

    king_file = chess.square_file(king_sq)
    king_rank = chess.square_rank(king_sq)
    opp = not side
    own_pawns = board.pieces(chess.PAWN, side)
    own_pawn_files = {chess.square_file(sq) for sq in own_pawns}

    # Arrocco non ancora eseguito
    is_on_back_rank = (king_rank == 0 and side == chess.WHITE) or (king_rank == 7 and side == chess.BLACK)
    has_castled_likely = is_on_back_rank and king_file in (6, 2)
    can_castle = board.has_castling_rights(side)

    if not has_castled_likely and is_on_back_rank and can_castle:
        notes.append(
            "Arrocco disponibile ma non ancora eseguito: il re e esposto al centro. "
            "Dai priorita all'arrocco prima di aprire file centrali."
        )
    elif is_on_back_rank and not has_castled_likely and not can_castle:
        notes.append(
            "Re rimasto al centro senza piu possibilita di arrocare: massima attenzione "
            "all'apertura di colonne centrali, che diventerebbero corridoi d'attacco."
        )

    # Colonne aperte vicino al re arroccato
    if has_castled_likely:
        exposed = [
            _file_name(f)
            for f in range(max(0, king_file - 1), min(8, king_file + 2))
            if f not in own_pawn_files
        ]
        enemy_heavy = bool(board.pieces(chess.ROOK, opp) | board.pieces(chess.QUEEN, opp))
        if exposed and enemy_heavy:
            names = ", ".join(exposed)
            notes.append(
                f"Colonna/e {names} aperta/e vicino al re arroccato e pezzi pesanti avversari attivi: "
                "il re e piu vulnerabile del normale. Valuta di chiudere la colonna o di difendere con pedoni/pezzi."
            )

    return notes


def _tactical_motif_notes(board: chess.Board, side: chess.Color) -> list[str]:
    notes: list[str] = []
    opp = not side

    # Inchiodatura assoluta: usa il rilevamento nativo python-chess (pin contro il re)
    king_sq = board.king(side)
    pins: list[str] = []
    if king_sq is not None:
        for sq, piece in board.piece_map().items():
            if piece.color != side or piece.piece_type == chess.KING:
                continue
            if not board.is_pinned(side, sq):
                continue
            # Trova il pezzo inchiodante tramite pin mask
            pin_mask = board.pin(side, sq)
            pinner_sq = None
            pinner_piece = None
            for psq in chess.SquareSet(pin_mask):
                pp = board.piece_at(psq)
                if pp and pp.color == opp and pp.piece_type in (chess.BISHOP, chess.ROOK, chess.QUEEN):
                    pinner_sq = psq
                    pinner_piece = pp
                    break
            p_name = chess.piece_name(piece.piece_type).capitalize()
            if pinner_sq is not None and pinner_piece is not None:
                att_name = chess.piece_name(pinner_piece.piece_type).capitalize()
                pins.append(
                    f"{p_name} in {chess.square_name(sq)} inchiodato da "
                    f"{att_name} in {chess.square_name(pinner_sq)} sul re in {chess.square_name(king_sq)}"
                )
            else:
                pins.append(
                    f"{p_name} in {chess.square_name(sq)} inchiodato sul re in {chess.square_name(king_sq)}"
                )

    if pins:
        notes.append(
            f"Inchiodatura: {pins[0]}. Risolvila prima di muovere altri pezzi, "
            "altrimenti l'avversario puo sfruttarla per guadagnare materiale o tempo."
        )

    # Forcella attiva: pezzo che attacca gia 2+ pezzi avversari
    for sq, piece in board.piece_map().items():
        if piece.color != side:
            continue
        attacked_enemies = [
            tgt for tgt in board.attacks(sq)
            if board.piece_at(tgt) and board.piece_at(tgt).color == opp
            and board.piece_at(tgt).piece_type != chess.PAWN
        ]
        if len(attacked_enemies) >= 2:
            targets = " e ".join(chess.square_name(t) for t in attacked_enemies[:2])
            notes.append(
                f"Forcella attiva: {chess.piece_name(piece.piece_type).capitalize()} in {chess.square_name(sq)} "
                f"attacca gia {targets}. Sfrutta questa pressione per guadagnare materiale o tempi."
            )
            break

    # Pezzo sovraccariato (difende 2+ pezzi attaccati)
    attacked_own = [
        sq for sq, p in board.piece_map().items()
        if p.color == side and board.is_attacked_by(opp, sq)
    ]
    if len(attacked_own) >= 2:
        defender_map: dict[int, list[int]] = {}
        for atk_sq in attacked_own:
            for d in board.attackers(side, atk_sq):
                p = board.piece_at(d)
                if p and p.piece_type != chess.KING:
                    defender_map.setdefault(d, []).append(atk_sq)
        for d_sq, defended_sqs in defender_map.items():
            if len(defended_sqs) >= 2:
                d_piece = board.piece_at(d_sq)
                if d_piece:
                    defended_names = " e ".join(chess.square_name(s) for s in defended_sqs[:2])
                    notes.append(
                        f"Pezzo sovraccariato: {chess.piece_name(d_piece.piece_type).capitalize()} in "
                        f"{chess.square_name(d_sq)} difende sia {defended_names}. "
                        "Un attacco su uno dei due obiettivi puo sfruttare questa debolezza."
                    )
                    break

    # Debolezza retroguardia
    own_back = 0 if side == chess.WHITE else 7
    shield_rank = 1 if side == chess.WHITE else 6
    back_shield = [sq for sq in board.pieces(chess.PAWN, side) if chess.square_rank(sq) == shield_rank]
    if not back_shield and (board.pieces(chess.ROOK, opp) | board.pieces(chess.QUEEN, opp)):
        notes.append(
            "Retroguardia esposta: il re non ha pedoni di protezione sulla seconda traversa. "
            "Attento alle manovre di matto di retroguardia con torre o donna avversaria."
        )

    return notes


def _ideas_section(
    board: chess.Board,
    side: chess.Color,
    phase: str,
    evaluation: dict[str, Any] | None,
    best_move_san: str | None,
    top_lines: list[dict[str, Any]],
    detail_level: str,
) -> str:
    ideas: list[str] = []

    if phase == "apertura":
        ideas.append("termina lo sviluppo dei pezzi minori e pianifica l'arrocco prima di lanciare attacchi")
        ideas.append("non muovere lo stesso pezzo due volte senza guadagno tattico preciso")
        ideas.append("consolida il controllo del centro con pedoni o minacce di cattura prima di aprire file laterali")
    elif phase == "mediogioco":
        ideas.append("individua la debolezza strutturale piu evidente dell'avversario e puntala con due o piu pezzi")
        ideas.append("cerca la casa forte ideale per il cavallo o l'alfiere migliore e portaci il pezzo con tempi guadagnati")
        ideas.append("coordina torre e donna su file o diagonali semi-aperti in direzione del re avversario")
    else:
        ideas.append("attiva il re come pezzo offensivo centralizzandolo")
        ideas.append("crea un pedone passato o impedisci quello avversario ora che i pezzi si semplificano")
        ideas.append("semplifica verso finale tecnico se sei in vantaggio, genera complicazioni se sei sotto")

    if evaluation and evaluation.get("type") == "cp":
        side_cp = int(evaluation.get("value") or 0)
        if side == chess.BLACK:
            side_cp = -side_cp
        if side_cp > 150:
            ideas.append(
                "con questo vantaggio puoi permetterti di semplificare: scambia pezzi attivi avversari "
                "senza cedere l'iniziativa, poi converti nel finale"
            )
        elif side_cp < -150:
            ideas.append(
                "sei sotto: non giocare passivamente, genera tensione e complicazioni per aumentare "
                "le possibilita di errore avversario"
            )

    if best_move_san and top_lines and len(top_lines) >= 2 and detail_level != "breve":
        line2 = top_lines[1]
        m2 = line2.get("move_san") or line2.get("move_uci") or ""
        if m2 and m2 != best_move_san:
            c1 = top_lines[0].get("score_cp")
            c2 = line2.get("score_cp")
            if c1 is not None and c2 is not None and abs(int(c1) - int(c2)) <= 20:
                ideas.append(
                    f"sia {best_move_san} che {m2} sono opzioni quasi equivalenti: scegli in base "
                    "alla struttura che preferisci giocare nel medio termine"
                )

    if detail_level == "breve":
        return "Idee: " + "; ".join(ideas[:2]) + "."
    if detail_level == "approfondita":
        return "Idee e piano operativo: " + "; ".join(ideas[:4]) + "."
    return "Idee per i prossimi tratti: " + "; ".join(ideas[:3]) + "."


def _build_narrative_sections(
    board: chess.Board,
    plans: dict[str, Any],
    alerts: list[str],
    top_lines: list[dict[str, Any]],
    best_move_san: str | None,
    evaluation: dict[str, Any] | None,
    detail_level: str,
) -> list[str]:
    side = board.turn
    side_name = "Bianco" if side == chess.WHITE else "Nero"
    phase = plans.get("phase", "mediogioco")
    sections: list[str] = []

    # --- SEZIONE 1: Struttura della posizione ---
    struct_notes = _pawn_structure_notes(board, side)
    activity_notes = _piece_activity_notes(board, side)
    king_notes = _king_safety_notes(board, side)
    all_struct = struct_notes + activity_notes + king_notes

    if all_struct:
        if detail_level == "breve":
            sections.append("Struttura: " + all_struct[0])
        elif detail_level == "approfondita":
            sections.append("Analisi strutturale — " + " ".join(all_struct))
        else:
            sections.append("Struttura della posizione: " + " ".join(all_struct[:3]))
    else:
        if detail_level != "breve":
            sections.append(
                f"La struttura di {side_name} non presenta debolezze evidenti: "
                "punta sulla qualita delle singole mosse e sulla migliore coordinazione dei pezzi."
            )

    # --- SEZIONE 2: Motivi tattici presenti ---
    motif_notes = _tactical_motif_notes(board, side)
    if motif_notes:
        if detail_level == "breve":
            sections.append("Tattica: " + motif_notes[0])
        elif detail_level == "approfondita":
            sections.append("Motivi tattici da sfruttare: " + " ".join(motif_notes))
        else:
            sections.append("Motivi tattici presenti: " + " ".join(motif_notes[:2]))
    elif detail_level == "approfondita":
        sections.append(
            "Nessun motivo tattico immediato sfruttabile: la posizione richiede "
            "approccio strategico a medio-lungo raggio."
        )

    # --- SEZIONE 3: Idee concrete ---
    sections.append(
        _ideas_section(board, side, phase, evaluation, best_move_san, top_lines, detail_level)
    )

    # --- SEZIONE 4 (approfondita): Confronto linee candidate con contesto ---
    if detail_level == "approfondita" and top_lines and len(top_lines) >= 2:
        m1 = top_lines[0].get("move_san") or top_lines[0].get("move_uci") or "?"
        m2 = top_lines[1].get("move_san") or top_lines[1].get("move_uci") or "?"
        c1 = top_lines[0].get("score_cp")
        c2 = top_lines[1].get("score_cp")
        if c1 is not None and c2 is not None:
            diff = abs(int(c1) - int(c2))
            if diff <= 15:
                sections.append(
                    f"Le prime due linee ({m1} e {m2}) sono praticamente equivalenti (differenza < 0.15 pedoni): "
                    "la scelta e stilistica, non oggettiva. Opta per quella che porta la posizione che sai giocare meglio."
                )
            else:
                better = m1 if int(c1) >= int(c2) else m2
                worse = m2 if better == m1 else m1
                sections.append(
                    f"{better} offre un vantaggio pratico misurabile rispetto a {worse}: "
                    "le alternative restano giocabili ma richiedono gioco piu preciso nelle mosse successive."
                )

    return sections

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
def analyze_deep(
    fen: str,
    depth: int = 16,
    multi_pv: int = 3,
    detail_level: str = "coach",
):
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
    detail_level = _normalize_detail_level(detail_level)

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
            top_lines = _normalize_top_moves(board, sf, top_moves_raw, best_move, evaluation)
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
                    top_lines = _normalize_top_moves(board, sf2, None, best_move, evaluation)
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
    narrative_sections = _build_narrative_sections(
        board,
        plans,
        alerts,
        top_lines,
        best_move_san,
        evaluation,
        detail_level,
    )

    for idx, line in enumerate(top_lines):
        line["commentary"] = _describe_top_line(board, line, idx + 1, detail_level)

    return {
        "fen": fen,
        "depth": depth,
        "multi_pv": multi_pv,
        "detail_level": detail_level,
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
        "narrative_sections": narrative_sections,
        "engine_error": engine_error,
    }