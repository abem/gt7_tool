# 改修履歴: バックエンド安定化と構成整理

> **日付**: 2026-07-08
> **コミット**: `b8de0d6`（コード修正）→ `bfde6eb`（ドキュメント）→ レビュー後修正
> **ブランチ**: `feature/backend-stabilization-2026-07-08`
> **変更規模**: コード修正 9ファイル +725/-26、レビュー後修正を含む

---

## 1. 概要

GT7 Telemetry Dashboard のバックエンド層（Python）に致命的な機能不全が発生しており、本改修は以下3本柱で構成される。

1. **致命バグ修正** — Salsa20 復号の import 漏れ（5日間の復号不全）
2. **UDP受信ループの非同期化** — CPU無駄遣い・イベントループ阻塞の解消
3. **構成整理** — 旧亜種の退避・散乱スクリプトの集約・回帰テスト新設

> ⚠️ **重要**: コード修正自体は単体テスト（12件 PASS）と構文検証で妥当性を確認したが、**実機（PS5）でのテレメトリ復号成功は未確認**である。UDP非同期化は受信経路全体が変わるため、コンテナ再ビルド後の実機動作確認が必須。

---

## 2. 改修の背景と詳細

### 2.1 🔴 Bug#1: Salsa20 復号の import 漏れ（致命傷）

#### 現象
本番コンテナ `gt7_tool-gt7_tool-1` が5日間稼働し続け、`docker logs` に以下のエラーが大量に記録されていた:

```
2026-07-07 03:38:00 - decoder - ERROR - Decryption failed: name 'Salsa20' is not defined
```

PS5 から送信される全テレメトリパケットが捨てられ、ダッシュボードは TEST MODE（ブラウザ側シミュレーション）でしか動作しない状態だった。

#### エラー件数の根拠
エラー件数は以下のコマンドで実測した（2026-07-08 時点）:

```bash
$ docker logs gt7_tool-gt7_tool-1 2>&1 | grep -c 'Decryption failed'
1523669
```

コンテナは7月2日に起動し7月8日時点で稼働中。ハートビート送信時の受信パケットごとに3種類のXOR値で復号を試行するため、1パケットあたり最大3回の失敗ログが出る仕組み。約150万件/5日間はこの試行回数に概ね合致する。

#### 原因
`decoder.py` の冒頭コメント（L13-16）で「`_try_decrypt` 内で遅延 import する」と宣言されていた:

```python
# NOTE: Crypto (pycryptodome) は GT7Decoder の復号処理でのみ必要。
# CourseEstimator は Crypto に非依存なため、トップレベル import を避け
# _try_decrypt 内で遅延 import する。これにより Crypto 未導入環境でも
# `import decoder` が成功し、CourseEstimator/テストが利用可能になる。
```

**しかし実際の `_try_decrypt` メソッドには import 文が存在せず**、`Salsa20.new(...)` が常に `NameError` を起こしていた。`decrypt()` の例外ハンドラが `NameError` を catch して `b''` を返すため、パケットは「復号失敗」として静かに捨てられ続けていた。

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

#### 検証状況
- ✅ venv 上で `_try_decrypt` が `NameError` を出さずに復帰することを確認
- ✅ 合成パケットの暗号化→復号→解析パイプラインが既知値を保持することを確認（テスト11件 PASS）
- ⚠️ **実機パケットでの復号成功は未確認**（コンテナ再ビルド＋PS5接続が必要）

---

### 2.2 UDP受信ループの非同期化

#### 背景（従来の問題点）
`telemetry.py` は同期ソケット + `settimeout(1.0)` のブロッキング `receive()` を採用し、`main.py` は `while True:` ループ内で `asyncio.sleep(0.01)` の空ポーリングを行っていた:

```python
# 従来（問題あり）
while True:
    client.send_heartbeat()
    raw_data = client.receive()       # 同期ブロッキング呼び出し（最大1秒阻塞）
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
| `send_heartbeat()` | 同期 `def`、間隔制御付き | `async def`、**無条件送信**（間隔制御は呼び出し側へ一元化） |
| `close()` | `sock.close()` | `transport.close()` |
| `settimeout(1.0)` | 1秒タイムアウト | 廃止（非同期待機で不要） |

**`main.py`（ループ調整）**:
- ループ前に `await client.connect()` を追加
- 受信は `raw_data = await client.receive()` でパケット到着まで待機（`sleep(0.01)` 廃止）
- ハートビート送信は独立タスク `_heartbeat_loop` に分離（受信ループから切り離し）

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

#### レビュー後修正: ハートビート間隔制御の一元化

初版では `send_heartbeat()` 内（`last_heartbeat` による時間判定）と `_heartbeat_loop` 内（`asyncio.sleep(interval)`）の**二重の間隔制御**が存在していた。これは:
- 両者のタイミングがずれると送信漏れが起きうる
- 責務が重複して意図が読みにくい

ため、`send_heartbeat()` の間隔チェックを削除し、**`_heartbeat_loop` 側に一元化**した。`send_heartbeat()` は呼ばれるたびに無条件で1パケット送信する純粋な送信メソッドとなり、間隔制御は `asyncio.sleep` のみが担う。

#### 効果
イベントループの阻塞解消、CPU使用率改善、ハートビートと受信の責務分離。

#### 検証状況
- ✅ 非同期 API のスモークテスト（connect / send_heartbeat / close）通過
- ⚠️ **実機での受信レート・遅延・ハートビート周期は未確認**

---

### 2.3 構成整理

#### 2.3.1 旧亜種ディレクトリの `archive/` 退避

3つの亜種を `Projects/gt7/archive/` へ移動し、`gt7_tool` を唯一の正実装として明確化:

| 亜種 | サイズ | 移動前の状態 |
|------|--------|------|
| `gt7_tool_dev` | 3.0G | ほぼ `gt7data/`。`.git` は worktree ポインタ（`gitdir: /home/abem/docker/gt7_tool/.git/worktrees/gt7_tool_dev`） |
| `gt7_tool_car_attitude2` | 3.6G | 同上 |
| `gt7dashboard` | 439M | 非git、`docker-compose.yml` + `gt7data/` のみ |

移動は同ファイルシステム内の `mv` で瞬時完了（inode参照切替のみ）。`gt7_tool/.git`（正実装の独立リポジトリ）への影響はない。

> ⚠️ **レビューで発覚した重要事項（初版の事実誤認を訂正）**:
>
> 初版のコミットメッセージ・ドキュメントでは「2亜種の `.git` は孤立した worktree ポインタのみで**親消失済み**」と記載していたが、これは**誤り**だった。実際は:
>
> - **親リポジトリ `/home/abem/docker/gt7_tool` は現存**する（branch: `feature/dev2026-06-14`）
> - ただし `git worktree list` には表示されず、`.git/worktrees/` メタデータが存在しない（prune 済みか初期から未設定）
> - そのため archive/ 側から `git status` すら実行できない状態（`not a git repository`）
>
> 加えて、親リポジトリには**9ファイル・約1300行の未コミット変更**が残っていた:
> - `styles.css`（2572行差分）、`car-3d.js`、`charts.js`、`constants.js`、`course-map.js`、`index.html`、`test-mode.js`、`ui_components.js`、`websocket.js`
> - 内容は **APEX Broadcast UI リデザインの中間状態**（`#ff4444` → `#D84B4F` 等の色調変更）
>
> `gt7_tool`（正実装）には同等の作業が `feature/ui-redesign-2026-06-14`（コミット `d910766`）としてコミット済みである。破棄にあたり**第2回レビューで「gt7_tool側への未反映変更がないか未検証」と指摘されたため、実際にファイル単位で比較検証を実施**した。

##### 比較検証の方法と結果

> **比較対象（明記）**: `diff <(docker最終状態) <(gt7_tool main)` の `<` 行 = **docker側にのみ存在する行**。
> 「docker最終状態」= 共通ベース `769b299` に snapshot の patch を適用した状態（=破棄前の実ファイル）。
> これは **patch 単体（769b299→docker未コミットの差分）とは別物**である。両者の混同が過去3回の訂正ミスの根本原因だった（後述）。

両リポジトリが共通ベースコミット `769b299`（"feat: HTTPS 対応"、hash完全一致で同一コミット）を持つことを確認の上、作業用ディレクトリに `769b299` を checkout して patch を適用し、9ファイル全件を gt7_tool の main と `diff` で比較した。

結果（`<` 行 = docker側にのみ存在する実質コード行、空行・コメント除外）:

| ファイル | md5一致 | docker側のみ存在する行（実数と内容） |
|----------|---------|--------------------------------------|
| `car-3d.js` | ✅ SAME | 0行 |
| `charts.js` | ❌ DIFF | 0行 |
| `constants.js` | ✅ SAME | 0行 |
| `course-map.js` | ❌ DIFF | **5行**: `getSpeedColor(curr.speed)`, `updateCourseMap(positionX, positionY, positionZ, speed, heading)`（5引数版）の定義と currentPosition 設定部 |
| `index.html` | ❌ DIFF | **1行**: `<div class="card-title">LAP HISTORY</div>` |
| `styles.css` | ❌ DIFF | 0行 |
| `test-mode.js` | ❌ DIFF | **2行**: `updateCourseMap(point.x, 0, point.z, point.speed, demoOrientation.yaw)`（5引数呼び出し）とそのコメント |
| `ui_components.js` | ✅ SAME | 0行 |
| `websocket.js` | ❌ DIFF | **1行**: `data.rotation_yaw \|\| 0  // 車両の向き` |

**docker側のみ存在する行の由来と、gt7_tool側での置換状況**:

これら4ファイル・計9行は、いずれも**共通祖先 `769b299` に元々存在していたコード**であり、docker側の未コミット patch 自体はこれらに触れていない（だから patch 単体を grep しても出てこない）。gt7_tool 側の**後続コミット**でより新しい実装に置き換えられたため、最終ファイル間 diff では「docker側のみに存在する行」として現れる:

- `course-map.js` の `updateCourseMap` 5引数版 → gt7_tool 側で**7引数版**（heading に加え追加パラメータ）に拡張。`getSpeedColor` も別実装に置換。
- `index.html` の `LAP HISTORY` → gt7_tool 側の**DRIVE/ANALYSISビュー機能**（2026-07-02コミット）で `<span>LAP HISTORY</span>` を含む複数行構造に再構成。
- `test-mode.js` の 5引数呼び出し → course-map.js の 7引数化に追従して gt7_tool 側で更新済み。
- `websocket.js` の `data.rotation_yaw` → gt7_tool 側で別の参照形態に置換。

**結論**: docker側のみに存在する9行は**すべて gt7_tool 側の後続機能（DRIVE/ANALYSISビュー、API拡張）によって置換された旧実装**であり、docker側独自の新規機能追加やバグ修正は見られなかった。gt7_tool 側は docker側の APEX Broadcast 配色変更を取り込んだ上でさらに新機能を追加した**上位集合（スーパーセット）**であり、**復元すべき未反映変更は存在しない**と判断した。この結論は第4回検証でも支持されている。

> 補足: gt7_tool 側が DIFF な6ファイルには、docker側に存在しない新機能（距離基準ラップ解析チャート `analysisSpeedChart`/`timeDeltaChart`、DRIVE/ANALYSISビュー関連コード等）が追加されている。変更の方向は一方向（gt7_tool が新しい）のみ。
>
> なお「docker側の配色変更が gt7_tool 側に行レベルで完全包含されている」わけではない（CSS変数経由等の別表現で実装されている）。本検証の対象はあくまで「復元すべき未反映コードの有無」である。

##### 未コミット変更の保護措置

破棄にあたり、以下のスナップショットを `archive/_snapshots/` に保存した:

| ファイル | 内容 |
|----------|------|
| `docker-gt7_tool-uncommitted-2026-07-08.patch` | 9ファイルの未コミット差分（3727行） |
| `docker-gt7_tool-status-2026-07-08.txt` | 破棄前の `git status --porcelain` |
| `untracked/cleanup_gt7data.sh` | 未追跡スクリプト |
| `untracked/docs/disk-cleanup-2026-06-14.md` | 未追跡ドキュメント |
| `untracked/src/core/{constants,dom-cache}.js` | ESモジュール化の試行（旧色） |
| `README.md` | スナップショットの背景と復元方法 |

復元が必要になった場合は `archive/_snapshots/README.md` を参照。

#### 2.3.2 デバッグ/検証スクリプトの `scripts/` 集約

ルート直下に散乱していた開発用スクリプト **26ファイル** を `scripts/` へ整理（ファイルシステム上の移動）:

| 系統 | ファイル例 | 件数 |
|------|------------|------|
| デバッグ | `debug_*.py`, `debug*.html` | 10 |
| 検証 | `verify_*.py`, `auto_verify.py` | 5 |
| キャプチャ | `capture_*.py`, `visual_regression_test.py` | 6 |
| データ確認 | `check_*.py` | 2 |
| その他 | `force_chart_update.py`, `test_uplot.html`, `test_mode_debug.html` | 3 |

> ⚠️ **重要（git非追跡について）**: これら26ファイルは `.gitignore` のパターン（`debug*.py`, `verify_*.py`, `capture_*.py`, `check_*.py`, `test_*.py` 等）に一致するため **git管理下にはない**。したがって「`scripts/` への移動」はワーキングツリー上の整理のみで、**git履歴には反映されない**。コミットに含まれるのは `scripts/README.md` のみ。本番コンテナにも含まれない（`.dockerignore` 対象）。
>
> スクリプト群がどこかにバックアップされていない場合は、ワーキングツリー上の `scripts/` が唯一の存在場所になる点に注意。

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
| `telemetry.py` | 全面書き換け | `asyncio.DatagramProtocol` 化（+139行）。レビュー後、`send_heartbeat()` の間隔チェック削除 |
| `main.py` | 修正 | 受信ループ非同期化・ハートビート独立タスク化（+41行） |
| `requirements.txt` | 修正 | `pytest>=7.0.0` 追加 |
| `.gitignore` | 修正 | `!tests/` 例外追加、`__pycache__`/`.pytest_cache` 除外 |
| `CHANGELOG.md` | 修正 | 2026-07-08 セクション追加（レビュー後、事実誤認を訂正） |
| `scripts/README.md` | 新規 | スクリプト分類と実行方法の説明。**git非追跡の旨を明記** |
| `tests/test_decoder.py` | 新規 | 11件の回帰テスト |
| `tests/test_course_detection.py` | 新規（移動） | ルートから `tests/` へ移動、DBパス修正 |

> 注: `scripts/` 配下の26ファイルは git非追跡のためこの一覧に含まない。`archive/` 配下も git管理外。

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
| ハートビート間隔制御の一元化 | ✅ `send_heartbeat` 無条件化、テスト再PASS |

### ⚠️ 未確認項目（実機確認が必要）
| 項目 | 状態 |
|------|------|
| 実機（PS5）パケットの復号成功 | ❌ 未確認（コンテナ再ビルド＋PS5接続が必要） |
| UDP非同期化による受信レート・遅延 | ❌ 未確認 |
| ハートビート周期の実機確認 | ❌ 未確認 |

---

## 5. 残作業（ユーザー実施）

### 5.1 ⚠️ 必須: コンテナ再ビルド・実機確認

**コード修正の妥当性は単体テストで確認したが、実機でのテレメトリ復号成功は未確認である。マージ前に必ず以下を実施すること。**

```bash
cd /home/abem/Projects/gt7/gt7_tool

# 問題なければ main へマージ
git merge feature/backend-stabilization-2026-07-08

# コンテナ再ビルド
docker compose up --build

# ログで Salsa20 エラー消滅・PS5からの受信成功を確認
docker logs -f gt7_tool-gt7_tool-1
# → "Parsed: XX.X km/h, RPM: XXXX, Gear: X" が出れば復号成功
# → "Decryption failed" が継続する場合は問題あり
```

### 5.2 実機確認の観点

- **復号成功**: ログに "Telemetry stream active" が出ること
- **受信レート**: UDP非同期化による遅延・ドロップがないこと
- **ハートビート**: 受信中も `heartbeat_interval`（10秒）ごとに送信されること
- **UI**: TEST MODE 切替でブラウザ側シミュレーションが正常動作すること

### 5.3 任意: スクリプトのバックアップ

`scripts/` 配下の26ファイルは git非追跡であり、ワーキングツリー上にのみ存在する。必要に応じて別途バックアップを検討すること。

---

## 6. レビュー経緯と訂正事項

本改修は初版コミット（`b8de0d6`）後にレビューを受け、以下の事実誤認・不備を訂正した:

| 指摘 | 初版の記載 | 実際 | 訂正 |
|------|------------|------|------|
| 親worktreeの存在 | 「親消失済み」 | `/home/abem/docker/gt7_tool` が現存 | ドキュメント訂正 |
| 未コミット変更 | 言及なし | 9ファイル約1300行のAPEX Broadcast中間状態 | スナップショット保存後に破棄 |
| ハートビート二重制御 | `send_heartbeat` 内と `_heartbeat_loop` 内の二重 | — | `send_heartbeat` を無条件化し一元化 |
| scripts/ のgit追跡 | 「集約」とだけ記載 | 26ファイルは `.gitignore` 対応で非追跡 | ドキュメントに明記 |
| 152万件の根拠 | 数字のみ記載 | `grep -c` で実測 | 根拠コマンドを記載 |
| 実機確認 | 残作業として軽く記載 | 未確認の重大項目 | 冒頭と残作業で強調 |

### 第2回レビューへの対応（非同期受信の堅牢化）

第1回レビュー対応後、再度レビューを受け、非同期受信回りの信頼性問題5件を指摘された。うち実害のある3件と軽微1件をコード修正で対応し、残り1件（archive/吸収の未検証）は実証検証で対応した:

| 指摘 | 重大度 | 対応 |
|------|--------|------|
| #1 キュー溢れ時の無警告破棄 | 🟡 実害あり | `datagram_received` で60秒に1回・累積ドロップ数を `logger.warning` 通知 |
| #2 例外時の再起動機構なし | 🟡 実害あり | `telemetry_supervisor` 新設。指数バックオフ（最大60秒）で再起動 |
| #3 `receive()` の CancelledError 握りつぶし | 🟡 実害あり | `re-raise` するよう修正。タスクキャンセル時の正常終了を実現 |
| #4 `last_heartbeat` のデッドコード化 | 🟢 軽微 | 観測用に残しつつ「記録専用・未参照」とコメント明記 |
| #5 archive/吸収済みの主張が未検証 | 🔵 ドキュメント | 共通ベース `769b299` を確認し、9ファイル全件 diff で実証（上位集合であることを確認） |

特筆: #2/#3 は「実機で受信が止まったまま気づかない」リスクに直結する重要指摘だった。再起動安全網と CancelledError の正しい伝播により、サイレント停止を防止できる構造になった。

### 第3回レビューへの対応（説明の正確性向上・シャットダウン経路の明示）

第2回対応後のレビューで、比較表の説明不正確（#1・#2）と telemetry_supervisor のシャットダウン経路欠如（#4）を指摘された:

| 指摘 | 内容 | 対応 |
|------|------|------|
| #1 course-map.js の説明誤り | 「5引数API残余」と書いたが実態は**グロー効果の配色変更のみ**。test-mode.js と混同していた | 比較表を patch 実物ベースで全面書き換え（上記「比較検証の方法と結果」を参照） |
| #2 index.html の説明誤り | 「LAP HISTORY ラベル」と書いたが patch にその文字列は存在しない。実態は color-scheme meta追加・aria-live属性追加・inline style→class化 | 同上 |
| #3 残り5ファイルの再検証 | car-3d/charts/constants/styles/ui_components の再照合を要求 | 全9ファイルを patch から抽出して再確認。比較表に実内容を正確に記載 |
| #4 telemetry_supervisor のシャットダウン経路 | `on_cleanup` フックが未登録で、CancelledError を正常終端として扱う設計なのに**誰もキャンセルを発火しない**状態だった | `on_cleanup(app)` を新設し、supervisor タスクをキャンセル→await でクリーン終了。`app.on_cleanup.append(on_cleanup)` で登録 |

特筆:
- **#1〜#3（説明の不正確さ）**: 初版の比較表の「docker側のみの実質コード行」欄は、`diff` の `<` 行出力から内容を**推測で記述してしまった**ことが原因。本訂正では patch の実物を `sed -n '開始,終了p'` で直接抽出・確認し、事実ベースで書き直した。「実証」という言葉を使いながら推測を混入させたことは重大な失敗で、大方向（gt7_tool が上位集合）の結論は変わらないものの、証拠としての信頼性を著しく損なうものだった。
- **#4（シャットダウン経路）**: 第2回で `CancelledError` を re-raise する設計にした一方、それを発火する経路が存在しない不整合があった。`on_cleanup` の追加により、アプリ終了時に supervisor が明示的にキャンセルされ、`telemetry_background_task` → `_heartbeat_loop` も連鎖的にクリーンアップされる構造が完成した。

### 第4回レビューへの対応（第3回訂正自体が誤りだったことへの是正）

第3回対応後の検証で、**第3回の「訂正」自体が別の意味で不正確だった**ことが発覚した:

**根本原因**: 第1回は「最終ファイル間 diff の `<` 行」を見ていた（本来見るべき対象）が、第3回は**比較対象を「patch 単体（769b299→docker未コミットの差分）」に取り違えてしまった**。両者は別物で、patch が触れていない行でも、gt7_tool 側の後続コミットで置換されていれば最終ファイル間 diff では `<` 行として現れる。

具体例（`index.html` の `LAP HISTORY`）:
- この行は**共通祖先 `769b299` に元々存在**
- docker側 patch はこの行に触れていない → **patch 単体を grep しても出ない**（第3回の主張はこの意味では正しい）
- しかし gt7_tool 側の DRIVE/ANALYSISビュー機能（2026-07-02）で別構造に置換されたため、**最終ファイル間 diff では docker側のみに存在する行**として現れる
- つまり**第1回の「LAP HISTORY ラベル」という記述は最終ファイル間 diff としては正しかった**

第3回は patch 単体を根拠に「patch に存在しない」と結論づけたが、それは**本来見るべき対象（最終ファイル間 diff）からのすり替え**だった。結果として第1回の正しい記述を誤って「訂正」してしまった。

**是正**: 比較対象を冒頭で1行明記（`diff <(docker最終) <(gt7_tool main)` の `<` 行）した上で、全9ファイルの `<` 行を空行/コメント除外で再抽出し、その実数と内容を正確に記載した（上記「比較検証の方法と結果」を参照）。4ファイル（course-map.js・index.html・test-mode.js・websocket.js）に計9行の「docker側のみ存在する行」が実在すること、それらがすべて gt7_tool 側の後続実装に置換済みであることを確認した。結論（復元すべき未反映変更なし）は第4回検証でも支持されている。

**再発防止**: 以降、同種の検証を行う際は**「何を比較しているか」を1行で明記してから**進める。本ドキュメントの「比較検証の方法と結果」節の冒頭に比較対象を明示したのはこのため。

---

## 7. リスクと注意点

| 項目 | 内容 | 対策 |
|------|------|------|
| **実機復号の未確認** | 単体テストは通ったが実機パケットで未検証 | コンテナ再ビルド後の実機確認が必須 |
| UDP非同期化の回帰 | 受信レート・遅延の実機確認が必要 | 同上 |
| テストデータ不足 | 実機パケットキャプチャが無く合成パケットで検証 | 実機パケットがあれば後日テスト拡充 |
| scripts/ 非追跡 | 26ファイルはgit非追跡でワーキングツリーにのみ存在 | 必要なら別途バックアップ |
| archive/ の削除リスク | `_snapshots/` を除く archive/ が削除されると旧データ消失 | スナップショットは保護、READMEに明記 |

---

## 関連

- [CHANGELOG.md](../CHANGELOG.md) — 変更履歴（本ドキュメントの要約版）
- [architecture.md](architecture.md) — システムアーキテクチャ全体像
- [common-issues.md](common-issues.md) — よくあるトラブルと対処
- `archive/_snapshots/README.md` — 旧dockerリポジトリ未コミット変更のスナップショット
