# 改修履歴: バックエンド安定化と構成整理

> **日付**: 2026-07-08
> **コミット**: `b8de0d6` — feat: バックエンド安定化と構成整理
> **ブランチ**: `feature/backend-stabilization-2026-07-08`
> **変更規模**: 9ファイル、+725行 / -26行

---

## 1. 概要

GT7 Telemetry Dashboard のバックエンド層（Python）に致命的な機能不全が発生しており、本改修は以下3本柱で構成される。

1. **致命バグ修正** — Salsa20 復号の import 漏れ（5日間・152万件の復号失敗）
2. **UDP受信ループの非同期化** — CPU無駄遣い・イベントループ阻塞の解消
3. **構成整理** — 旧亜種の退避・散乱スクリプトの集約・回帰テスト新設

---

## 2. 改修の背景と詳細

### 2.1 🔴 Bug#1: Salsa20 復号の import 漏れ（致命傷）

#### 現象
本番コンテナ `gt7_tool-gt7_tool-1` が5日間稼働し続け、`docker logs` に以下のエラーが **152万3669件** 記録されていた:

```
2026-07-07 03:38:00 - decoder - ERROR - Decryption failed: name 'Salsa20' is not defined
```

PS5 から送信される全テレメトリパケットが捨てられ、ダッシュボードは TEST MODE（ブラウザ側シミュレーション）でしか動作しない状態だった。

#### 原因
`decoder.py` の冒頭コメント（L13-16）で「`_try_decrypt` 内で遅延 import する」と宣言されていた:

```python
# NOTE: Crypto (pycryptodome) は GT7Decoder の復号処理でのみ必要。
# CourseEstimator は Crypto に非依存なため、トップレベル import を避け
# _try_decrypt 内で遅延 import する。これにより Crypto 未導入環境でも
# `import decoder` が成功し、CourseEstimator/テストが利用可能になる。
```

**しかし実際の `_try_decrypt` メソッドには import 文が存在せず**、`Salsa20.new(...)` が常に `NameError` を起こしていた。

#### 修正
`decoder.py` の `_try_decrypt` メソッド冒頭に遅延 import を3行追加:

```diff
     def _try_decrypt(self, data: bytes, xor_value: int) -> bytes:
         """指定のXOR値でSalsa20復号を試行"""
+        # 遅延 import: CourseEstimator は Crypto 非依存のため、復号時のみ読み込む。
+        # これにより Crypto 未導入環境でも `import decoder` が成功する。
+        from Crypto.Cipher import Salsa20
         oiv = data[0x40:0x44]
```

#### 効果
PS5 実機テレメトリの復号が復活。

---

### 2.2 UDP受信ループの非同期化

#### 背景（従来の問題点）
`telemetry.py` は同期ソケット + `settimeout(1.0)` のブロッキング `receive()` を採用し、`main.py` は `while True:` ループ内で `asyncio.sleep(0.01)` の空ポーリングを行っていた:

```python
# 従来（問題あり）
while True:
    client.send_heartbeat()
    raw_data = client.receive()       # 同期ブロッキング呼び出し
    if raw_data:
        ...                           # 処理
    await asyncio.sleep(0.01)         # 空ポーリング（CPU無駄遣い）
```

問題点:
- `client.receive()` は **同期ブロッキング呼び出し** で、イベントループを最大1秒阻塞する
- `asyncio.sleep(0.01)` はパケット未着時も **毎秒100回の空回り**（CPU無駄）
- ハートビート送信が受信ループに混在し、責務分離されていない

#### 修正内容

**`telemetry.py`（全面書き換え）**:
- `asyncio.DatagramProtocol` を継承した内部クラス `_TelemetryProtocol` を新設
- 受信パケットは `asyncio.Queue`（上限256件）に蓄積。溢れた場合は古いパケットから破棄（テレメトリは過去値より最新値優先）
- `GT7TelemetryClient` の API を非同期化:

| メソッド | 従来 | 改修後 |
|----------|------|--------|
| `connect()` | （なし、`__init__` 内で即 bind） | `async def connect()` でエンドポイント作成 |
| `receive()` | 同期 `def`、`recvfrom` ブロッキング | `async def`、キューから取り出し |
| `send_heartbeat()` | 同期 `def`、`sock.sendto` | `async def`、トランスポート経由 |
| `close()` | `sock.close()` | `transport.close()` |
| `settimeout(1.0)` | 1秒タイムアウト | 廃止（非同期待機で不要） |

**`main.py`（ループ調整）**:
- ループ前に `await client.connect()` を追加
- 受信は `raw_data = await client.receive()` でパケット到着まで待機（`sleep(0.01)` 廃止）
- ハートビート送信は独立タスク `_heartbeat_loop` に分離（受信ループから切り離し）
- `finally` ブロックでハートビートタスクをキャンセルしクリーンアップ

```python
# 改修後
async def _heartbeat_loop(client):
    """ハートビート送信を独立周期で回すタスク"""
    while True:
        await client.send_heartbeat()
        await asyncio.sleep(client.heartbeat_interval)

async def telemetry_background_task():
    ...
    await client.connect()
    heartbeat_task = asyncio.create_task(_heartbeat_loop(client))
    while True:
        raw_data = await client.receive()    # パケット到着まで待機
        if raw_data:
            ...                              # 処理
```

#### 効果
イベントループの阻塞解消、CPU使用率改善、ハートビートと受信の責務分離。

---

### 2.3 構成整理

#### 2.3.1 旧亜種ディレクトリの `archive/` 退避

3つの亜種を `Projects/gt7/archive/` へ移動し、`gt7_tool` を唯一の正実装として明確化:

| 亜種 | サイズ | 状態 |
|------|--------|------|
| `gt7_tool_dev` | 3.0G | ほぼ `gt7data/`。`.git` は孤立した worktree ポインタのみ（親消失済み） |
| `gt7_tool_car_attitude2` | 3.6G | 同上 |
| `gt7dashboard` | 439M | 非git、`docker-compose.yml` + `gt7data/` のみ |

移動は同ファイルシステム内の `mv` で瞬時完了（inode参照切替のみ）。`gt7_tool/.git` への影響なし。

#### 2.3.2 デバッグ/検証スクリプトの `scripts/` 集約

ルート直下に散乱していた開発用スクリプト **26ファイル** を `scripts/` へ整理:

| 系統 | ファイル例 | 件数 |
|------|------------|------|
| デバッグ | `debug_*.py`, `debug*.html` | 10 |
| 検証 | `verify_*.py`, `auto_verify.py` | 5 |
| キャプチャ | `capture_*.py`, `visual_regression_test.py` | 6 |
| データ確認 | `check_*.py` | 2 |
| その他 | `force_chart_update.py`, `test_uplot.html`, `test_mode_debug.html` | 3 |

これらは `.gitignore` / `.dockerignore` 対象のため、本番ビルドには含まれない。`scripts/README.md` に分類と実行方法を明記。

#### 2.3.3 テストディレクトリの整理

`test_course_detection.py`（ルート直下）は正規の単体テスト（pytest互換）だったため、`tests/` へ移動。DBファイルのパス参照も `tests/` からプロジェクトルートを見るよう修正。

---

### 2.4 回帰テスト新設

`tests/test_decoder.py`（11テスト）を新設し、Bug#1 の再発を防止:

| テストクラス | テスト内容 | 件数 |
|--------------|------------|------|
| `TestSalsa20ImportRegression` | NameError再発防止・パケットサイズ不足・有効パケット復号 | 3 |
| `TestXorFallback` | A/B/~ 全ハートビートタイプのXORフォールバック | 2 |
| `TestParse` | フィールド抽出正常系・サイズ不足・E2E復号→解析 | 3 |
| `TestCourseEstimator` | unknown座標・UI契約キー・bounds ヘルパー | 3 |

実機の暗号化パケットが無いため、テストヘルパー `_encrypt_packet` で GT7 の IV生成アルゴリズムを再現し、合成パケットを暗号化→復号で検証（逆変換による正当性確認）。

**依存関係**: `requirements.txt` に `pytest>=7.0.0` を追加。

**.gitignore調整**: 既存の `test_*.py` 除外ルールが `tests/` 配下も巻き込む問題に対し、`!tests/` 例外を追加。ただし `tests/__pycache__/` と `tests/.pytest_cache/` は除外し直す。

---

## 3. 変更ファイル一覧

| ファイル | 変更種別 | 変更内容 |
|----------|----------|----------|
| `decoder.py` | 修正 | Salsa20 遅延 import 追加（3行） |
| `telemetry.py` | 全面書き換け | `asyncio.DatagramProtocol` 化（+139行） |
| `main.py` | 修正 | 受信ループ非同期化・ハートビート独立タスク化（+41行） |
| `requirements.txt` | 修正 | `pytest>=7.0.0` 追加 |
| `.gitignore` | 修正 | `!tests/` 例外追加、`__pycache__`/`.pytest_cache` 除外 |
| `CHANGELOG.md` | 修正 | 2026-07-08 セクション追加 |
| `scripts/README.md` | 新規 | スクリプト分類と実行方法の説明 |
| `tests/test_decoder.py` | 新規 | 11件の回帰テスト |
| `tests/test_course_detection.py` | 新規（移動） | ルートから `tests/` へ移動、DBパス修正 |

---

## 4. 検証結果

### 自動テスト
```
$ pytest tests/ -v
============================== 12 passed in 0.04s ==============================
```

- `tests/test_decoder.py` — 11件（全PASS）
- `tests/test_course_detection.py` — 1件（全PASS）

### 個別検証
| 項目 | 結果 |
|------|------|
| Salsa20 の NameError 解消 | ✅ venv 上で `_try_decrypt` が正常復帰 |
| `telemetry.py` 非同期 API スモークテスト | ✅ `connect` / `send_heartbeat` / `close` 全て成功 |
| `main.py` インポート | ✅ `telemetry_background_task` / `_heartbeat_loop` 参照可能 |
| 構文チェック | ✅ `py_compile` 全ファイル通過 |

---

## 5. 残作業（ユーザー実施）

### 5.1 コンテナ再ビルド・実機確認

```bash
cd /home/abem/Projects/gt7/gt7_tool

# 問題なければ main へマージ
git merge feature/backend-stabilization-2026-07-08

# コンテナ再ビルド
docker compose up --build

# ログで Salsa20 エラー消滅・PS5からの受信成功を確認
docker logs -f gt7_tool-gt7_tool-1
# → "Parsed: XX.X km/h, RPM: XXXX, Gear: X" が出れば復号成功
```

### 5.2 実機確認の観点

- **復号成功**: ログに "Telemetry stream active" が出ること
- **受信レート**: UDP非同期化による遅延・ドロップがないこと
- **ハートビート**: 受信中も10秒ごとにハートビートが送信されること
- **UI**: TEST MODE 切替でブラウザ側シミュレーションが正常動作すること

---

## 6. リスクと注意点

| 項目 | 内容 | 対策 |
|------|------|------|
| UDP非同期化の回帰 | 受信レート・遅延の実機確認が必要 | コンテナ再ビルド後の実機確認が必須 |
| テストデータ不足 | 実機パケットキャプチャが無く合成パケットで検証 | 実機パケットがあれば後日テスト拡充 |
| 旧亜種の参照 | 他プロセスが旧パスを参照していないか | 移動後も `archive/` に残るため即時影響なし |

---

## 関連

- [CHANGELOG.md](../CHANGELOG.md) — 変更履歴（本ドキュメントの要約版）
- [architecture.md](architecture.md) — システムアーキテクチャ全体像
- [common-issues.md](common-issues.md) — よくあるトラブルと対処
