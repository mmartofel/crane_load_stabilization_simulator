  On the GPU node:
  # Install deps once:
  pip install torch numba

  # Tier 1 (CPU parallel + JIT):
  python generate_optimal_pid.py --workers 32

  # Tier 2 (GPU):
  python generate_optimal_pid_gpu.py --device cuda