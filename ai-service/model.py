# model.py — PIDPredictor: trains and predicts optimal PID gains using GradientBoosting
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score, mean_absolute_error
import joblib, os, json
from datetime import datetime

class PIDPredictor:
    MODEL_PATH  = "pid_model.joblib"
    META_PATH   = "../data/model_meta.json"
    FEATURE_COLS = ['L', 'm', 'wind_speed', 'wind_dir_sin', 'wind_dir_cos',
                    'omega0', 'T_period']
    TARGET_COLS  = ['Kp', 'Ki', 'Kd']

    def __init__(self):
        self.models         = {}
        self.is_trained     = False
        self.training_stats = {}
        self._try_load()

    def _try_load(self):
        if os.path.exists(self.MODEL_PATH):
            data = joblib.load(self.MODEL_PATH)
            self.models         = data['models']
            self.training_stats = data['stats']
            self.is_trained     = True

    def _features(self, df: pd.DataFrame) -> pd.DataFrame:
        g = 9.81
        df = df.copy()
        df['omega0']   = np.sqrt(g / df['L'].clip(lower=0.1))
        df['T_period'] = 2 * np.pi / df['omega0']
        rad = np.deg2rad(df['wind_dir_deg'])
        df['wind_dir_sin'] = np.sin(rad)
        df['wind_dir_cos'] = np.cos(rad)
        return df

    def train(self, csv_path: str) -> dict:
        df = pd.read_csv(csv_path)
        df = df[df['status'] == 'ok']
        threshold = df['score'].quantile(0.30)
        df = df[df['score'] <= threshold]
        if len(df) < 10:
            raise ValueError(f"Too few rows after filtering: {len(df)} rows.")
        df  = self._features(df)
        X   = df[self.FEATURE_COLS]
        stats = {}
        for target in self.TARGET_COLS:
            y = df[target]
            X_tr, X_te, y_tr, y_te = train_test_split(
                X, y, test_size=0.2, random_state=42)
            pipe = Pipeline([
                ('scaler', StandardScaler()),
                ('model',  GradientBoostingRegressor(
                    n_estimators=200, max_depth=4,
                    learning_rate=0.05, subsample=0.8, random_state=42))
            ])
            pipe.fit(X_tr, y_tr)
            y_pred = pipe.predict(X_te)
            stats[target] = {
                'r2':      round(float(r2_score(y_te, y_pred)), 4),
                'mae':     round(float(mean_absolute_error(y_te, y_pred)), 4),
                'n_train': int(len(X_tr)),
                'n_test':  int(len(X_te))
            }
            self.models[target] = pipe
        self.training_stats = {
            'n_total':         int(len(df)),
            'score_threshold': round(float(threshold), 4),
            'metrics':         stats,
            'trained_at':      datetime.utcnow().isoformat() + 'Z'
        }
        self.is_trained = True
        joblib.dump({'models': self.models, 'stats': self.training_stats},
                    self.MODEL_PATH)
        # Write metadata for frontend consumption
        os.makedirs(os.path.dirname(self.META_PATH), exist_ok=True)
        with open(self.META_PATH, 'w') as f:
            json.dump(self.training_stats, f, indent=2)
        return self.training_stats

    def predict(self, L: float, m: float,
                wind_speed: float, wind_dir_deg: float) -> dict:
        if not self.is_trained:
            return self._fallback(L, m)
        g  = 9.81
        w0 = np.sqrt(g / max(L, 0.1))
        T  = 2 * np.pi / w0
        rad = np.deg2rad(wind_dir_deg)
        row = pd.DataFrame([{
            'L': L, 'm': m, 'wind_speed': wind_speed,
            'wind_dir_sin': np.sin(rad), 'wind_dir_cos': np.cos(rad),
            'omega0': w0, 'T_period': T
        }])
        result = {}
        for t in self.TARGET_COLS:
            result[t] = round(max(float(self.models[t].predict(row)[0]), 0.0), 4)
        r2s = [self.training_stats['metrics'][t]['r2'] for t in self.TARGET_COLS]
        result['confidence'] = round(float(np.mean(r2s)), 3)
        result['model']      = 'GradientBoosting'
        result['fallback']   = False
        return result

    def _fallback(self, L, m):
        g  = 9.81
        T  = 2 * np.pi / np.sqrt(g / max(L, 0.1))
        kpc = m * g / max(L, 0.1)
        return {
            'Kp': round(min(kpc * 0.55, 18), 2),
            'Ki': round(0.1 / max(L / 10, 0.1), 3),
            'Kd': round(T * 0.4, 2),
            'confidence': 0.0, 'model': 'analytical_fallback', 'fallback': True
        }
