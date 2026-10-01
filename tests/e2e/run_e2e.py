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
import subprocess
import sys
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


def run_one(path, env, timeout_s):
    t0 = time.time()
    try:
        p = subprocess.run([sys.executable, '-B', path], env=env, capture_output=True, text=True, timeout=timeout_s)
        out, code = p.stdout + p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b'').decode('utf-8', 'replace') if isinstance(e.stdout, bytes) else (e.stdout or '')) + '\n[時間切れ]'
        code = -1
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

    print('e2e: %d 本を実行 (jobs=%d, base=%s)' % (len(scripts), args.jobs, BASE))
    total_pass = total_fail = 0
    broken = []
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as ex:
        futs = [ex.submit(run_one, s, env, args.timeout) for s in scripts]
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
    print('-' * 60)
    print('合計: PASS %d / FAIL %d ・ %d 本中 %d 本に問題 (%.0f 秒)' % (total_pass, total_fail, len(scripts), len(broken), time.time() - t0))
    if broken:
        print('問題のあるスクリプト: ' + ', '.join(sorted(broken)))
    return 1 if broken else 0


if __name__ == '__main__':
    sys.exit(main())
