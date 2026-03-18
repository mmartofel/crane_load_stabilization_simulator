import requests
import time  # Added to measure response time

def test_ollama_access():
    req = {
        "L": 10.0,
        "m": 500.0,
        "wind_speed": 5.0
    }
    result = {
        "Kp": 1.5,
        "Ki": 0.5,
        "Kd": 0.1
    }

    start_time = time.time()  # Start timing
    try:
        resp = requests.post(
            "http://localhost:11434/api/generate",
            json={"model": "mistral", "stream": False,
                  "prompt": (
                      f"You are a PID expert. Briefly explain (2 sentences) why "
                      f"for a crane with rope {req['L']}m, load {req['m']}kg, wind "
                      f"{req['wind_speed']}m/s the optimal settings are "
                      f"Kp={result['Kp']}, Ki={result['Ki']}, Kd={result['Kd']}. "
                      f"Answer in English, technical, no preamble.")},
            timeout=180)  # Increased timeout to 180 seconds
        result['explanation'] = resp.json().get("response") or "Ollama: empty response"
    except Exception as e:
        result['explanation'] = f"LLM server unavailable: {str(e)}"
    end_time = time.time()  # End timing

    result['response_time'] = round(end_time - start_time, 2)  # Calculate time spent
    print("Test Result:", result)

if __name__ == "__main__":
    test_ollama_access()