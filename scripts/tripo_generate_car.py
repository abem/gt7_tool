#!/usr/bin/env python3
"""Tripo(文章→3D モデル生成)で CAR ATTITUDE 用の車モデル(GLB)を 1 回生成して取得する(#644)。

使い方(ホストで実行。API キーは ~/.tripo/api.txt、リポジトリには置かない):
    python3 -B scripts/tripo_generate_car.py --balance            # 残クレジットだけ見る(無料)
    python3 -B scripts/tripo_generate_car.py                      # 生成して models/car.glb に保存
    python3 -B scripts/tripo_generate_car.py --prompt "..." --out models/car.glb
    python3 -B scripts/tripo_generate_car.py --task <task_id>     # 既存タスクの結果を取り直す

クレジットを消費するので、生成は明示的に実行したときだけ行う。生成物(GLB)は再生成できる
バイナリとして git 管理外(models/ は docker-compose でコンテナにマウントされ、main.py が /car.glb で配信)。

API: この鍵(tsk_...)が通るのは V2 系のホスト https://api.tripo3d.ai/v2/openapi(2026-10-17 に確認。
新しい https://openapi.tripo3d.com/v3 では「Invalid API key」)。
  POST /task                 {type: "text_to_model", prompt, negative_prompt, model_version, texture, pbr, ...}
  GET  /task/{task_id}       data.status: queued|running|success|failed|cancelled、
                             data.output.pbr_model / model / base_model(ダウンロード URL、約 24 時間有効)
  GET  /user/balance         data.balance / data.frozen
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("TRIPO_API_BASE", "https://api.tripo3d.ai/v2/openapi")
KEY_FILE = os.path.expanduser("~/.tripo/api.txt")
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "car.glb")
DEFAULT_PROMPT = (
    "a modern GT3 racing car, Gran Turismo style, low and wide stance, large rear wing, front splitter, "
    "wide racing tyres on black alloy wheels, glossy white body with blue and red racing stripes, "
    "clean studio product model, whole car fully visible, centered, no background"
)
DEFAULT_NEGATIVE = "text, logos, letters, people, background, ground plane, blurry, low quality, broken wheels"
MODEL_VERSION = "v2.5-20250123"     # クレジット消費を抑える(v3 系は高い)
POLL_S = 10
TIMEOUT_S = 20 * 60


def read_key():
    try:
        with open(KEY_FILE) as f:
            key = f.read().strip()
    except OSError as e:
        sys.exit(f"API key file not readable: {KEY_FILE} ({e})")
    if not key:
        sys.exit(f"API key file is empty: {KEY_FILE}")
    return key


def call(key, method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        sys.exit(f"{method} {path} -> HTTP {e.code}: {detail}")


def balance(key):
    data = call(key, "GET", "/user/balance")
    inner = data.get("data", data)
    return float(inner.get("balance", 0)), float(inner.get("frozen", 0))


def create_task(key, prompt, negative, version):
    body = {"type": "text_to_model", "prompt": prompt, "negative_prompt": negative, "model_version": version,
            "texture": True, "pbr": True, "texture_quality": "standard"}
    data = call(key, "POST", "/task", body)
    task_id = (data.get("data") or {}).get("task_id")
    if not task_id:
        sys.exit(f"no task_id in response: {json.dumps(data)[:500]}")
    return task_id


def wait_task(key, task_id):
    deadline = time.time() + TIMEOUT_S
    last = None
    while time.time() < deadline:
        data = call(key, "GET", f"/task/{task_id}").get("data") or {}
        status = data.get("status")
        progress = data.get("progress")
        line = f"status={status} progress={progress}"
        if line != last:
            print(line, flush=True); last = line
        if status == "success":
            return data
        if status in ("failed", "cancelled", "unknown", "banned", "expired"):
            sys.exit(f"task {task_id} {status}: {json.dumps(data)[:500]}")
        time.sleep(POLL_S)
    sys.exit(f"task {task_id} did not finish within {TIMEOUT_S}s")


def model_url(task):
    out = task.get("output") or {}
    for k in ("pbr_model", "model", "base_model", "model_url"):
        if out.get(k):
            return out[k]
    sys.exit(f"no model URL in output: {json.dumps(out)[:500]}")


def download(url, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".part"
    with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, out_path)
    return os.path.getsize(out_path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--balance", action="store_true", help="残クレジットを表示して終了(生成しない)")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--negative", default=DEFAULT_NEGATIVE)
    ap.add_argument("--model-version", default=MODEL_VERSION)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--task", help="既存の task_id の結果を取得するだけ(再生成しない)")
    args = ap.parse_args()

    key = read_key()
    bal, frozen = balance(key)
    print(f"balance={bal} frozen={frozen}")
    if args.balance:
        return 0

    if args.task:
        task_id = args.task
    else:
        task_id = create_task(key, args.prompt, args.negative, args.model_version)
        print(f"task_id={task_id} (model_version={args.model_version})", flush=True)
    task = wait_task(key, task_id)
    url = model_url(task)
    size = download(url, args.out)
    print(f"saved {args.out} ({size / 1024 / 1024:.1f} MiB)")
    preview = (task.get("output") or {}).get("rendered_image")
    if preview:
        print(f"preview: {preview}")
    bal2, _ = balance(key)
    print(f"balance after: {bal2} (used {bal - bal2})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
