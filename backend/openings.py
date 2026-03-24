from fastapi import APIRouter

router = APIRouter()

OPENINGS = {
    "italian": ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"],
    "sicilian": ["e4", "c5"],
    "french": ["e4", "e6", "d4", "d5"],
    "caro": ["e4", "c6", "d4", "d5"],
    "queen_gambit": ["d4", "d5", "c4"]
}

@router.get("/{name}")
def get_opening(name: str):
    return {
        "name": name,
        "moves": OPENINGS.get(name, [])
    }