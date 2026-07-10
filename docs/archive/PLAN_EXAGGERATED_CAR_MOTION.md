# 3D車両モデル演出強化計画書
## 振動・ピッチ・ロールを派手に動かす実装

---

## 1. 目的

GT7テレメトリーダッシュボードの3D車両モデルにおいて、実際のテレメトリー値よりも**派手に・ダイナミックに**動くように演出効果を追加する。

---

## 2. 現状分析

### 2.1 現在の実装
- `car-3d.js`の`updateCar3D(pitch, yaw, roll)`で、テレメトリー値をそのまま車体に適用
- 回転はリアルタイムで反映されるが、演出効果はなし
- データフロー: `websocket.js` → `updateCar3D()` → `carGroup.rotation.x/z`

### 2.2 問題点
- 実際のサスペンション動きは微小で、視覚的に分かりにくい
- 加減速やコーナリングの「感じ」が伝わりにくい

---

## 3. 実装する演出効果

### 3.1 増幅（Amplification）
実際の値に倍率をかけて、動きを大きく見せる

```
表示値 = テレメトリー値 × 増幅倍率
```

**パラメータ:**
| 項目 | デフォルト倍率 | 調整範囲 |
|------|---------------|----------|
| ピッチ増幅 | 2.5x | 1.0 ~ 5.0 |
| ロール増幅 | 2.0x | 1.0 ~ 4.0 |

---

### 3.2 バウンス（Bounce / Spring Effect）
急激な変化時に弾むようなオーバーシュート効果

```
目標値へ向かう際、一瞬オーバーシュートしてから戻る
```

**実装方式:**
- バネ・ダンパーモデル（Spring-Damper）
- `acceleration = stiffness * (target - current) - damping * velocity`
- `velocity += acceleration * dt`
- `current += velocity * dt`

**パラメータ:**
| 項目 | デフォルト値 | 説明 |
|------|-------------|------|
| stiffness | 150 | バネの硬さ（大きいほど素早く追従） |
| damping | 12 | 減衰係数（大きいほどオーバーシュート抑える） |

---

### 3.3 慣性モーション（Inertia / Lag）
車体の動きが入力より遅れてついてくる効果

```
急な入力変化に対して、車体が「遅れて」反応
```

**実装方式:**
- ローパスフィルターまたは単純な線形補間
- `displayValue = lerp(displayValue, targetValue, lerpFactor)`

**パラメータ:**
| 項目 | デフォルト値 | 説明 |
|------|-------------|------|
| lerpFactor | 0.15 | 補間係数（小さいほど遅れる） |

---

### 3.4 微振動（Micro-vibration）
エンジン振動や路面の荒れを表現する微細な揺れ

```
常にランダムな微小な揺れを追加
```

**実装方式:**
- 現在時刻に基づく擬似ランダム振動
- エンジン回転数（RPM）に連動して振動強度を変化

**パラメータ:**
| 項目 | デフォルト値 | 説明 |
|------|-------------|------|
| baseAmplitude | 0.003 | 基本振動振幅 |
| rpmMultiplier | 0.00001 | RPM連動係数 |
| frequency | 30 | 振動周波数（Hz） |

---

## 4. 設定可能なパラメータ一覧

```javascript
var EXAGGERATION_CONFIG = {
    // 全体有効/無効
    enabled: true,

    // 増幅設定
    amplification: {
        pitch: 2.5,    // ピッチ増幅倍率
        roll: 2.0      // ロール増幅倍率
    },

    // バウンス（バネ）設定
    bounce: {
        enabled: true,
        stiffness: 150,   // バネ係数
        damping: 12       // 減衰係数
    },

    // 慣性（遅延）設定
    inertia: {
        enabled: true,
        lerpFactor: 0.15  // 補間係数（0.01 ~ 1.0）
    },

    // 微振動設定
    vibration: {
        enabled: true,
        baseAmplitude: 0.003,
        rpmMultiplier: 0.00001,
        frequency: 30
    }
};
```

---

## 5. 実装箇所

### 5.1 変更ファイル
**`car-3d.js`** のみ

### 5.2 変更内容

1. **設定オブジェクト追加**（ファイル先頭）
   - `EXAGGERATION_CONFIG`オブジェクト

2. **状態管理オブジェクト拡張**（`car3DState`）
   - 追加: `displayPitch`, `displayRoll`（現在の表示値）
   - 追加: `pitchVelocity`, `rollVelocity`（バウンス用速度）
   - 追加: `lastUpdateTime`（Δt計算用）

3. **新しい関数追加**
   ```javascript
   // 増幅適用
   function applyAmplification(pitch, roll) { ... }

   // バウンス計算（バネ・ダンパー）
   function applyBounce(target, current, velocity, dt) { ... }

   // 慣性補間
   function applyInertia(current, target, lerpFactor) { ... }

   // 微振動生成
   function generateVibration(rpm, time) { ... }
   ```

4. **`updateCar3D()`関数の改修**
   - 入力値に対して上記4つの効果を順次適用
   - RPMデータを追加で受け取るよう引数拡張

5. **アニメーションループでの補間更新**
   - `requestAnimationFrame`内で慣性・バウンスを継続計算
   - テレメトリー更新がなくても演出は継続

---

## 6. データフロー（改修後）

```
[GT7 Packet]
    │
    ▼
[websocket.js] handleTelemetryMessage()
    │ pitch, yaw, roll, rpm
    ▼
[car-3d.js] updateCar3D(pitch, yaw, roll, rpm)
    │
    ├─► applyAmplification()     // 増幅
    ├─► (バウンス目標値として保存)
    ├─► (慣性用目標値として保存)
    │
    ▼
[animate loop] 毎フレーム
    │
    ├─► applyBounce()           // バネ計算
    ├─► applyInertia()          // 補間
    ├─► generateVibration()     // 微振動追加
    │
    ▼
carGroup.rotation.x = displayPitch + vibration.x
carGroup.rotation.z = displayRoll + vibration.z
```

---

## 7. 実装順序

1. **Phase 1: 増幅機能**
   - `EXAGGERATION_CONFIG`追加
   - `applyAmplification()`実装
   - `updateCar3D()`で増幅適用

2. **Phase 2: 慣性モーション**
   - `car3DState`に`displayPitch`, `displayRoll`追加
   - `applyInertia()`実装
   - `animate()`内で補間更新

3. **Phase 3: バウンス効果**
   - `car3DState`に速度変数追加
   - `applyBounce()`実装
   - バネ係数の調整

4. **Phase 4: 微振動**
   - `generateVibration()`実装
   - RPM連動の振動強度
   - `updateCar3D()`の引数にrpm追加

5. **Phase 5: 調整**
   - パラメータの微調整
   - `websocket.js`の呼び出し元修正（rpm追加）

---

## 8. UI制御（オプション・将来拡張）

必要に応じてダッシュボードに設定UIを追加可能：
- [ ] 演出ON/OFFトグル
- [ ] 増幅倍率スライダー
- [ ] バウンス強度スライダー
- [ ] 慣性の強さスライダー

---

## 9. 期待される効果

| シチュエーション | 演出前 | 演出後 |
|-----------------|--------|--------|
| 急ブレーキ | わずかに前傾 | 大きくノーズダイブ、バウンス付き |
| 急加速 | わずかに後傾 | 大きくリフト、慣性で遅れて追従 |
| コーナーリング | わずかに傾く | 大きくロール、バネで揺れる |
| アイドリング | 静止 | 微振動でリアル感 |
| 高回転 | 静止 | RPM連動の激しい振動 |

---

## 10. 注意事項

- 倍率を大きくしすぎると不自然になるため、初期値は控えめに設定
- バウンスの`damping`を小さくしすぎると永遠に揺れ続ける
- パフォーマンスへの影響は軽微（計算量は微小）
- OrbitControlsとの干渉はなし（車体グループのみ回転）

---

**作成日:** 2024-XX-XX
**ステータス:** 計画段階
