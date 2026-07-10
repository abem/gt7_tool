# CAR ATTITUDE マウス操作対応 計画書

## 現状の問題

- 3D車両モデルがテレメトリデータの `rotation_yaw` に応じて自動回転する
- コーナリング中など、車の向きが頻繁に変わるため「勝手にくるくるする」ように見える
- ユーザーが自由に視点を操作できない

## 対応方針

**マウスドラッグでカメラ視点を操作できるようにする**

### 技術的アプローチ

Three.js の `OrbitControls` を使用して、マウス操作でカメラを回転・ズームできるようにする。

## 事前確認事項

### Three.jsバージョン
- 現在: **r128** (`cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`)
- OrbitControlsもr128対応版を使用

### 読み込み方式
- レガシーscript方式（ES modulesではない）
- OrbitControlsは非モジュール版を使用

### yawの扱い
- **完全に無視**: yawは常に0に固定
- pitch/rollのみテレメトリから適用

---

## 変更内容

### 1. index.html (2行追加)

OrbitControlsをThree.js本体の直後に追加:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<!-- ↑ この行を追加 -->
```

### 2. car-3d.js (約15行変更)

#### 2.1 状態管理にcontrols追加 (3行)

```javascript
var car3DState = {
    scene: null,
    camera: null,
    renderer: null,
    carGroup: null,
    carBody: null,
    windows: [],
    wheels: [],
    initialized: false,
    animationId: null,
    pitch: 0,
    yaw: 0,
    roll: 0,
    topViewContext: null,
    topViewCanvas: null,
    controls: null  // 追加: OrbitControls
};
```

#### 2.2 initCar3D() でOrbitControls初期化 (6行)

カメラ作成後、グリッド追加前に挿入:

```javascript
// OrbitControls初期化
car3DState.controls = new THREE.OrbitControls(
    car3DState.camera,
    car3DState.renderer.domElement
);
car3DState.controls.enableDamping = true;
car3DState.controls.dampingFactor = 0.05;
car3DState.controls.target.set(0, 0.4, 0);
car3DState.controls.update();
```

#### 2.3 animate() でcontrols.update()追加 (1行)

```javascript
function animate() {
    car3DState.animationId = requestAnimationFrame(animate);
    if (car3DState.controls) {
        car3DState.controls.update();  // 追加
    }
    if (car3DState.renderer && car3DState.scene && car3DState.camera) {
        car3DState.renderer.render(car3DState.scene, car3DState.camera);
    }
}
```

#### 2.4 updateCar3D() でyawを無視 (1行)

```javascript
function updateCar3D(pitch, yaw, roll) {
    if (!car3DState.initialized || !car3DState.carGroup) return;

    car3DState.pitch = pitch || 0;
    car3DState.yaw = yaw || 0;  // 保持はするが適用しない
    car3DState.roll = roll || 0;

    // carGroup全体を回転（yawは無視して常に0）
    car3DState.carGroup.rotation.x = car3DState.pitch;
    car3DState.carGroup.rotation.y = 0;  // 変更: yawを無視
    car3DState.carGroup.rotation.z = car3DState.roll;

    // 数値表示はそのまま（実際のyaw値を表示）
    var pitchEl = document.getElementById('car-3d-pitch');
    var rollEl = document.getElementById('car-3d-roll');
    var yawEl = document.getElementById('car-3d-yaw');
    if (pitchEl) pitchEl.textContent = (pitch * 180 / Math.PI).toFixed(2) + '\u00B0';
    if (rollEl) rollEl.textContent = (roll * 180 / Math.PI).toFixed(2) + '\u00B0';
    if (yawEl) yawEl.textContent = (yaw * 180 / Math.PI).toFixed(2) + '\u00B0';
}
```

#### 2.5 エラーハンドリング (3行)

initCar3D()のOrbitControls初期化部分:

```javascript
// OrbitControls初期化（失敗時はカメラ固定で動作継続）
try {
    car3DState.controls = new THREE.OrbitControls(
        car3DState.camera,
        car3DState.renderer.domElement
    );
    car3DState.controls.enableDamping = true;
    car3DState.controls.dampingFactor = 0.05;
    car3DState.controls.target.set(0, 0.4, 0);
    car3DState.controls.update();
} catch (e) {
    console.warn('[CAR_3D] OrbitControls initialization failed:', e);
    car3DState.controls = null;
}
```

---

## 操作方法（ユーザー向け）

| 操作 | 動作 |
|------|------|
| 左ドラッグ | 視点回転 |
| 右ドラッグ | 視点パン |
| ホイール | ズームイン/アウト |

## 影響範囲

| ファイル | 変更内容 | 行数 |
|----------|----------|------|
| index.html | OrbitControls CDN追加 | +1 |
| car-3d.js | controls追加、初期化、animate更新、yaw無視 | ~20 |

**合計: 2ファイル、約21行**

## 注意事項

- OrbitControls初期化失敗時はカメラ固定で動作継続（フォールバック）
- 数値表示のyaw値は実際のテレメトリ値を維持（3Dモデルの回転のみ無視）
