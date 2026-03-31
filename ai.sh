#!/usr/bin/env bash
set -euo pipefail

cd ai-service

# Kill any existing process on port 8000
if lsof -ti:8000 &>/dev/null; then
    echo "Stopping existing process on port 8000..."
    kill $(lsof -ti:8000) && sleep 1
fi

# Create virtual environment if it doesn't exist
if [ ! -d ".venv" ]; then
    python3.12 -m venv .venv
fi
source .venv/bin/activate

# Upgrade pip and install dependencies
pip install --upgrade pip -q
pip install -r requirements.txt -q

python3 main.py    # port 8000
