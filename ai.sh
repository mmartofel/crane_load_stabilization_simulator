
cd ai-service

# initiate virtual environment 
python3 -m venv .venv
source .venv/bin/activate

# upgrade pip and install dependencies
pip install --upgrade pip
pip install -r requirements.txt

python3 main.py    # port 8000