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
    MODEL_PATH  = "model.joblib"
    META_PATH   = "../data/experiments/model_dataset_manual/model_metadata.json"
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

    def train(self, csv_path: str,
              model_path: str = None, meta_path: str = None,
              model_id: str = None) -> dict:
        # Allow saving model/meta to a custom location (used by DATA GENERATOR)
        save_model = model_path or self.MODEL_PATH
        save_meta  = meta_path  or self.META_PATH

        df = pd.read_csv(csv_path)
        df = df[df['status'] == 'ok']
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

        avg_r2 = round(float(
            sum(stats[t]['r2'] for t in self.TARGET_COLS) / len(self.TARGET_COLS)
        ), 4)
        self.training_stats = {
            'model_id':        model_id,
            'n_total':         int(len(df)),
            'score_threshold': None,
            'metrics':         stats,
            'avg_r2':          avg_r2,
            'confidence_label': _confidence_label(avg_r2),
            'trained_at':      datetime.utcnow().isoformat() + 'Z',
            'data_range': {
                'L_min':    round(float(df['L'].min()), 2),
                'L_max':    round(float(df['L'].max()), 2),
                'm_min':    round(float(df['m'].min()), 2),
                'm_max':    round(float(df['m'].max()), 2),
                'wind_max': round(float(df['wind_speed'].max()), 2),
            }
        }
        self.is_trained = True
        joblib.dump({'models': self.models, 'stats': self.training_stats}, save_model)
        # Write metadata for frontend consumption
        meta_dir = os.path.dirname(save_meta)
        if meta_dir:
            os.makedirs(meta_dir, exist_ok=True)
        with open(save_meta, 'w') as f:
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
        r2_kp = self.training_stats['metrics']['Kp']['r2']
        r2_ki = self.training_stats['metrics']['Ki']['r2']
        r2_kd = self.training_stats['metrics']['Kd']['r2']
        mean_conf = float(np.mean([r2_kp, r2_ki, r2_kd]))
        result['confidence']        = round(mean_conf, 3)
        result['confidence_detail'] = {
            'Kp': round(r2_kp, 3),
            'Ki': round(r2_ki, 3),
            'Kd': round(r2_kd, 3),
        }
        result['confidence_label']   = _confidence_label(mean_conf)
        result['in_training_range']  = _check_training_range(
            self.training_stats.get('data_range'), L, m)
        result['confidence_hint']    = _confidence_hint(mean_conf, L, m)
        result['model']              = 'GradientBoosting'
        result['fallback']           = False
        return result

    def _fallback(self, L, m):
        g  = 9.81
        T  = 2 * np.pi / np.sqrt(g / max(L, 0.1))
        kpc = m * g / max(L, 0.1)
        return {
            'Kp': round(min(kpc * 0.85, 40), 2),          # 85% of critical gain, capped at 40
            'Ki': round(min(0.5 * kpc / T, 20), 3),        # 50% * Kp/T ratio, capped at 20
            'Kd': round(min(T * 2.0, 40), 2),              # 2× pendulum period, capped at 40
            'confidence':        0.0,
            'confidence_detail': {'Kp': 0.0, 'Ki': 0.0, 'Kd': 0.0},
            'confidence_label':  'FALLBACK',
            'in_training_range': None,
            'confidence_hint':   (
                f'No trained model available. Using analytical formulas. '
                f'Run PID tests for L≈{L:.0f}m, m≈{m:.0f}kg and build the model.'
            ),
            'model':   'analytical_fallback',
            'fallback': True
        }


# ── Module-level confidence helper functions ──────────────────────────────────

def _confidence_label(conf: float) -> str:
    if conf < 0.50: return 'FALLBACK'
    if conf < 0.75: return 'LOW'
    if conf < 0.90: return 'HIGH'
    return 'VERY HIGH'


def _check_training_range(data_range: dict | None, L: float, m: float):
    """Return True if L and m are within ±20% of the training data range."""
    if not data_range:
        return None
    try:
        L_ok = data_range['L_min'] * 0.8 <= L <= data_range['L_max'] * 1.2
        m_ok = data_range['m_min'] * 0.8 <= m <= data_range['m_max'] * 1.2
        return bool(L_ok and m_ok)
    except Exception:
        return None


def _confidence_hint(conf: float, L: float, m: float) -> str | None:
    """Return a user-facing hint when confidence is below 0.75, else None."""
    if conf >= 0.75:
        return None
    if conf < 0.50:
        return (
            f'Model has no data for these conditions. '
            f'Prediction is based on analytical formulas. '
            f'Collect more PID test results for L≈{L:.0f}m, m≈{m:.0f}kg.'
        )
    return (
        f'Model has limited data for L≈{L:.0f}m, m≈{m:.0f}kg. '
        f'Prediction is approximate. Consider running additional grid search '
        f'tests in this parameter range.'
    )
