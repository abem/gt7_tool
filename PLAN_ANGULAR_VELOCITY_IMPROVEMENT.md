# ANGULAR VELOCITY 3D 改善計画書

## 1. 現状の問題点

### 1.1 ユーザー報告
> 「ANGULAR VELOCITY 3Dがわかりにくい」

### 1.2 具体的な問題

| 問題 | 現状 | 影響 |
|------|------|------|
| **3Dキューブが小さい** | 120x60px | 回転が見にくい |
| **キューブが単調** | 緑の半透明ボックス | 車体との関連が不明 |
| **回転矢印が不明瞭** | 「→」テキストのみ | 回転方向が分かりにくい |
| **色が一律** | 緑一色 | 速度・方向の区別がない |
| **単位が不明** | 数値のみ | deg/s か rad/s か不明 |
| **RATE表示が数値のみ** | テキスト表示 | 直感的でない |

### 1.3 現在の実装

```html
<div class="cube-scene" style="width: 120px; height: 60px;">
    <div class="cube" id="rotation-cube">
        <!-- 6面のボックス -->
    </div>
</div>
<div class="rotation-arrow">→</div>  <!-- 矢印が分かりにくい -->
```

---

## 2. 改善提案

### 2.1 案A: 3Dキューブを車体モデルに置き換え

**概要:** CSS3Dのボックスではなく、簡易的な車体シルエットを使用

**メリット:**
- 車体の向きが直感的に理解できる
- CAR ATTITUDE 3Dとの統一感

**実装例:**
```html
<div class="car-silhouette" id="angular-car">
    <div class="car-body"></div>
    <div class="car-wheel fl"></div>
    <div class="car-wheel fr"></div>
    <div class="car-wheel rl"></div>
    <div class="car-wheel rr"></div>
</div>
```

---

### 2.2 案B: 角速度バーを追加

**概要:** 数値だけでなく、バーで視覚化

**実装例:**
```
PIT  │████████░░░░│ +12.5°/s
YAW  │░░░░░░░░████│ -8.3°/s
ROL  │████████████│ +25.0°/s
```

**メリット:**
- 速度が一目で分かる
- 正負の方向が明確

---

### 2.3 案C: 回転矢印を円弧に変更

**概要:** 「→」ではなく、回転方向を示す円弧を使用

**実装例:**
```
    ↻ PIT (前のめり)
  ↺ YAW (左回転)
    ↻ ROL (右傾き)
```

**CSS実装:**
```css
.rotation-pitch::before { content: "↻"; color: #ff6b6b; }
.rotation-pitch.negative::before { content: "↺"; color: #4ecdc4; }
```

---

### 2.4 案D: 色で速度を表現

**概要:** 角速度に応じて色を変える

| 速度 | 色 | 意味 |
|------|---|------|
| 0-5 deg/s | 緑 | 安定 |
| 5-15 deg/s | 黄 | 中程度 |
| 15-30 deg/s | オレンジ | 激しい |
| 30+ deg/s | 赤 | 危険域 |

**実装:**
```javascript
function getRateColor(rate) {
    const absRate = Math.abs(rate);
    if (absRate < 5) return '#00ff88';      // 緑
    if (absRate < 15) return '#ffcc00';     // 黄
    if (absRate < 30) return '#ff8800';     // オレンジ
    return '#ff4444';                       // 赤
}
```

---

### 2.5 案E: 3D表示を大きくする

**概要:** キューブサイズを2倍に

**変更:**
```css
.cube-scene {
    width: 200px;   /* 120 → 200 */
    height: 100px;  /* 60 → 100 */
}
```

---

### 2.6 案F: 単位を明記

**現在:**
```
PIT  +12.5
```

**改善後:**
```
PIT  +12.5°/s
```

---

## 3. 推奨組み合わせ

### 3.1 最小限の改善（低コスト）

| 案 | 内容 | 優先度 |
|---|------|--------|
| E | サイズ拡大 | 高 |
| F | 単位追加 | 高 |
| C | 矢印改善 | 中 |

### 3.2 本格的な改善（高コスト）

| 案 | 内容 | 優先度 |
|---|------|--------|
| A | 車体モデル化 | 高 |
| B | バー追加 | 高 |
| D | 色分け | 中 |

---

## 4. 実装サンプル（案B+C+E）

```html
<div class="card angular-velocity-card">
    <div class="card-title">ANGULAR VELOCITY 3D</div>
    
    <!-- 3D表示（大型化） -->
    <div class="cube-scene" style="width: 200px; height: 100px;">
        <div class="cube" id="rotation-cube">...</div>
    </div>
    
    <!-- 角速度バー -->
    <div class="rate-bars">
        <div class="rate-row">
            <span class="rate-label">PIT</span>
            <div class="rate-bar">
                <div class="rate-fill" id="pitch-bar" style="width: 50%;"></div>
            </div>
            <span class="rate-value" id="pitch-rate">+12.5°/s</span>
            <span class="rate-arrow">↻</span>
        </div>
        <div class="rate-row">
            <span class="rate-label">YAW</span>
            <div class="rate-bar">
                <div class="rate-fill" id="yaw-bar" style="width: 30%;"></div>
            </div>
            <span class="rate-value" id="yaw-rate">-8.3°/s</span>
            <span class="rate-arrow">↺</span>
        </div>
        <div class="rate-row">
            <span class="rate-label">ROL</span>
            <div class="rate-bar">
                <div class="rate-fill" id="roll-bar" style="width: 80%;"></div>
            </div>
            <span class="rate-value" id="roll-rate">+25.0°/s</span>
            <span class="rate-arrow">↻</span>
        </div>
    </div>
</div>
```

```css
.rate-bars {
    margin-top: 10px;
}

.rate-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
}

.rate-label {
    width: 30px;
    color: var(--text-secondary);
    font-size: 11px;
}

.rate-bar {
    flex: 1;
    height: 8px;
    background: rgba(255,255,255,0.1);
    border-radius: 4px;
    overflow: hidden;
}

.rate-fill {
    height: 100%;
    background: linear-gradient(90deg, #00ff88, #ffcc00);
    border-radius: 4px;
    transition: width 0.1s;
}

.rate-value {
    width: 70px;
    text-align: right;
    font-family: monospace;
    font-size: 11px;
}

.rate-arrow {
    font-size: 14px;
}
```

---

## 5. 今後の検討事項

- [ ] 角速度の最大値設定（バーの100%基準）
- [ ] 履歴グラフの追加
- [ ] アラート閾値の設定
- [ ] CAR ATTITUDE 3Dとの統合表示

---

**作成日:** 2026-03-01
**ステータス:** 計画段階
**優先度:** 中
