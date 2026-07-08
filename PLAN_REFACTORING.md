# GT7 Telemetry Dashboard リファクタリング計画書

## 目的
GitHub公開に向け、コードの可読性・保守性・品質を向上させる

---

## 現状分析

### ファイル構成と行数

| ファイル | 行数 | 担当 |
|---------|------|------|
| `car-3d.js` | 1117 | 3D車両モデル・演出効果 |
| `websocket.js` | 506 | WebSocket・メッセージ処理 |
| `test-glass.js` | 394 | ガラス描画テスト（Node.js） |
| `main.py` | 296 | バックエンドサーバー |
| `ui_components.js` | 223 | DOM要素・ユーティリティ |
| `charts.js` | 230 | チャート描画 |
| `course-map.js` | 179 | コースマップ |
| `test-mode.js` | 166 | テストモード |
| `decoder.py` | - | パケットデコーダー |
| `telemetry.py` | - | GT7通信クライアント |

### 現状の問題点

#### 1. **グローバル変数の乱用**
```javascript
// websocket.js
var ws = null;
var reconnectDelay = 2000;
var maxReconnectDelay = 30000;
var packetCount = 0;
// ... 20以上のグローバル変数
```
→ テスト困難、名前衝突リスク

#### 2. **単一責任原則違反**
- `websocket.js` が以下を担当：
  - WebSocket接続管理
  - ラップタイム管理
  - UI更新（速度、ギア、RPM...）
  - チャート更新
  - 3Dモデル更新
  - コースマップ更新

#### 3. **ファイル間の密結合**
```javascript
// websocket.js が他モジュールの内部を直接参照
timeData.shift();  // charts.js の変数
timeCounter++;     // charts.js の変数
car3DState.wheels  // car-3d.js の内部状態
```

#### 4. **一貫性のないコーディングスタイル**
- `var` / `let` / `const` が混在
- 関数定義スタイルが不統一（function文のみ）
- JSDocコメントがない

#### 5. **マジックナンバー**
```javascript
if (now - lastUiTs) >= UI_UPDATE_INTERVAL  // OK（定数）
if (temp < 40) return COLORS.accentCyan;   // NG（マジックナンバー）
if (temp < 80) return COLORS.accentGreen;  // NG
```

---

## リファクタリング戦略

### Phase 1: コーディング規約統一【優先度: 高】

#### 1.1 変数宣言
```javascript
// Before
var ws = null;
var reconnectDelay = 2000;

// After
const RECONNECT_DELAY_INITIAL = 2000;
let ws = null;
let reconnectDelay = RECONNECT_DELAY_INITIAL;
```

#### 1.2 JSDocコメント追加
```javascript
/**
 * タイヤ温度に応じた表示色を取得
 * @param {number} temp - タイヤ温度（摂氏）
 * @returns {string} CSS色文字列
 */
function getTyreTempColor(temp) {
    // ...
}
```

#### 1.3 定数の外部化
```javascript
// constants.js
export const TYRE_TEMP = {
    COLD_THRESHOLD: 40,
    OPTIMAL_LOW: 40,
    OPTIMAL_HIGH: 80,
    HOT_THRESHOLD: 100
};
```

### Phase 2: モジュール分割【優先度: 高】

#### 2.1 websocket.js の分割
```
websocket.js (506行)
    ↓
├── connection.js      (~80行)  - WebSocket接続・再接続
├── lap-manager.js     (~100行) - ラップタイム管理
├── telemetry-parser.js (~50行) - メッセージパース
└── ui-updater.js      (~250行) - UI更新ロジック
```

#### 2.2 ui_components.js の整理
```
ui_components.js (223行)
    ↓
├── constants.js       (~50行)  - COLORS, CONFIG等
├── dom-cache.js       (~100行) - DOM要素キャッシュ
└── utils.js           (~70行)  - ユーティリティ関数
```

### Phase 3: グローバル状態のカプセル化【優先度: 中】

#### 3.1 状態オブジェクトの導入
```javascript
// Before
var maxSpeed = 0;
var currentLapNumber = 0;
var bestLapTime = Infinity;

// After
const lapState = {
    maxSpeed: 0,
    currentLapNumber: 0,
    bestLapTime: Infinity,
    // ...
};
```

#### 3.2 モジュールパターン
```javascript
const LapManager = (function() {
    let state = {
        currentLap: 0,
        bestLapTime: Infinity,
        lapTimes: []
    };

    return {
        update(data) { /* ... */ },
        getBestLapTime() { return state.bestLapTime; },
        reset() { /* ... */ }
    };
})();
```

### Phase 4: car-3d.js の整理【優先度: 中】

#### 4.1 設定とロジックの分離
```javascript
// car-3d-config.js
export const CAR_CONFIG = { /* ... */ };
export const EXAGGERATION_CONFIG = { /* ... */ };

// car-3d-model.js
export function buildCarModel(group) { /* ... */ }

// car-3d-animation.js
export function updateCar3D(pitch, yaw, roll, rpm, steering) { /* ... */ }
```

#### 4.2 関数のグループ化
```javascript
// ビルダー関数（1100行中 約600行）
buildCarBody(), buildHoodAndRoof(), buildPillars(),
buildSideMirrors(), buildCanards(), buildWindows(),
buildAeroAndIntakes(), buildLights(), buildRearDetails(), buildWheels()

// → car-3d-builders.js として分離
```

### Phase 5: テスト可能性向上【優先度: 低】

#### 5.1 依存注入
```javascript
// Before
function updateTyreState(data) {
    elements.flTemp.textContent = Math.round(temps[0]);
    // ...
}

// After
function createTyreUpdater(elements) {
    return function(data) {
        elements.flTemp.textContent = Math.round(temps[0]);
        // ...
    };
}
```

#### 5.2 純粋関数化
```javascript
// Before（副作用あり）
function formatLapTime(ms) {
    if (ms === -1) return '--:--.---';
    // ...
}

// After（既に純粋関数だが、JSDoc追加）
/**
 * ラップタイムを文字列形式にフォーマット
 * @param {number} ms - ミリ秒（-1 = 未計測）
 * @returns {string} "M:SS.mmm" 形式
 */
export function formatLapTime(ms) { /* ... */ }
```

---

## 実装順序

### ステップ1: 即時改善（影響範囲小）
1. JSDocコメント追加
2. `const`/`let`への置き換え
3. マジックナンバーの定数化

### ステップ2: ファイル分割
1. `constants.js` 作成
2. `ui_components.js` から定数を移動
3. `websocket.js` を責任ごとに分割

### ステップ3: 構造改善
1. グローバル変数をオブジェクトにカプセル化
2. モジュールパターン適用

### ステップ4: car-3d.js 分割
1. 設定を外部ファイルへ
2. ビルダー関数を分離

---

## 期待される成果

| 指標 | Before | After |
|------|--------|-------|
| 最大ファイル行数 | 1117行 | ~400行 |
| グローバル変数 | 20+ | 5以下 |
| JSDocカバレッジ | 0% | 80%+ |
| 循環的複雑度 | 高 | 中 |
| テスト容易性 | 低 | 中 |

---

## 注意事項

### 後方互換性
- ブラウザ対応: ES6+（モジュールは使用しない）
- スクリプト読み込み順序を維持

### 移行期間
- 段階的リファクタリング
- 各ステップで動作確認

### ドキュメント
- README.md の更新
- 依存関係の明記

---

## 成果物

1. `constants.js` - 共通定数
2. `connection.js` - WebSocket接続管理
3. `lap-manager.js` - ラップタイム管理
4. `ui-updater.js` - UI更新
5. 更新された既存ファイル群
