#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "Starting simulator..."
echo "DIGITAL TWEEN - Tower Crane Load Stabilizer Simulator"
echo "Simulator available at: http://localhost:3000"
node server.js
