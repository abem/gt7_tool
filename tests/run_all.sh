#!/usr/bin/env bash
# 全テストを順に実行する: 静的チェック → Python の単体テスト(コンテナ内の pytest) → e2e(ブラウザ)。
#   bash tests/run_all.sh              # 全部
#   bash tests/run_all.sh -k 561       # e2e を絞る(引数は run_e2e.py へ渡す)
# 1つでも失敗すれば、終了コード1。本番サーバー・PS5 は不要(コンテナのイメージと、ホストの playwright を使う)。
set -u
cd "$(dirname "$0")/.."
rc=0

echo "== 1/3 静的チェック"
python3 -B tests/static_check.py || rc=1

echo "== 2/3 Python の単体テスト(コンテナ内 pytest。リポジトリを読み取り専用でマウント)"
docker compose run --rm --no-deps -T -v "$PWD:/src:ro" -w /src gt7_tool \
    python -B -m pytest tests -q -p no:cacheprovider || rc=1

echo "== 3/3 e2e"
python3 -B tests/e2e/run_e2e.py "$@" || rc=1

if [ "$rc" -eq 0 ]; then echo "== 全テスト成功"; else echo "== 失敗あり"; fi
exit "$rc"
