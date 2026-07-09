# バグ修正: WebGL 非対応環境で TEST MODE が起動しない

> **日付**: 2026-07-09
> **ブランチ**: `fix/webgl-graceful-degradation-2026-07-09`
> **対象**: `car-3d.js`（`initCar3D`）
> **重大度**: 高（WebGL が使えない環境でテストモード＝主要動作確認手段が完全に無効）

---

## 症状

WebGL が利用できないブラウザ/環境（GPU 無効・リモートデスクトップ・ハードウェアアクセラレーション OFF 等）で **TEST MODE ボタンを押しても何も起きない**（速度・RPM 等が 0/-- のまま。ボタン表示は STOP TEST に変わるが数値が動かない）。

コンソールに以下:
```
THREE.WebGLRenderer: Error creating WebGL context.
Uncaught Error: Error creating WebGL context.
    at initCar3D (car-3d.js:142)
    at ensureCar3DInitialized (test-mode.js:95)
    at HTMLButtonElement.<anonymous> (test-mode.js:67)   ← TEST MODE クリック
```

## 原因

`initCar3D()` の `new THREE.WebGLRenderer(...)`（car-3d.js:142）は WebGL コンテキスト生成に失敗すると**例外を投げる**。この関数は TEST MODE クリックハンドラの先頭で `ensureCar3DInitialized()` 経由で呼ばれる（test-mode.js:67）ため、例外がハンドラを中断し、**後続の `startTestMode()`（同 73行）に到達しない** → テストモードが起動しない。`OrbitControls` は try/catch で保護されていたが、レンダラー生成は未保護だった。同じ throw は WebSocket 接続時（websocket.js:665 の `initCar3D()`）でも発生していた。

## 修正

`initCar3D()` のレンダラー生成を try/catch で保護し、**WebGL 失敗を致命的にしない**:
- 失敗時は `console.warn` にとどめ、`car3DState.webglFailed = true` を立てて早期 return（例外を投げない）。
- 3D コンテナに「3D表示は利用できません (WebGL 非対応)」と表示。
- 関数冒頭のガードを `if (car3DState.initialized || car3DState.webglFailed) return;` に変更し、クリック/フレーム毎の再試行・再警告を防止。

`updateCar3D()` は既に `!car3DState.initialized` で早期 return するため、3D 無効時は自然に no-op になる。**WebGL が使える環境の挙動は不変**（try が成功するだけ）。

結果として、WebGL の有無に関わらず TEST MODE と WS 接続処理は最後まで実行され、3D 表示のみが無効化される。

## 検証

Playwright（headless Chromium）で `HTMLCanvasElement.getContext('webgl*')` を null に上書きし、**WebGL 非対応を強制再現**して確認:

| 条件 | 修正前 | 修正後 |
|------|--------|--------|
| WebGL 無効 + TEST MODE クリック | ❌ 起動せず（speed 0 のまま、Uncaught WebGL error） | ✅ 起動（speed 更新）、3Dに代替メッセージ、未捕捉例外0 |
| WebGL 有効（通常） | ✅ 3D 初期化・動作 | ✅ 3D 初期化・動作（回帰なし）、未捕捉例外0 |

`node --check car-3d.js` 通過。
