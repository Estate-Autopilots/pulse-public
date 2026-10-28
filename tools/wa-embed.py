"""WA-DATASETS: the server's local text embedder for Pulse's history search (migration 1099). multilingual-e5-base
(int8 ONNX on CPU, 768-d; the model of the corpus pulse_priv.wa_chunk was embedded with), so Hindi, Marathi, English
and the romanised mix share one space. Listens on loopback only; no text is stored, logged or sent anywhere. The model
loads on the first request and is dropped after PULSE_EMBED_IDLE_S (default 900) seconds without one, so it holds no
memory while nobody searches.

  uv run --with onnxruntime --with tokenizers --with huggingface_hub --with numpy python tools/wa-embed.py [--port 3291]
  POST /embed {"texts": ["…"], "kind": "query"|"passage"} → {"vectors": [[768 numbers]], "model": "…"}
  GET  /health → {"ok": true, "loaded": bool}
Set the API's PULSE_EMBED_URL=http://127.0.0.1:3291 to use it (without it the search ranks by words alone).
"""
import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO, MODEL_FILE, TOKENIZER = "Xenova/multilingual-e5-base", "onnx/model_quantized.onnx", "tokenizer.json"
IDLE = int(os.environ.get("PULSE_EMBED_IDLE_S", "900"))
lock = threading.Lock()
state = {"sess": None, "tok": None, "last": 0.0}


def load():
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(hf_hub_download(REPO, TOKENIZER))
    tok.enable_truncation(512); tok.enable_padding(pad_id=1, pad_token="<pad>")
    so = ort.SessionOptions(); so.intra_op_num_threads = int(os.environ.get("PULSE_EMBED_THREADS", "2")); so.inter_op_num_threads = 1
    sess = ort.InferenceSession(hf_hub_download(REPO, MODEL_FILE), so, providers=["CPUExecutionProvider"])
    return sess, tok


def embed(texts, kind):
    import numpy as np
    with lock:
        if state["sess"] is None:
            state["sess"], state["tok"] = load()
        state["last"] = time.time()
        sess, tok = state["sess"], state["tok"]
        enc = tok.encode_batch([f"{kind}: {t}" for t in texts])
        ids = np.array([e.ids for e in enc], dtype=np.int64); mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in {i.name for i in sess.get_inputs()}:
            feed["token_type_ids"] = np.zeros_like(ids)
        out = sess.run(None, feed)[0]
    m = mask[..., None].astype("float32")
    v = (out * m).sum(1) / m.sum(1).clip(1e-9)
    v = v / np.linalg.norm(v, axis=1, keepdims=True)
    return v.round(6).tolist()


def reaper():
    while True:
        time.sleep(30)
        with lock:
            if state["sess"] is not None and time.time() - state["last"] > IDLE:
                state["sess"] = state["tok"] = None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):            # never log requests (they carry query text)
        pass

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        self.reply(200, {"ok": True, "loaded": state["sess"] is not None}) if self.path == "/health" else self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            return self.reply(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length") or 0)
            if n > 200000:
                return self.reply(413, {"error": "too large"})
            body = json.loads(self.rfile.read(n) or b"{}")
            texts = [str(t)[:2000] for t in body.get("texts", [])][:32]
            kind = "passage" if body.get("kind") == "passage" else "query"
            if not texts:
                return self.reply(400, {"error": "texts"})
            self.reply(200, {"vectors": embed(texts, kind), "model": REPO})
        except Exception as e:                # the caller falls back to words; say only what kind of failure
            self.reply(500, {"error": type(e).__name__})


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=int(os.environ.get("PULSE_EMBED_PORT", "3291"))); a = ap.parse_args()
    threading.Thread(target=reaper, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
