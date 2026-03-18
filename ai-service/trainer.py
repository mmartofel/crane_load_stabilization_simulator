# trainer.py — CLI for training the PID predictor model
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from model import PIDPredictor

def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "../data/test_results.csv"
    print(f"Training on: {csv_path}")
    p = PIDPredictor()
    try:
        stats = p.train(csv_path)
        print(f"\nTraining complete — {stats['n_total']} rows used (top 30%)")
        print(f"Score threshold: {stats['score_threshold']:.4f}")
        print(f"Trained at: {stats['trained_at']}\n")
        for param, m in stats['metrics'].items():
            stars = '★' * int(m['r2'] * 5)
            print(f"  {param}: R²={m['r2']:.3f} {stars}  MAE={m['mae']:.4f}")
        print("\nModel saved to pid_model.joblib")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
