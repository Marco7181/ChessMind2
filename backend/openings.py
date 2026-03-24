from fastapi import APIRouter
from pydantic import BaseModel
import re
import json
import urllib.parse
import urllib.request
import chess
import csv
from pathlib import Path

router = APIRouter()

OPENINGS_DB = [
    {"key": "ruy_lopez", "eco": "C60", "name": "Apertura Spagnola (Ruy Lopez)", "moves": ["e4", "e5", "Nf3", "Nc6", "Bb5"]},
    {"key": "italian_game", "eco": "C50", "name": "Partita Italiana", "moves": ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]},
    {"key": "giuoco_piano", "eco": "C54", "name": "Giuoco Piano", "moves": ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3"]},
    {"key": "evans_gambit", "eco": "C51", "name": "Gambetto Evans", "moves": ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4"]},
    {"key": "scotch_game", "eco": "C44", "name": "Partita Scozzese", "moves": ["e4", "e5", "Nf3", "Nc6", "d4"]},
    {"key": "four_knights", "eco": "C47", "name": "Partita dei Quattro Cavalli", "moves": ["e4", "e5", "Nf3", "Nc6", "Nc3", "Nf6"]},
    {"key": "petrov", "eco": "C42", "name": "Difesa Petrov", "moves": ["e4", "e5", "Nf3", "Nf6"]},
    {"key": "philidor", "eco": "C41", "name": "Difesa Philidor", "moves": ["e4", "e5", "Nf3", "d6"]},
    {"key": "sicilian_defense", "eco": "B20", "name": "Difesa Siciliana", "moves": ["e4", "c5"]},
    {"key": "sicilian_najdorf", "eco": "B90", "name": "Siciliana Najdorf", "moves": ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"]},
    {"key": "sicilian_dragon", "eco": "B70", "name": "Siciliana Dragone", "moves": ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "g6"]},
    {"key": "french_defense", "eco": "C00", "name": "Difesa Francese", "moves": ["e4", "e6", "d4", "d5"]},
    {"key": "french_advance", "eco": "C02", "name": "Francese Variante Avanzata", "moves": ["e4", "e6", "d4", "d5", "e5"]},
    {"key": "caro_kann", "eco": "B10", "name": "Difesa Caro-Kann", "moves": ["e4", "c6", "d4", "d5"]},
    {"key": "caro_advance", "eco": "B12", "name": "Caro-Kann Variante Avanzata", "moves": ["e4", "c6", "d4", "d5", "e5"]},
    {"key": "pirc_defense", "eco": "B07", "name": "Difesa Pirc", "moves": ["e4", "d6", "d4", "Nf6", "Nc3", "g6"]},
    {"key": "modern_defense", "eco": "B06", "name": "Difesa Moderna", "moves": ["e4", "g6", "d4", "Bg7"]},
    {"key": "alekhine_defense", "eco": "B02", "name": "Difesa Alekhine", "moves": ["e4", "Nf6"]},
    {"key": "scandinavian_defense", "eco": "B01", "name": "Difesa Scandinava", "moves": ["e4", "d5"]},
    {"key": "horwitz_defense", "eco": "A40", "name": "Difesa Horwitz (1...e6 contro d4)", "moves": ["d4", "e6"]},
    {"key": "horwitz_fianchetto_setup", "eco": "A40", "name": "Partita di Donna: setup Horwitz con ...g6", "moves": ["d4", "e6", "Nf3", "d5", "e3", "Nf6", "Bd3", "g6"]},
    {"key": "queens_gambit", "eco": "D06", "name": "Gambetto di Donna", "moves": ["d4", "d5", "c4"]},
    {"key": "qgd_orthodox", "eco": "D63", "name": "Gambetto di Donna Rifiutato", "moves": ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "Bg5", "Be7"]},
    {"key": "qga", "eco": "D20", "name": "Gambetto di Donna Accettato", "moves": ["d4", "d5", "c4", "dxc4"]},
    {"key": "slav_defense", "eco": "D10", "name": "Difesa Slava", "moves": ["d4", "d5", "c4", "c6"]},
    {"key": "semi_slav", "eco": "D43", "name": "Difesa Semi-Slava", "moves": ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "Nf3", "c6"]},
    {"key": "nimzo_indian", "eco": "E20", "name": "Difesa Nimzo-Indiana", "moves": ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"]},
    {"key": "queens_indian", "eco": "E12", "name": "Difesa Indiana di Donna", "moves": ["d4", "Nf6", "c4", "e6", "Nf3", "b6"]},
    {"key": "kings_indian", "eco": "E60", "name": "Difesa Indiana di Re", "moves": ["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6"]},
    {"key": "grunfeld", "eco": "D70", "name": "Difesa Grünfeld", "moves": ["d4", "Nf6", "c4", "g6", "Nc3", "d5"]},
    {"key": "benoni", "eco": "A60", "name": "Difesa Benoni", "moves": ["d4", "Nf6", "c4", "c5", "d5"]},
    {"key": "benko_gambit", "eco": "A57", "name": "Gambetto Benko", "moves": ["d4", "Nf6", "c4", "c5", "d5", "b5"]},
    {"key": "english_opening", "eco": "A10", "name": "Apertura Inglese", "moves": ["c4"]},
    {"key": "reti_opening", "eco": "A04", "name": "Apertura Réti", "moves": ["Nf3", "d5", "c4"]},
    {"key": "london_system", "eco": "D02", "name": "Sistema Londra", "moves": ["d4", "d5", "Nf3", "Nf6", "Bf4"]},
    {"key": "bird_opening", "eco": "A02", "name": "Apertura Bird", "moves": ["f4"]},
    {"key": "catalan_opening", "eco": "E00", "name": "Apertura Catalana", "moves": ["d4", "Nf6", "c4", "e6", "g3"]},
    {"key": "vienna_game", "eco": "C25", "name": "Partita Viennese", "moves": ["e4", "e5", "Nc3"]},
]

OPENINGS_DATA_DIR = Path(__file__).resolve().parent / "data" / "openings"

_PUNCT = re.compile(r"[+#?!]+")


class OpeningDetectRequest(BaseModel):
    moves: list[str] = []


def _normalize_san(move: str) -> str:
    if not move:
        return ""
    mv = move.strip()
    mv = _PUNCT.sub("", mv)
    return mv


def _normalize_moves(moves: list[str]) -> list[str]:
    return [_normalize_san(m) for m in moves if _normalize_san(m)]


def _best_opening_match(moves: list[str]):
    if not moves:
        return None, 0
    best = None
    best_len = 0
    for opening in OPENINGS_DB:
        ref = opening["moves"]
        max_len = min(len(moves), len(ref))
        if max_len == 0:
            continue
        if moves[:max_len] == ref[:max_len] and max_len > best_len:
            best = opening
            best_len = max_len
    return best, best_len


def _pgn_line_to_moves(pgn_line: str) -> list[str]:
    if not pgn_line:
        return []
    cleaned = pgn_line.strip()
    # Rimuove numeri mossa, risultati e notazioni accessorie.
    cleaned = re.sub(r"\{[^}]*\}", " ", cleaned)
    cleaned = re.sub(r"\([^)]*\)", " ", cleaned)
    cleaned = re.sub(r"\d+\.\.\.|\d+\.", " ", cleaned)
    tokens = [t for t in cleaned.split() if t and t not in {"1-0", "0-1", "1/2-1/2", "*"}]
    return [_normalize_san(t) for t in tokens if _normalize_san(t)]


def _load_external_openings() -> list[dict]:
    loaded: list[dict] = []
    if not OPENINGS_DATA_DIR.exists():
        return loaded

    for code in ("a", "b", "c", "d", "e"):
        file_path = OPENINGS_DATA_DIR / f"{code}.tsv"
        if not file_path.exists():
            continue

        with file_path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f, delimiter="\t")
            for row in reader:
                eco = (row.get("eco") or "").strip()
                name = (row.get("name") or "").strip()
                pgn = (row.get("pgn") or "").strip()
                if not eco or not name or not pgn:
                    continue

                moves = _pgn_line_to_moves(pgn)
                if not moves:
                    continue

                key = re.sub(r"[^a-z0-9]+", "_", f"{eco}_{name}".lower()).strip("_")
                loaded.append(
                    {
                        "key": key,
                        "eco": eco,
                        "name": name,
                        "moves": moves,
                    }
                )

    return loaded


def _merge_opening_databases() -> None:
    external = _load_external_openings()
    if not external:
        return

    existing_signatures = {
        (item.get("eco", ""), item.get("name", ""), tuple(item.get("moves") or []))
        for item in OPENINGS_DB
    }

    for item in external:
        signature = (item.get("eco", ""), item.get("name", ""), tuple(item.get("moves") or []))
        if signature in existing_signatures:
            continue
        OPENINGS_DB.append(item)
        existing_signatures.add(signature)


_merge_opening_databases()


def _san_moves_to_uci(moves: list[str]) -> list[str] | None:
    board = chess.Board()
    uci_moves: list[str] = []
    try:
        for san in moves:
            move = board.parse_san(san)
            uci_moves.append(move.uci())
            board.push(move)
    except Exception:
        return None
    return uci_moves


def _lookup_opening_online(moves: list[str]) -> dict | None:
    """Tenta rilevamento apertura via Lichess Opening Explorer.

    Restituisce None se non disponibile/offline/non trovata.
    """
    if not moves:
        return None

    uci_moves = _san_moves_to_uci(moves)
    if not uci_moves:
        return None

    params = urllib.parse.urlencode(
        {
            "play": ",".join(uci_moves),
            "variant": "standard",
            "topGames": 0,
            "recentGames": 0,
        }
    )
    url = f"https://explorer.lichess.ovh/lichess?{params}"

    try:
        with urllib.request.urlopen(url, timeout=2.5) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None

    opening = data.get("opening") if isinstance(data, dict) else None
    if not opening:
        return None

    eco = opening.get("eco") or "-"
    name = opening.get("name") or "Apertura riconosciuta"
    key = f"online_{eco}_{re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')}"

    return {
        "found": True,
        "key": key,
        "name": name,
        "eco": eco,
        "line": moves,
        "matched_moves": len(moves),
        "input_moves": len(moves),
        "completion_pct": 100,
        "source": "online",
    }


@router.get("/")
def list_openings():
    return {"count": len(OPENINGS_DB), "openings": OPENINGS_DB}


@router.post("/detect")
def detect_opening(payload: OpeningDetectRequest):
    moves = _normalize_moves(payload.moves)
    opening, matched_len = _best_opening_match(moves)

    if not opening:
        online = _lookup_opening_online(moves)
        if online:
            return online
        return {
            "found": False,
            "name": "Fuori libro",
            "eco": "-",
            "matched_moves": 0,
            "input_moves": len(moves),
            "completion_pct": 0,
            "source": "local",
        }

    completion = 0
    if opening["moves"]:
        completion = int(round((matched_len / len(opening["moves"])) * 100))

    return {
        "found": True,
        "key": opening["key"],
        "name": opening["name"],
        "eco": opening["eco"],
        "line": opening["moves"],
        "matched_moves": matched_len,
        "input_moves": len(moves),
        "completion_pct": completion,
        "source": "local",
    }


@router.get("/{name}")
def get_opening(name: str):
    key = (name or "").strip().lower()
    opening = next((item for item in OPENINGS_DB if item["key"] == key), None)
    if not opening:
        return {"name": name, "moves": []}
    return {"name": opening["name"], "eco": opening["eco"], "moves": opening["moves"]}