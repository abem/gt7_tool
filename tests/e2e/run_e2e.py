#!/usr/bin/env python3
"""e2e テスト(tests/e2e/e2e_NNN_*.py)を、まとめて実行して集計する。

使い方:
    python3 tests/e2e/run_e2e.py                  # 全部
    python3 tests/e2e/run_e2e.py -k 561 -k golden # 名前に含む文字列で絞る
    python3 tests/e2e/run_e2e.py --jobs 1         # 直列(時間に敏感な検証が不安定なとき)
    python3 tests/e2e/run_e2e.py --update-golden -k golden   # ゴールデンを作り直す

リポジトリのルートを配信する静的サーバーを1つ起動し、各スクリプトへ GT7_E2E_BASE で渡す。
各スクリプトは最後に「PASS n FAIL m」または「== n/m PASS ==」を出力する。これを集計し、
失敗・集計行なし・時間切れ・異常終了が1つでもあれば、終了コード1で終わる。
必要なもの: Python 3、playwright(chromium)、Pillow。本番サーバー・PS5 は不要。
"""
import argparse
import concurrent.futures
import glob
import os
import re
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SUMMARY_RES = (re.compile(r'^PASS (\d+) FAIL (\d+)\s*$', re.M), re.compile(r'^== (\d+)/(\d+) PASS ==\s*$', re.M))


def parse_summary(text):
    """(合格数, 失敗数) を返す。集計行が無ければ None。"""
    m = list(SUMMARY_RES[0].finditer(text))
    if m:
        return int(m[-1].group(1)), int(m[-1].group(2))
    m = list(SUMMARY_RES[1].finditer(text))
    if m:
        passed, total = int(m[-1].group(1)), int(m[-1].group(2))
        return passed, total - passed
    return None


_running = set()                 # 実行中の子プロセス(中断のときに止める)
_running_lock = threading.Lock()


def kill_group(proc):
    """子プロセスを、その子孫(Playwright が起動した Chromium 等)ごと止める。"""
    try:
        os.killpg(proc.pid, signal.SIGKILL)      # start_new_session=True なので、pid がグループの番号
    except (ProcessLookupError, PermissionError):
        pass


def _on_sigterm(signum, frame):
    raise KeyboardInterrupt()    # kill(SIGTERM)でも、中断と同じ後始末(子プロセス・静的サーバーの停止)をする


def run_one(path, env, timeout_s):
    t0 = time.time()
    proc = subprocess.Popen([sys.executable, '-B', path], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding='utf-8', errors='replace', start_new_session=True)
    with _running_lock:
        _running.add(proc)
    try:
        out, _ = proc.communicate(timeout=timeout_s)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        kill_group(proc)
        out, _ = proc.communicate()
        out = (out or '') + '\n[時間切れ]'
        code = -1
    finally:
        kill_group(proc)        # 正常終了でも、取り残された子孫がいれば止める
        with _running_lock:
            _running.discard(proc)
    return path, out, code, time.time() - t0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('-k', action='append', default=[], help='名前に含む文字列(複数指定はいずれか)')
    ap.add_argument('--jobs', type=int, default=3, help='同時に走らせる数(既定 3)')
    ap.add_argument('--timeout', type=int, default=420, help='1スクリプトの時間切れ[秒]')
    ap.add_argument('--update-golden', action='store_true', help='ゴールデンを現在の結果で書き換える')
    ap.add_argument('--verbose', action='store_true', help='合格したスクリプトの出力も表示する')
    args = ap.parse_args()

    scripts = sorted(glob.glob(os.path.join(HERE, 'e2e_[0-9]*.py')))
    if args.k:
        scripts = [s for s in scripts if any(k in os.path.basename(s) for k in args.k)]
    if not scripts:
        print('対象のスクリプトがありません')
        return 1

    from e2e_env import BASE          # ここで静的サーバーが起動する(未指定のとき)
    env = dict(os.environ, GT7_E2E_BASE=BASE, PYTHONIOENCODING='utf-8')
    if args.update_golden:
        env['GT7_E2E_UPDATE_GOLDEN'] = '1'
    updating = env.get('GT7_E2E_UPDATE_GOLDEN') == '1'
    signal.signal(signal.SIGTERM, _on_sigterm)

    print('e2e: %d 本を実行 (jobs=%d, base=%s)' % (len(scripts), args.jobs, BASE))
    if updating:
        print('*** ゴールデン更新モード: 比較せず、期待値を現在の結果で書き換えます'
              '(--update-golden または 環境変数 GT7_E2E_UPDATE_GOLDEN=1) ***')
    total_pass = total_fail = 0
    broken = []
    t0 = time.time()
    ex = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs))
    futs = [ex.submit(run_one, s, env, args.timeout) for s in scripts]
    try:
        for fut in concurrent.futures.as_completed(futs):
            path, out, code, dt = fut.result()
            name = os.path.basename(path)
            summ = parse_summary(out)
            bad = summ is None or summ[1] > 0 or code != 0
            if summ:
                total_pass += summ[0]
                total_fail += summ[1]
            status = 'ok  ' if not bad else 'FAIL'
            print('%s %-40s %s  (%.0fs)' % (status, name, ('%d/%d' % (summ[0], summ[0] + summ[1])) if summ else '集計行なし', dt))
            if bad:
                broken.append(name)
                lines = [ln for ln in out.splitlines() if ln.startswith('FAIL') or 'Traceback' in ln or 'Error' in ln or '時間切れ' in ln]
                for ln in (lines or out.splitlines()[-15:])[:30]:
                    print('     ' + ln[:300])
            elif args.verbose:
                print(out)
    except KeyboardInterrupt:
        # 中断: 未着手の分は取り消し、実行中の子プロセスは子孫ごと止める(時間切れまで待たない)
        for f in futs:
            f.cancel()
        with _running_lock:
            for proc in list(_running):
                kill_group(proc)
        ex.shutdown(wait=True)
        print('\n中断しました')
        return 130
    ex.shutdown(wait=True)
    print('-' * 60)
    print('合計: PASS %d / FAIL %d ・ %d 本中 %d 本に問題 (%.0f 秒)' % (total_pass, total_fail, len(scripts), len(broken), time.time() - t0))
    if updating:
        print('*** ゴールデンを書き換えました。git diff tests/e2e/golden で、意図した変更だけかを確認してください ***')
    if broken:
        print('問題のあるスクリプト: ' + ', '.join(sorted(broken)))
    return 1 if broken else 0


if __name__ == '__main__':
    sys.exit(main())
