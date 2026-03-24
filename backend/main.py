from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse
from pathlib import Path

# Import dei router
from .analysis import router as analysis_router
from .puzzles import router as puzzles_router
from .openings import router as openings_router
from .tournaments import router as tournaments_router
from .stats import router as stats_router
from .games import router as games_router

# App FastAPI
app = FastAPI(
    title="ChessMind2 API",
    description="API ufficiale per analisi, puzzle, aperture, tornei e statistiche.",
    version="1.0.0",
    contact={
        "name": "ChessMind2",
        "email": "support@chessmind2.app"
    }
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# CORS (per permettere al frontend di comunicare col backend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # puoi restringerlo se vuoi
    allow_methods=["*"],
    allow_headers=["*"],
)

# Endpoint stato API
@app.get("/api/status")
def api_status():
    return {"status": "ChessMind2 backend attivo"}


# Endpoint base
@app.get("/")
def home():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"status": "ChessMind2 backend attivo"}


# 🔗 Collegamento dei router
app.include_router(analysis_router, prefix="/analysis", tags=["Analysis"])
app.include_router(puzzles_router, prefix="/puzzles", tags=["Puzzles"])
app.include_router(openings_router, prefix="/openings", tags=["Openings"])
app.include_router(tournaments_router, prefix="/tournaments", tags=["Tournaments"])
app.include_router(stats_router, prefix="/stats", tags=["Stats"])
app.include_router(games_router, prefix="/games", tags=["Games"])

@app.get("/{file_path:path}", include_in_schema=False)
def frontend_assets(file_path: str):
    if not FRONTEND_DIR.exists():
        raise HTTPException(status_code=404, detail="Not Found")

    reserved_prefixes = (
        "analysis",
        "puzzles",
        "openings",
        "tournaments",
        "stats",
        "games",
        "api",
        "docs",
        "redoc",
        "openapi.json",
    )

    for prefix in reserved_prefixes:
        if file_path == prefix or file_path.startswith(prefix + "/"):
            raise HTTPException(status_code=404, detail="Not Found")

    requested = (FRONTEND_DIR / file_path).resolve()
    frontend_root = FRONTEND_DIR.resolve()

    try:
        requested.relative_to(frontend_root)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not Found")

    if requested.is_file():
        return FileResponse(requested)

    raise HTTPException(status_code=404, detail="Not Found")


# 🔥 OpenAPI personalizzato
def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema

    openapi_schema = get_openapi(
        title="ChessMind2 API",
        version="1.0.0",
        description="Documentazione ufficiale dell'API di ChessMind2.",
        routes=app.routes,
    )

    # Logo personalizzato
    openapi_schema["info"]["x-logo"] = {
        "url": "https://img.icons8.com/ios-filled/200/4caf50/chess.png"
    }

    app.openapi_schema = openapi_schema
    return app.openapi_schema

app.openapi = custom_openapi
