# GT7 Telemetry Dashboard - QA Report

**Review Date:** 2026-03-01  
**Reviewer:** CEO Agent  
**Version:** Current HEAD

---

## Summary

GT7 Telemetry Dashboard は、Gran Turismo 7 のテレメトリデータをリアルタイム表示する Web アプリケーションです。Python バックエンド（aiohttp）と JavaScript フロントエンド（Three.js, uPlot）で構成されています。

**全体評価:** 良好（軽微な問題あり）

### 統計
- **Critical:** 0
- **High:** 3
- **Medium:** 8
- **Low:** 6

---

## Critical Issues

なし

---

## High Severity Issues

### H1: ハードコードされた暗号鍵

**File:** `decoder.py` (line 18)

```python
SALSA20_KEY = b'Simulator Interface Packet GT7 ver 0.0'
```

**問題:** 暗号鍵がソースコードにハードコードされている。これはGT7の仕様上やむを得ないが、将来的に変更される可能性がある場合、対応が困難。

**推奨:** 設定ファイルまたは環境変数から読み込めるようにする（現在はGT7プロトコル固定値なので低優先度）。

---

### H2: Docker コンテナ名が固定

**File:** `docker-compose.yml` (line 4)

```yaml
container_name: gt7_tool_car_attitude2
```

**問題:** コンテナ名がハードコードされており、複数インスタンスの起動ができない。また、名前に `2` がついており、古いバージョンの残骸と思われる。

**推奨:** 
```yaml
# container_name を削除して Docker が自動命名
# またはプロジェクト名を使用
```

---

### H3: ボリュームマウントで全ディレクトリを公開

**File:** `docker-compose.yml` (line 7-8)

```yaml
volumes:
  - ./:/app
```

**問題:** ホストの全ディレクトリ（`.git`、`node_modules`、`.venv` 含む）をコンテナにマウントしている。これにより：
- 不要なファイルがコンテナに含まれる
- 開発用設定が本番環境に混入
- セキュリティリスク（`.git` の公開）

**推奨:** 必要なファイルのみマウント、または `.dockerignore` を活用してイメージビルド専用にする。

---

## Medium Severity Issues

### M1: エラー時のフォールバック値が不正確

**File:** `decoder.py` (line 134)

```python
"max_rpm": rpm_alert_max if rpm_alert_max > 0 else 9000,
```

**問題:** `max_rpm` のデフォルト値 9000 は車種によって不正確。表示の整合性に影響する可能性。

**推奨:** データ未取得時は `null` または `--` 表示にする。

---

### M2: タイムアウト値が固定

**File:** `telemetry.py` (line 20)

```python
self.sock.settimeout(1.0)
```

**問題:** ソケットタイムアウトが1秒固定。ネットワーク遅延時の調整ができない。

**推奨:** 設定ファイルで調整可能にする。

---

### M3: ラップデータ保存のトリガーがサンプル数固定

**File:** `main.py` (line 105-108)

```python
if len(current_lap_data) >= 1800:
    save_lap_to_file(current_lap_data, current_lap_number)
```

**問題:** 1800サンプルで固定。ラップ検出が `lap_count` 変化ではなくサンプル数に依存しており、実際のラップ境界とずれる可能性。

**推奨:** `lap_count` の変化を検知してラップ境界を判定する。

---

### M4: グローバル変数の多用（JavaScript）

**File:** `websocket.js` (line 270-286)

```javascript
var ws = null;
var reconnectDelay = 2000;
var maxReconnectDelay = 30000;
// ... 多数のグローバル変数
```

**問題:** モジュールパターンで `wsState` オブジェクトに集約されているが、後方互換性のためグローバル変数も定義されている。これらは実際には使用されていない可能性。

**推奨:** 未使用のグローバル変数を削除し、`wsState` のみを使用。

---

### M5: JSON パースエラーのハンドリングが不十分

**File:** `websocket.js` (line 236-241)

```javascript
try {
    const data = JSON.parse(raw);
    handleTelemetryMessage(data, now);
} catch (e) {
    console.error('WebSocket message error:', e);
}
```

**問題:** エラーログを出力するのみで、ユーザーへの通知や復旧処理がない。

**推奨:** 連続エラー時にユーザーへ通知、または再接続を試行。

---

### M6: CDN 依存の外部ライブラリ

**File:** `index.html` (line 207-208)

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
```

**問題:** Three.js を CDN から読み込んでいる。オフライン環境や CDN 障害時に動作しない。

**推奨:** ローカルコピーをバンドルするか、npm で管理。

---

### M7: 設定ファイルのデフォルトIP

**File:** `config.json`

```json
"ps5_ip": "192.168.1.128"
```

**問題:** デフォルトIPが特定環境に固定。新規ユーザーは設定変更が必要。

**推奨:** README で設定方法を明記（既に記載されているか確認推奨）。

---

### M8: メモリリークの可能性（コースマップ軌跡）

**File:** `constants.js` (line 60)

```javascript
maxTrajectoryPoints: 2000
```

**問題:** 軌跡ポイントが最大2000点まで保存される。長時間実行時のメモリ消費が増大。

**推奨:** 古いポイントを削除する FIFO 実装を確認（要 `course-map.js` 確認）。

---

## Low Severity Issues

### L1: console.log が残存

**File:** `websocket.js` (line 165, 174, 180, 193)

```javascript
console.log('Connected to GT7 Bridge');
console.log('Disconnected');
```

**問題:** 本番環境に `console.log` が残っている。

**推奨:** `debugLog()` 関数を使用、または本番ビルドで削除。

---

### L2: マジックナンバー

**File:** `main.py` (line 55)

```python
if fuel_consumed < -(fuel_capacity * 0.5):
```

**問題:** 給油検出の閾値 0.5 がハードコード。

**推奨:** 定数として定義。

---

### L3: HTML インデントが不統一

**File:** `index.html`

**問題:** 一部のインデントがスペース4つと2つで混在。

**推奨:** フォーマッター（Prettier等）で統一。

---

### L4: CSS が巨大

**File:** `styles.css` (26KB)

**問題:** 単一CSSファイルが26KBと大きい。

**推奨:** コンポーネント単位で分割、または未使用スタイルを削除。

---

### L5: requirements.txt にバージョン範囲指定

**File:** `requirements.txt`

```
aiohttp>=3.9.0
pycryptodome>=3.19.0
```

**問題:** `>=` で指定されているため、依存関係の競合が発生する可能性。

**推奨:** 動作確認済みバージョンを `==` または `~=` で固定。

---

### L6: ラップマネージャーが未確認

**File:** `lap-manager.js`

**問題:** 今回のレビューで読み込みできていない。ラップタイム計算ロジックに問題がないか要確認。

---

## Recommendations

### 短期的改善（1-2日）

1. **docker-compose.yml の修正**
   - `container_name` を削除
   - ボリュームマウントを必要最小限に

2. **未使用グローバル変数の削除**（`websocket.js`）

3. **README の設定セクション強化**
   - PS5 IP の設定方法
   - Docker 起動手順

### 中期的改善（1週間）

1. **ラップ境界検出の改善**
   - サンプル数 → `lap_count` 変化検知

2. **エラーハンドリング強化**
   - WebSocket 接続失敗時のユーザー通知
   - 自動再接続の視覚的フィードバック

3. **CDN 依存の解消**
   - Three.js をローカルバンドル化

### 長期的改善（継続）

1. **TypeScript 導入検討**
   - 型安全性の向上
   - IDE サポート強化

2. **テストコード追加**
   - デコーダーのユニットテスト
   - WebSocket の統合テスト

---

## Files Reviewed

| File | Status | Notes |
|------|--------|-------|
| `main.py` | ✅ | 軽微な問題のみ |
| `decoder.py` | ✅ | GT7仕様準拠 |
| `telemetry.py` | ✅ | シンプルで問題なし |
| `websocket.js` | ⚠️ | グローバル変数削除推奨 |
| `car-3d.js` | ✅ | よく構成されている |
| `ui_components.js` | ✅ | 良好 |
| `constants.js` | ✅ | 良好 |
| `index.html` | ⚠️ | CDN依存解消推奨 |
| `Dockerfile` | ✅ | 良好 |
| `docker-compose.yml` | ⚠️ | 要修正 |
| `config.json` | ✅ | 環境変数で上書き可能 |

---

**End of Report**
