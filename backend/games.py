from datetime import datetime, timezone
import json
from typing import Any
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, Header, HTTPException, Query

router = APIRouter()


DRAW_RESULTS = {
    "agreed",
    "stalemate",
    "repetition",
    "timevsinsufficient",
    "insufficient",
    "50move",
    "abandoned",
}

LOSS_RESULTS = {
    "checkmated",
    "resigned",
    "timeout",
    "lose",
    "kingofthehill",
    "threecheck",
    "bughousepartnerlose",
}


def _sanitize_username(username: str) -> str:
    cleaned = (username or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Username obbligatorio")

    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    if any(ch not in allowed for ch in cleaned):
        raise HTTPException(status_code=400, detail="Username contiene caratteri non validi")

    return cleaned


def _request_text(url: str, headers: dict[str, str] | None = None) -> str:
    request_headers = {"User-Agent": "ChessMind2/1.0"}
    if headers:
        request_headers.update(headers)

    request = Request(url, headers=request_headers)

    try:
        with urlopen(request, timeout=15) as response:
            return response.read().decode("utf-8")
    except HTTPError as exc:
        raise HTTPException(
            status_code=exc.code,
            detail=f"Errore richiesta verso provider esterno: HTTP {exc.code}",
        )
    except URLError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Provider esterno non raggiungibile: {exc.reason}",
        )


def _request_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    body = _request_text(url, headers=headers)
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Risposta JSON non valida dal provider")


def _iso_from_epoch_seconds(value: int | float | None) -> str | None:
    if not value:
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()


def _iso_from_epoch_millis(value: int | float | None) -> str | None:
    if not value:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


def _chesscom_outcome(player_result: str) -> str:
    normalized = (player_result or "").lower()
    if normalized == "win":
        return "win"
    if normalized in DRAW_RESULTS:
        return "draw"
    if normalized in LOSS_RESULTS:
        return "loss"
    return "unknown"


def _normalize_chesscom_game(game: dict[str, Any], username: str) -> dict[str, Any] | None:
    white = game.get("white") or {}
    black = game.get("black") or {}

    white_name = (white.get("username") or "White").strip()
    black_name = (black.get("username") or "Black").strip()

    uname = username.lower()
    if white_name.lower() == uname:
        player_color = "white"
        player_result = white.get("result") or ""
        opponent = black_name
    elif black_name.lower() == uname:
        player_color = "black"
        player_result = black.get("result") or ""
        opponent = white_name
    else:
        return None

    return {
        "id": game.get("uuid") or game.get("url") or "",
        "platform": "chess.com",
        "player_color": player_color,
        "opponent": opponent,
        "result": _chesscom_outcome(player_result),
        "time_class": game.get("time_class") or "",
        "rated": bool(game.get("rated")),
        "played_at": _iso_from_epoch_seconds(game.get("end_time")),
        "url": game.get("url") or "",
        "pgn": game.get("pgn") or "",
    }


def _normalize_lichess_game(game: dict[str, Any], username: str) -> dict[str, Any] | None:
    players = game.get("players") or {}
    white = players.get("white") or {}
    black = players.get("black") or {}

    white_name = ((white.get("user") or {}).get("name") or "White").strip()
    black_name = ((black.get("user") or {}).get("name") or "Black").strip()

    uname = username.lower()
    if white_name.lower() == uname:
        player_color = "white"
        opponent = black_name
    elif black_name.lower() == uname:
        player_color = "black"
        opponent = white_name
    else:
        return None

    winner = (game.get("winner") or "").lower()
    if not winner:
        result = "draw"
    elif winner == player_color:
        result = "win"
    else:
        result = "loss"

    game_id = game.get("id") or ""
    speed = game.get("speed") or game.get("perf") or ""

    return {
        "id": game_id,
        "platform": "lichess",
        "player_color": player_color,
        "opponent": opponent,
        "result": result,
        "time_class": speed,
        "rated": bool(game.get("rated")),
        "played_at": _iso_from_epoch_millis(game.get("createdAt")),
        "url": f"https://lichess.org/{game_id}" if game_id else "",
        "pgn": game.get("pgn") or "",
    }


@router.get("/chesscom/{username}")
def get_chesscom_games(username: str, limit: int = Query(default=25, ge=1, le=200)):
    user = _sanitize_username(username)
    archives_url = f"https://api.chess.com/pub/player/{quote(user.lower())}/games/archives"
    archives_payload = _request_json(archives_url)

    archive_urls = archives_payload.get("archives")
    if not isinstance(archive_urls, list):
        raise HTTPException(status_code=404, detail="Utente non trovato su Chess.com")

    collected: list[dict[str, Any]] = []

    for archive_url in reversed(archive_urls):
        month_payload = _request_json(archive_url)
        month_games = month_payload.get("games") or []

        for game in reversed(month_games):
            normalized = _normalize_chesscom_game(game, user)
            if normalized is None:
                continue
            collected.append(normalized)
            if len(collected) >= limit:
                break

        if len(collected) >= limit:
            break

    return {
        "platform": "chess.com",
        "username": user,
        "count": len(collected),
        "games": collected,
    }


@router.get("/lichess/{username}")
def get_lichess_games(
    username: str,
    max_games: int = Query(default=25, ge=1, le=200),
    x_lichess_token: str | None = Header(default=None),
):
    user = _sanitize_username(username)

    params = {
        "max": max_games,
        "pgnInJson": "true",
        "opening": "true",
        "clocks": "false",
        "evals": "false",
    }
    url = f"https://lichess.org/api/games/user/{quote(user)}?{urlencode(params)}"

    headers = {"Accept": "application/x-ndjson"}
    if x_lichess_token:
        headers["Authorization"] = f"Bearer {x_lichess_token.strip()}"

    ndjson = _request_text(url, headers=headers)

    games: list[dict[str, Any]] = []
    for line in ndjson.splitlines():
        line = line.strip()
        if not line:
            continue

        try:
            raw_game = json.loads(line)
        except json.JSONDecodeError:
            continue

        normalized = _normalize_lichess_game(raw_game, user)
        if normalized is None:
            continue

        games.append(normalized)
        if len(games) >= max_games:
            break

    return {
        "platform": "lichess",
        "username": user,
        "count": len(games),
        "games": games,
    }
