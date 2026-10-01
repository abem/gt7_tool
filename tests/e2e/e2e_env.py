"""e2e テストの共通部品: 置き場所、静的サーバー、ゴールデン(保存した期待値)との比較。

各スクリプト(e2e_NNN_*.py)は、単体でも実行できる:
    python3 tests/e2e/e2e_561_corner_report.py
このとき、リポジトリのルート(gt7_tool/)を配信する静的サーバーを、空きポートで自動的に起動する
(`/api/**` は、各スクリプトが Playwright の route でフィクスチャに差し替える。本番サーバー・PS5 は不要)。
まとめて実行するときは run_e2e.py が1つのサーバーを共有させる(環境変数 GT7_E2E_BASE)。

環境変数:
    GT7_E2E_BASE           配信済みのサーバーの URL(未指定なら自動起動)
    GT7_E2E_OUT            スクリーンショット等の出力先(既定: tests/e2e/out。git 管理外)
    GT7_E2E_UPDATE_GOLDEN  1 のとき、ゴールデンを現在の結果で書き換える
"""
import atexit
import json
import math
import os
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
FIXTURES = os.path.join(HERE, 'fixtures')
S = FIXTURES            # 旧スクリプトの変数名(フィクスチャの親ディレクトリ)
GOLDEN_DIR = os.path.join(HERE, 'golden')
OUT = os.environ.get('GT7_E2E_OUT') or os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
UPDATE_GOLDEN = os.environ.get('GT7_E2E_UPDATE_GOLDEN') == '1'
if UPDATE_GOLDEN:
    # 比較をせずに期待値を書き換えるモード。環境変数の消し忘れに気づけるよう、必ず表示する
    print('*** ゴールデン更新モード(GT7_E2E_UPDATE_GOLDEN=1): 比較せず、期待値を現在の結果で書き換えます ***',
          file=sys.stderr, flush=True)


def _free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_static_server(root=REPO, timeout_s=15):
    """root を配信する静的サーバーを空きポートで起動し、(プロセス, URL) を返す。"""
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '--directory', root],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = 'http://127.0.0.1:%d' % port
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            urllib.request.urlopen(base + '/index.html', timeout=2).read(64)
            return proc, base
        except Exception:
            if proc.poll() is not None:
                break
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError('静的サーバーを起動できません: ' + base)


BASE = os.environ.get('GT7_E2E_BASE')
if not BASE:
    _server, BASE = start_static_server()
    atexit.register(_server.terminate)


def _diff(exp, got, tol, path='$'):
    """最初の食い違いの説明を返す(一致なら None)。数値は相対・絶対 tol で比べる。"""
    num = (int, float)
    if isinstance(exp, bool) or isinstance(got, bool):
        return None if exp is got else '%s: %r != %r' % (path, exp, got)
    if isinstance(exp, num) and isinstance(got, num):
        return None if math.isclose(exp, got, rel_tol=tol, abs_tol=tol) else '%s: %r != %r' % (path, exp, got)
    if type(exp) is not type(got):
        return '%s: 型が違う (%s / %s)' % (path, type(exp).__name__, type(got).__name__)
    if isinstance(exp, list):
        if len(exp) != len(got):
            return '%s: 長さ %d != %d' % (path, len(exp), len(got))
        for i, (a, b) in enumerate(zip(exp, got)):
            d = _diff(a, b, tol, '%s[%d]' % (path, i))
            if d:
                return d
        return None
    if isinstance(exp, dict):
        if set(exp) != set(got):
            only_e = sorted(set(exp) - set(got))[:5]
            only_g = sorted(set(got) - set(exp))[:5]
            return '%s: キーが違う (期待のみ %s / 結果のみ %s)' % (path, only_e, only_g)
        for k in exp:
            d = _diff(exp[k], got[k], tol, '%s.%s' % (path, k))
            if d:
                return d
        return None
    return None if exp == got else '%s: %r != %r' % (path, str(exp)[:80], str(got)[:80])


def golden(name, value, tol=1e-9):
    """value を、保存した期待値(golden/<name>.json)と比べる。戻り値は (一致したか, 説明)。

    GT7_E2E_UPDATE_GOLDEN=1 のときは、現在の値で書き換えて (True, 'updated') を返す。
    期待値は、整理(リファクタリング)の前後で結果が変わらないことを確かめるためのもの。
    意図して結果を変えたときは、差分を確認したうえで、--update-golden で作り直す。
    """
    path = os.path.join(GOLDEN_DIR, name + '.json')
    value = json.loads(json.dumps(value))      # JSON と同じ型へ正規化(タプル→リスト等)
    if UPDATE_GOLDEN:
        os.makedirs(GOLDEN_DIR, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False, separators=(',', ':'))
        return True, 'updated'
    if not os.path.exists(path):
        return False, 'ゴールデンがありません: %s (run_e2e.py --update-golden で作成)' % os.path.basename(path)
    with open(path, encoding='utf-8') as f:
        exp = json.load(f)
    d = _diff(exp, value, tol)
    return (d is None), (d or '')
