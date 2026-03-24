# main.py — FastAPI AI service: /predict /train /status /switch-experiment
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional
from model import PIDPredictor
import os, json, joblib, requests
from pathlib import Path

app = FastAPI(title="Crane PID AI Service")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])
predictor = PIDPredictor()

class PredictRequest(BaseModel):
    L:                      float = Field(..., ge=0.5, le=50)
    m:                      float = Field(..., ge=0,   le=1000)
    wind_speed:             float = Field(..., ge=0,   le=50)
    wind_dir_deg:           float = Field(..., ge=0,   le=360)
    theta_x:                float = Field(0.0)
    theta_y:                float = Field(0.0)
    use_ollama_explanation: bool  = Field(False)

class TrainRequest(BaseModel):
    csv_path:       str            = Field("../data/test_results.csv")
    output_dir:     Optional[str]  = None   # if set, save model/meta here
    model_filename: str            = "model.joblib"
    meta_filename:  str            = "model_meta.json"

class SwitchExperimentRequest(BaseModel):
    experiment: str  # e.g. "dataset_A_fallback"

@app.post("/predict")
async def predict(req: PredictRequest):
    result = predictor.predict(req.L, req.m, req.wind_speed, req.wind_dir_deg)
    # Boost Kp when load is heavily deflected (|θ| > ~8°)
    theta_mag = (req.theta_x**2 + req.theta_y**2)**0.5
    if theta_mag > 0.14:
        result['Kp']        = round(result['Kp'] * 1.2, 2)
        result['adjustment'] = 'kp_boost_large_angle'
    else:
        result['adjustment'] = 'none'
    # Optional Ollama explanation using mistral model
    if req.use_ollama_explanation:
        try:
            resp = requests.post(
                "http://localhost:11434/api/generate",
                json={"model": "mistral", "stream": False,
                      "prompt": (
                          f"You are a PID expert. Briefly explain (2 sentences) why "
                          f"for a crane with rope {req.L}m, load {req.m}kg, wind "
                          f"{req.wind_speed}m/s the optimal settings are "
                          f"Kp={result['Kp']}, Ki={result['Ki']}, Kd={result['Kd']}. "
                          f"Answer in English, technical, no preamble.")},
                timeout=180)  # Increased timeout to 180 seconds
            result['explanation'] = resp.json().get("response") or "Ollama: empty response"
        except Exception:
            result['explanation'] = "LLM server unavailable"
    else:
        result['explanation'] = None
    return result

@app.post("/train")
async def train(req: TrainRequest):
    if not os.path.exists(req.csv_path):
        raise HTTPException(404, f"File not found: {req.csv_path}")
    try:
        # Build optional output paths for experiment-specific model saving
        model_path = None
        meta_path  = None
        if req.output_dir:
            os.makedirs(req.output_dir, exist_ok=True)
            model_path = os.path.join(req.output_dir, req.model_filename)
            meta_path  = os.path.join(req.output_dir, req.meta_filename)
        stats = predictor.train(req.csv_path, model_path=model_path, meta_path=meta_path)
        return {"status": "ok", "stats": stats}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.post("/switch-experiment")
async def switch_experiment(req: SwitchExperimentRequest):
    """Load a previously trained experiment model into the active predictor."""
    config_path = Path(__file__).parent / "experiments_config.json"
    if not config_path.exists():
        raise HTTPException(404, "experiments_config.json not found — activate an experiment first")
    try:
        config = json.loads(config_path.read_text())
    except Exception as e:
        raise HTTPException(500, f"Failed to read experiments_config.json: {e}")

    model_path = config.get("model_path")
    meta_path  = config.get("meta_path")
    if not model_path or not os.path.exists(model_path):
        raise HTTPException(404, f"Model file not found: {model_path}")

    try:
        data = joblib.load(model_path)
        predictor.models         = data["models"]
        predictor.training_stats = data["stats"]
        predictor.is_trained     = True
        meta = json.loads(Path(meta_path).read_text()) if meta_path and os.path.exists(meta_path) else {}
        return {"status": "ok", "active_experiment": config.get("active_experiment"), "stats": meta}
    except Exception as e:
        raise HTTPException(500, f"Failed to load model: {e}")

@app.get("/status")
async def status():
    metrics = predictor.training_stats.get('metrics', {})
    return {
        "trained":           predictor.is_trained,
        "stats":             predictor.training_stats,
        "model_file_exists": os.path.exists(predictor.MODEL_PATH),
        # Per-parameter R² for the Build Model panel in the frontend
        "r2_detail": {
            "Kp": metrics.get('Kp', {}).get('r2', None),
            "Ki": metrics.get('Ki', {}).get('r2', None),
            "Kd": metrics.get('Kd', {}).get('r2', None),
        },
        # Training data range so the frontend can show it without re-parsing CSV
        "training_range": predictor.training_stats.get('data_range', None),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
