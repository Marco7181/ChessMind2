from fastapi import APIRouter
from fastapi import HTTPException
import chess
import chess.pgn
import csv
import io
import json
import random
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

import zstandard
from stockfish import Stockfish

router = APIRouter()
stockfish = Stockfish()

LICHESS_PUZZLE_DB_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
PUZZLE_CACHE_PATH = Path(__file__).resolve().parent / "data" / "lichess_puzzles.json"
SUPPORTED_PUZZLE_THEMES = {
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
}
EXCLUDED_PUZZLE_THEMES = {
    "quietmove",
    "defensivemove",
    "onemove",
}


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _build_puzzle_description(themes: list[str], rating: int | None) -> str:
    parts = ["Lichess Puzzle"]
    if rating is not None:
        parts.append(f"Rating {rating}")
    if themes:
        parts.append(", ".join(themes[:3]))
    return " - ".join(parts)


def _is_supported_puzzle(puzzle: dict) -> bool:
    themes = [str(theme).strip().lower() for theme in (puzzle.get("themes") or []) if theme]
    rating = puzzle.get("rating")
    solution = puzzle.get("solution") or []

    if len(solution) < 4 or len(solution) > 12:
        return False
    if rating is not None and (rating < 1200 or rating > 2800):
        return False
    if any(theme in EXCLUDED_PUZZLE_THEMES for theme in themes):
        return False
    if themes and not any(theme in SUPPORTED_PUZZLE_THEMES for theme in themes):
        return False

    return True


def _normalize_db_row(row: dict) -> dict | None:
    fen = (row.get("FEN") or "").strip()
    moves_raw = (row.get("Moves") or "").strip()
    puzzle_id = (row.get("PuzzleId") or "").strip()
    if not fen or not moves_raw or not puzzle_id:
        return None

    try:
        board = chess.Board(fen)
    except ValueError:
        return None

    solution = [move.strip().lower() for move in moves_raw.split() if move.strip()]
    if not solution:
        return None

    starting_side = "w" if board.turn else "b"
    for move_uci in solution:
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return None
        if move not in board.legal_moves:
            return None
        board.push(move)

    themes = [theme for theme in (row.get("Themes") or "").split() if theme]
    normalized_themes = [theme.strip().lower() for theme in themes]
    is_checkmate = board.is_checkmate()
    if any(theme.startswith("mate") for theme in normalized_themes) and not is_checkmate:
        return None
    if is_checkmate:
        winning_side = "b" if board.turn else "w"
        if winning_side != starting_side:
            return None

    rating = _safe_int(row.get("Rating"), None)
    game_url = (row.get("GameUrl") or "").strip()
    game_id = ""
    if game_url:
        parsed = urlparse(game_url)
        game_id = parsed.path.strip("/").split("/")[0] if parsed.path else ""

    return {
        "id": puzzle_id,
        "description": _build_puzzle_description(themes, rating),
        "fen": fen,
        "solution": solution,
        "themes": themes,
        "rating": rating,
        "popularity": _safe_int(row.get("Popularity"), None),
        "plays": _safe_int(row.get("NbPlays"), None),
        "game_id": game_id,
        "game_url": game_url,
        "source": "lichess-db",
    }


def _download_lichess_puzzle_sample(
    sample_size: int = 200,
    scan_rows: int = 20000,
    rating_min: int | None = None,
    rating_max: int | None = None,
    theme: str | None = None,
) -> tuple[list[dict], dict]:
    sample_size = max(1, min(int(sample_size), 200))
    scan_rows = max(sample_size, min(int(scan_rows), 50000))
    theme_filter = (theme or "").strip().lower()

    selected: list[dict] = []
    matched_rows = 0
    scanned_rows = 0

    try:
        with urlopen(LICHESS_PUZZLE_DB_URL, timeout=30) as response:
            dctx = zstandard.ZstdDecompressor()
            with dctx.stream_reader(response) as reader:
                text_stream = io.TextIOWrapper(reader, encoding="utf-8")
                csv_reader = csv.DictReader(text_stream)

                for row in csv_reader:
                    scanned_rows += 1
                    if scanned_rows > scan_rows:
                        break

                    puzzle = _normalize_db_row(row)
                    if not puzzle:
                        continue
                    if not _is_supported_puzzle(puzzle):
                        continue

                    rating = puzzle.get("rating")
                    if rating_min is not None and (rating is None or rating < rating_min):
                        continue
                    if rating_max is not None and (rating is None or rating > rating_max):
                        continue
                    if theme_filter and theme_filter not in {
                        item.lower() for item in puzzle.get("themes", [])
                    }:
                        continue

                    matched_rows += 1
                    if len(selected) < sample_size:
                        selected.append(puzzle)
                        continue

                    replacement_index = random.randint(0, matched_rows - 1)
                    if replacement_index < sample_size:
                        selected[replacement_index] = puzzle
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Errore download database puzzle Lichess: {exc}",
        ) from exc

    if not selected:
        raise HTTPException(
            status_code=502,
            detail="Nessun puzzle valido trovato nel database Lichess",
        )

    PUZZLE_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    cache_payload = {
        "source": "lichess-db",
        "sample_size": len(selected),
        "scan_rows": scanned_rows,
        "matched_rows": matched_rows,
        "theme": theme_filter or None,
        "rating_min": rating_min,
        "rating_max": rating_max,
        "puzzles": selected,
    }
    PUZZLE_CACHE_PATH.write_text(
        json.dumps(cache_payload, ensure_ascii=True, indent=2),
        encoding="utf-8",
    )

    return selected, {
        "sample_size": len(selected),
        "scan_rows": scanned_rows,
        "matched_rows": matched_rows,
        "cache_path": str(PUZZLE_CACHE_PATH),
        "theme": theme_filter or None,
        "rating_min": rating_min,
        "rating_max": rating_max,
    }


def _load_cached_puzzle_library() -> list[dict]:
    if not PUZZLE_CACHE_PATH.exists():
        return []

    try:
        payload = json.loads(PUZZLE_CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []

    puzzles = payload.get("puzzles") if isinstance(payload, dict) else payload
    if not isinstance(puzzles, list):
        return []

    return [p for p in puzzles if isinstance(p, dict) and _is_supported_puzzle(p)]


@router.get("/lichess/daily")
def get_lichess_daily_puzzle():
    try:
        with urlopen("https://lichess.org/api/puzzle/daily", timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Errore fetch Lichess: {exc}")

    puzzle = payload.get("puzzle") or {}
    game = payload.get("game") or {}
    pgn = game.get("pgn")
    solution = puzzle.get("solution") or []
    initial_ply = int(puzzle.get("initialPly") or 0)

    if not pgn or not solution:
        raise HTTPException(status_code=502, detail="Payload Lichess incompleto")

    parsed_game = chess.pgn.read_game(io.StringIO(pgn))
    if parsed_game is None:
        raise HTTPException(status_code=502, detail="PGN Lichess non valido")

    board = chess.Board()
    moves = list(parsed_game.mainline_moves())

    for move in moves[:initial_ply]:
        if move in board.legal_moves:
            board.push(move)
        else:
            raise HTTPException(status_code=502, detail="Sequenza mosse Lichess non valida")

    themes = puzzle.get("themes") or []
    description = "Lichess Daily"
    if themes:
        description = f"Lichess Daily - {', '.join(themes[:3])}"

    return {
        "id": puzzle.get("id", "lichess-daily"),
        "description": description,
        "fen": board.fen(),
        "solution": solution,
        "source": "lichess",
    }


@router.post("/lichess/import")
def import_lichess_puzzles(
    sample_size: int = 200,
    scan_rows: int = 20000,
    rating_min: int | None = None,
    rating_max: int | None = None,
    theme: str | None = None,
):
    puzzles, metadata = _download_lichess_puzzle_sample(
        sample_size=sample_size,
        scan_rows=scan_rows,
        rating_min=rating_min,
        rating_max=rating_max,
        theme=theme,
    )

    return {
        "imported": len(puzzles),
        "metadata": metadata,
        "puzzles": puzzles,
    }


@router.get("/lichess/library")
def get_lichess_puzzle_library(
    limit: int = 200,
    refresh: bool = False,
    sample_size: int = 200,
    scan_rows: int = 20000,
    rating_min: int | None = None,
    rating_max: int | None = None,
    theme: str | None = None,
):
    puzzles = [] if refresh else _load_cached_puzzle_library()

    if not puzzles:
        puzzles, _ = _download_lichess_puzzle_sample(
            sample_size=sample_size,
            scan_rows=scan_rows,
            rating_min=rating_min,
            rating_max=rating_max,
            theme=theme,
        )

    safe_limit = max(1, min(int(limit), len(puzzles)))
    return {
        "source": "lichess-db",
        "count": safe_limit,
        "puzzles": puzzles[:safe_limit],
    }

@router.get("/")
def generate_puzzle():
    board = chess.Board()

    # Genera posizione casuale
    for _ in range(random.randint(6, 12)):
        if board.is_game_over():
            break
        move = random.choice(list(board.legal_moves))
        board.push(move)

    # Analizza la posizione per trovare la mossa migliore
    fen = board.fen()
    stockfish.set_fen_position(fen)
    best_move = stockfish.get_best_move()

    return {
        "fen": fen,
        "best_move": best_move
    }
