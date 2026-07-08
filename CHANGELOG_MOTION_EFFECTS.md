# 3D車両モデル 挙動演出 更新履歴

---

## 2024-02-28 時点でのパラメータ変遷

### 初期実装（v1）
```javascript
amplification: { pitch: 2.5, roll: 2.0 }
bounce: { stiffness: 150, damping: 12 }
vibration: { enabled: true, baseAmplitude: 0.003, frequency: 30 }
```
**問題:** ブルブル震えるだけで動きが分からない

---

### 第1回修正（v2）
```javascript
amplification: { pitch: 1.5, roll: 1.3 }    // 控えめに
bounce: { stiffness: 25, damping: 4 }        // 柔らかく
vibration: { enabled: false }                 // 無効化
steering: { amplification: 1.0 }              // 実寸に
```
**問題:** ほぼ動かなくなった

---

### 第2回修正（v3）
```javascript
amplification: { pitch: 2.0, roll: 1.5 }    // 少し上げる
bounce: { stiffness: 60, damping: 8 }        // 中程度に
inertia: { lerpFactor: 0.12 }
```
**問題:** まだ動きが小さい

---

### 第3回修正（v4）★現在
```javascript
amplification: { pitch: 3.0, roll: 2.5 }    // 強めに
bounce: { stiffness: 40, damping: 3 }        // 柔らかく・揺れを残す
inertia: { lerpFactor: 0.15 }
vibration: { enabled: false }
steering: { amplification: 1.0, lerpFactor: 0.15 }
```
**ユーザーフィードバック:** ほぼなくなったな

---

## 現在の設定（car-3d.js より）

```javascript
var EXAGGERATION_CONFIG = {
    enabled: true,

    amplification: {
        pitch: 3.0,    // ピッチ増幅倍率
        roll: 2.5      // ロール増幅倍率
    },

    bounce: {
        enabled: true,
        stiffness: 40,    // バネ係数
        damping: 3        // 減衰係数
    },

    inertia: {
        enabled: true,
        lerpFactor: 0.15
    },

    vibration: {
        enabled: false,
        baseAmplitude: 0,
        rpmMultiplier: 0,
        frequency: 0
    },

    steering: {
        amplification: 1.0,
        lerpFactor: 0.15
    }
};
```

---

## バネ・ダンパーモデルの説明

### 数式
```
springForce = stiffness * (target - current)
dampingForce = damping * velocity
acceleration = springForce - dampingForce
velocity += acceleration * dt
current += velocity * dt
```

### stiffness/damping比による挙動

| stiffness | damping | 比 | 挙動 |
|-----------|---------|-----|------|
| 150 | 12 | 12.5 | 高速振動（初期） |
| 60 | 8 | 7.5 | 中程度（v3） |
| 40 | 3 | 13.3 | 揺れが残る（v4） |
| 25 | 4 | 6.25 | 遅い（v2） |

### 問題点の分析

**なぜ動かないのか？**

1. **バネの追従速度が遅い**
   - stiffness: 40 は1秒間に40ラジアン/秒の速度で追従
   - テレメトリーの変化量に対してバネが追いついていない可能性

2. **オーバーシュートがすぐ収束する**
   - damping: 3 に対して stiffness: 40
   - 比が13.3で、振動が1〜2回で収束

3. **元のテレメトリー値が小さい**
   - GT7のpitch/rollは実際には数度程度
   - 増幅3.0でも視覚的に分かりにくい可能性

---

## 次の調整案

### 案A: バネを硬くして速く追従
```javascript
bounce: { stiffness: 80, damping: 5 }  // 比: 16
```

### 案B: 増幅をさらに上げる
```javascript
amplification: { pitch: 4.0, roll: 3.0 }
```

### 案C: バウンス無効で直接lerp
```javascript
bounce: { enabled: false }
inertia: { lerpFactor: 0.3 }  // 速めに追従
```

### 案D: オーバーシュートを強調
```javascript
bounce: { stiffness: 50, damping: 2 }  // 比: 25（揺れ続ける）
```

---

## テスト用デモ値（test-mode.js）

### getDemoOrientation()
```javascript
{
    pitch: Math.sin(testTrajectoryIndex * 0.1) * 0.3,  // ±0.3 rad ≈ ±17°
    yaw: testTrajectoryIndex * 0.05,
    roll: Math.cos(testTrajectoryIndex * 0.08) * 0.2   // ±0.2 rad ≈ ±11°
}
```

### getDemoSteering()
```javascript
baseSteering = Math.sin(testTrajectoryIndex * 0.15) * 0.25;  // ±14°
quickTurn = Math.sin(testTrajectoryIndex * 0.4) * 0.05;      // ±3°
// 最大: ±17°
```

---

## データフロー

```
[GT7 Packet] → rotation_pitch, rotation_roll
      ↓
[websocket.js] updateCar3D(pitch, yaw, roll, rpm, steering)
      ↓
[car-3d.js] targetPitch = pitch * amplification.pitch
             targetRoll = roll * amplification.roll
      ↓
[animate loop] applySpringDamper() で displayPitch/roll を更新
      ↓
carGroup.rotation.x = displayPitch
carGroup.rotation.z = displayRoll
```

---

## 今後のデバッグ方針

1. **コンソールログ追加** - displayPitch, targetPitch, velocity を表示
2. **値の確認** - テレメトリーの実際の値範囲を確認
3. **バネの可視化** - 時系列グラフで動きを確認

---

**最終更新:** 2024-02-28
