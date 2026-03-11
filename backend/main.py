from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from analysis import analyze_fen
from puzzles import generate_puzzle
from ai_engine import best_move

app = FastAPI(title=ChessMind2 Backend)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def home():
    return {"status": "ChessMind2 backend attivo"}

@app.get("/analysis")
def analysis(fen: str):
    return analyze_fen(fen)

@app.get("/puzzle")
def puzzle():
    return generate_puzzle()

@app.get("/ai")
def ai(fen: str):
    return {"best_move": best_move(fen)}
