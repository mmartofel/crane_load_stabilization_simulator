#!/usr/bin/env bash
set -euo pipefail

# PyTorch requires Python ≤ 3.12 (no wheels for 3.14 yet).
# Adjust CUDA_TAG to match your GPU node: cu118 | cu121 | cu124 | cpu
CUDA_TAG="${CUDA_TAG:-cu121}"
PYTHON="${PYTHON:-python3.12}"

echo "Using Python: $($PYTHON --version)"
echo "PyTorch CUDA tag: $CUDA_TAG"

# Create virtual environment
$PYTHON -m venv .venv
source .venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install all non-torch dependencies
pip install -r requirements_gpu.txt

# Install PyTorch from the official index (required for CUDA builds)
pip install torch --index-url "https://download.pytorch.org/whl/${CUDA_TAG}"

python3 generate_optimal_pid_gpu.py --device cuda