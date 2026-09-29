"""Test harness that speaks the Ollama HTTP API for embeddings, backed by a real local model (WordLlama, from PyPI).

Used to exercise the app's Ollama embedding path and semantic retrieval in environments where Ollama itself
cannot be installed. It is NOT part of the app: in normal use, point EMBEDDING_PROVIDER=ollama at a real Ollama.
Chat is not implemented (returns 501) — this harness has no language model.

  pip install wordllama
  python3 tests/support/ollama_compat.py --port 11999
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from wordllama import WordLlama

MODEL = "wordllama-l2-256"


def _load():
    # The wheel ships its tokenizer under wordllama/tokenizers/, but the loader looks in wordllama/tokenizer/ and
    # otherwise downloads it. Copy the bundled file into the loader's cache so no network access is needed.
    import shutil
    from pathlib import Path

    import wordllama as pkg

    bundled = Path(pkg.__file__).parent / "tokenizers" / "l2_supercat_tokenizer_config.json"
    cache = WordLlama.get_file_path("tokenizer", None) / bundled.name
    if bundled.exists() and not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(bundled, cache)
    return WordLlama.load(trunc_dim=256, disable_download=True)


wl = _load()


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/tags":
            return self._send(200, {"models": [{"name": MODEL, "model": MODEL}]})
        if self.path == "/api/version":
            return self._send(200, {"version": "harness"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/embed":
            if req.get("model") not in (MODEL, f"{MODEL}:latest"):
                return self._send(404, {"error": f"model '{req.get('model')}' not found"})
            inp = req.get("input")
            texts = [inp] if isinstance(inp, str) else list(inp)
            vecs = wl.embed(texts, norm=True)
            return self._send(200, {"model": MODEL, "embeddings": [v.tolist() for v in vecs]})
        if self.path == "/api/show":
            return self._send(200, {"model_info": {"wordllama.context_length": 512}})
        if self.path == "/api/chat":
            return self._send(501, {"error": "this harness has no language model"})
        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=11999)
    a = ap.parse_args()
    print(f"ollama-compatible embedding harness on :{a.port} model={MODEL}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
