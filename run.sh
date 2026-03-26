#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "DIGITAL TWEEN - Tower Crane Load Stabilizer Simulator"

# Install Node.js dependencies if missing or package.json has changed
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
  echo "Installing Node.js dependencies..."
  npm install
fi

echo "Starting simulator at http://localhost:3000"
node server.js
