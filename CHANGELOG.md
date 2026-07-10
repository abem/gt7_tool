# 変更履歴 (CHANGELOG)

このファイルは GT7 Telemetry Dashboard の主要な変更を時系列でまとめたものです。
「何を・どう直したか」を確認できる一次資料として維持します。

形式: 日付ごとに `feat`(機能) / `fix`(修正) / `refactor`(整理) / `docs`(文書) で分類。

---

## 2026-07-10 — カードを自由移動（ドラッグ配置）

### feat: カード(.card)をマウスでピックして自由に移動
- **要望**: 「ブロックをマウスでピックして自由に移動できるように」。
- **内容**: 新規 `card-drag.js`（依存なしのプレーンスクリプト）を追加。
  - トップレベルの `.card` を、その**タイトル(`.card-title`)をハンドル**にドラッグで自由移動。
  - 列（`.left/center/right-panel`）は `overflow`＋`contain:content` でクリップされるため、ドラッグ開始時にカードを **`body` 直下へ浮かせて(`position:fixed`)** 画面全体を自由に動かせるようにする。移動元の列は自然に詰まる。
  - 位置は **localStorage に保存**し次回ロードで復元（ビューポート外に出た場合はクランプ）。
  - ヘッダの **「↻ 配置」ボタンで全リセット** / **タイトルのダブルクリックで個別リセット**。
  - クリックとドラッグは閾値(4px)で区別。ボタン/入力/canvas 上からはドラッグ開始しない（既存操作を阻害しない）。移動/終了は `document` で拾い、再配置で pointer capture が外れる問題を回避。
- **検証**: headless でタイトルをドラッグ→カードが `body` 直下へ `position:fixed` で移動、リロードで位置維持、リセットで列へ復帰、未捕捉例外0 を確認。

### fix: 全カードをドラッグ可能に + 敵対的レビュー指摘の反映
- **全カード対応**: タイトル直下限定だと 20枚中9枚しか掴めなかった（COURSE MAP はタイトルがヘッダ内にネスト、スタット系はタイトル無し）。**カード全体をハンドル**にして 20/20 を掴めるように（canvas/ボタン等の操作系からはドラッグ開始しない＝チャート操作や各ボタンは従来どおり）。
- **`Dockerfile`**: JS をファイル名指定で COPY していたため `card-drag.js` が 404 だった → COPY 行に追加。
- **敵対的レビュー(3観点×検証)で CONFIRMED 6件を修正**:
  - [high] 枠外でボタンを離すとドラッグが張り付く → `pointermove` で `buttons===0` を検知して終了 + `window blur` でも解除。
  - [med] `touch-action:none` 未指定でタッチ時にパンに奪われる → ハンドルに付与。
  - [med] 多点タッチの再入で座標が飛ぶ → 発端 `pointerId` を追跡し1ジェスチャに限定。
  - [med] 複数カードを戻すと復帰位置がずれる（元 index を現配列に適用）→ 残存兄弟を走査して安定復帰。
  - [low×2] 浮かせたカードが DRIVE モードの非表示を逃れる → `body.drive-mode .draggable-card.floating:not(.course-map-card){display:none}` を追加。
- **検証**: headless で 20/20 draggable・CAR ATTITUDE/COURSE MAP/TYRES/スタット系のドラッグ浮上・未捕捉例外0 を確認。実デプロイ済みコンテナでも確認。

---

## 2026-07-10 — CAR ATTITUDE を WebGL不要の2D図に刷新

### feat: 3D車モデル(WebGL)を Canvas2D の姿勢+サスペンション図に置き換え
- **背景**: WebGL が使えない環境（GPUプロセスクラッシュ・リモートデスクトップ・HWアクセラ無効等）では Three.js の3Dモデルが一切描画できなかった。旧「ださい車の3D」を廃止し、GPU非依存で必ず描画される2D図に刷新。
- **内容**: `car-3d.js` を Three.js/WebGL から **Canvas2D のアイソメトリック（クォータービュー）描画に全面書き換え**:
  - 車体をアイソメの箱で描き、**ロール/ピッチ/ヨー**で傾く様子を水平グリッド基準で図示
  - **4輪サスペンションのストラット**を色分け表示（縮み=赤 / 伸び=青、`data.susp_height` の4輪相対偏差）＋接地影
  - PITCH/ROLL/YAW 数値をキャンバス右上に直描（カード高が狭い環境での重なりを防止）＋凡例
  - 空だった「TOP VIEW」枠と重なる数値行を非表示化して詰め
  - 依存する `three.min.js` / `OrbitControls.js` を index.html から除去（読み込み軽量化）
- **互換**: 公開口 `initCar3D()` / `updateCar3D()` / `car3DState.initialized` を維持（呼び出し側は susp 引数追加のみ）。`initCar3D` は例外を投げない。
- **検証**: Playwright headless で **WebGL を完全無効化**した状態で TEST MODE 実行 → 姿勢図が描画・4輪サス色分け・PITCH/ROLL/YAW 更新・未捕捉例外0 を確認（複数姿勢のスクリーンショットで目視）。

### fix: 敵対的レビュー指摘の反映（前後関係の描画・防御・テスト刷新）
- **前後関係(depth)の不具合**: 車輪を車体の後にまとめて描いていたため、奥側の車輪がルーフの上に浮いて見えた（ヨー大で顕著）。車体中心の投影奥行きを基準に**奥の車輪→車体→手前の車輪**の順で描くよう `render()` を修正し、正しい遮蔽に。実デプロイ済みコンテナ（WebGL無効）で yaw≈75° の姿勢で解消を目視確認。
- **防御的ハードニング**（到達経路は稀だが「例外を投げない」契約を厳守）:
  - `updateCar3D` に `finiteOr0()` を追加。`NaN`/`±Infinity`/文字列の pitch/yaw/roll/susp を 0 に落とし、投影の NaN 伝播でキャンバスが無音のまま真っ白になるのを防止。
  - `initCar3D` で `getContext('2d')` が null の場合、生成済み canvas を除去して静かに中止（二重生成防止）。`resizeAttitude2D` も ctx 無しなら早期 return。
- **テスト刷新**: `tests/test-glass.js` を旧WebGLの青ガラス/赤ルーフのピクセル検査から、**Canvas2D姿勢図のスモークテスト**へ全面刷新（削除済み `THREE` global と `car3DState.renderer/scene/camera` への参照で常時ハードフェイルしていた指摘2件を解消）。検査内容: `initCar3D` 存在・THREE非依存・`car3DState.initialized===true`・canvas非空・ページ例外0。
- **レビュー体制**: `car-3d.js` に対し3観点（投影/回転の数学・実行時エッジケース・呼び出し口整合）× 敵対的検証のワークフローを実施。**本番コードの must-fix はゼロ**（数学/エッジ系の指摘4件は呼び出し側の `|| 0` と数値テレメトリにより到達不能として REFUTED）、CONFIRMED 2件はいずれも上記テストコードの陳腐化で対応済み。

### feat: 「箱」表現を廃し、ダブルウィッシュボーンの針金（ワイヤーフレーム）図に作り替え
- **背景**: ソリッドな箱の車体が分かりにくいとの指摘。サスペンションの動きが伝わる「針金」表現へ。
- **内容**: `car-3d.js` の描画を全面刷新（投影/回転の数学は不変）:
  - 車体は塗り面の箱をやめ、**スペースフレーム風の細線シャシー**（左右レール＋クロスメンバー＋前方に収束するノーズ＋ロールフープ/コックピット枠）に変更。前後の向きが分かる。
  - 各輪を**ダブルウィッシュボーン**で線描: 上下Aアーム（内側2ピボット→ボールジョイント）、アップライト（ナックル）、ハブキャリア、**コイルオーバー（ジグザグのばね）**。サス偏差でハブが上下し、アームが実際に角度を変え、ばね長が伸縮する。
  - 伸縮の色分けは踏襲（縮み=赤 / 伸び=青、中立=緑）。ばねとホイールリムに反映。ホイールはタイヤ輪郭＋リム＋スポークの針金表現。
  - 各コーナーを奥→手前でソートして自然な重なりに。接地影は最下層。
- **検証**: headless（WebGL無効）で複数姿勢（yaw 23〜97°）を描画・目視。4輪のウィッシュボーン/ばね/色分け・PITCH/ROLL/YAW・未捕捉例外0 を確認。

### fix: 「CAR ATTITUDE が何も表示されない」を解消（キャッシュ無効化＋自動初期化）
- **原因**: (1) 静的配信に `Cache-Control` が無く、ブラウザが**古い WebGL 版の car-3d.js をキャッシュから使い続ける**と、GPU が落ちた環境では旧コードが例外を投げて何も描かれない。(2) `initCar3D()` は WebSocket 接続時か TEST MODE 押下時しか呼ばれず、未接続だとキャンバス自体が生成されなかった。
- **修正**:
  - `main.py` の `index_handler` / `static_handler` に `Cache-Control: no-cache` を付与。ETag による再検証を必須化し、デプロイ後に古い JS/HTML を掴み続ける問題を恒久的に排除（304 で軽量）。
  - `car-3d.js` にページ読み込み時の**自動初期化**を追加（`DOMContentLoaded`）。WebSocket 接続や TEST MODE を待たず、まず中立姿勢の図を必ず表示する。`initCar3D` は `initialized` ガードで冪等なので二重初期化なし。
- **検証**: 再ビルド後、`Cache-Control: no-cache` の送出を確認。TEST MODE を押さない通常ロードで中立姿勢図（シャシー＋4輪＋緑ばね, PITCH/ROLL/YAW=0.0°）が描画・未捕捉例外0 を確認。

### change: 車体（シャシー）を廃し、サスペンションとタイヤのみの固定クォータービューに
- **要望**: 「車体は回転しなくていい／サスペンションとタイヤだけ描画して」。
- **変更**: `car-3d.js` から**スペースフレーム風シャシーの描画を削除**し、姿勢回転（`rotateAttitude`/`projLocal`）も撤去。4輪のダブルウィッシュボーン＋コイルオーバー＋タイヤのみを**固定クォータービュー**で描く。荷重移動は各輪のサス伸縮（ばね長・色）で表現し、ピッチ/ロール/ヨーは数値表示で維持。未使用になった諸元（`railY`/`hoopTop`/`frame`/`frameHoop`）を整理し、全体スケールを拡大。
- **検証**: headless で複数フレームを描画・目視（4輪の位置は固定、サス状態のみ時間変化＝ばねの伸縮/色が変わる）・未捕捉例外0。

### feat: 前輪のステア連動（タイヤが実際に切れる）
- **要望**: 「ステア連動 → 前輪を実際に切って見せる」。
- **内容**: 各タイヤを **3D 円盤**（上ベクトルと転がり方向の張る平面）として投影し、前輪（FL/FR）を `steering`（= `wheel_rotation`, rad）でキングピン軸まわりに回転させる。後輪は直進のまま。
  - 実舵角は小さめなので、**接地点に進行方向の明るいアロー（シアン）**を追加。後輪は常に前方を指して基準になり、前輪はステアで振れるので切れ角がひと目で分かる。
  - タイヤ円盤自体の切れ角は視認性のため誇張（`STEER_GAIN`）。**正確な角度は従来どおり STEERING ゲージ**に数値表示。
- **検証**: 舵角を固定注入した headless 比較（直進=4輪のアロー平行 / 右舵=前2輪のみ旋回・後2輪は基準）で前輪のみが切れることを目視確認・未捕捉例外0。

### change: G-FORCE パネルを廃止し、重心点として CAR ATTITUDE に統合
- **要望**: 「CAR ATTITUDE に重心点を置けないか／G-FORCE を廃止してグラフを一緒に」。
- **内容**:
  - **重心点(CoG)を CAR ATTITUDE に追加**（`car-3d.js`）。`body_accel_sway`(横G)/`body_accel_surge`(縦G) を受ける `setCarGForce()` を新設し、G に応じて重心ドットを地面基準で移動。**g-g トレール**（軌跡）と 1G 参照リング・中心十字も地面に描画し、旧 G-FORCE メーターの機能を統合。CoG は接地マーカー＋鉛直線＋浮いたドット＋`CoG x.xxG` ラベルで表示。
  - 重心の移動方向は「荷重側（＝加速と逆向き）」を既定に（`COG.signLat/signLong`。実車で逆に見えたら符号反転）。移動量は `COG.gain`、最大半径は `COG.maxR` でクランプ。
  - **G-FORCE パネルを完全廃止**: `index.html` の `.gforce-card`、`ui_components.js` の `gforceState`/`initGForceMeter`/`drawGForceMeter`/`updateGForceMeter`、`styles.css` の `.gforce-*` を削除。呼び出し元（`websocket.js`/`test-mode.js`）を `updateGForceMeter(...)` → `setCarGForce(...)` に置換。
  - **BODY ACCEL パネル（sway/heave/surge 数値）は存置**（別物）。デモの `getDemoGForceData()` も存置（BODY ACCEL と CoG の両方へ供給）。
- **検証**: headless（WebGL無効）TEST MODE で重心ドット＋G値ラベル＋トレールが描画・BODY ACCEL 数値は継続・未捕捉例外0・`gforce`/`updateGForceMeter` の残存参照0 を確認。

### refine: ワイヤーを細く・重心点をマゼンタ＋点滅に
- **要望**: 「ウィッシュボーンの線を細く／重心点が青でサスと被る→点滅」。
- **内容**:
  - ウィッシュボーン等の線を細線化（アーム 2.2–2.6→1.5、アップライト 3→2、ハブキャリア 2.4→1.6、節点も縮小）で見やすく。
  - 重心点の色をサスの青（伸び）と被らない**マゼンタ (#FF4FC3)** に変更（ドット/グロー/鉛直線/接地マーカー/トレールを統一）。
  - 重心ドット＋グローを **~1.3Hz で明滅**（`cogPulse()`, `globalAlpha` を 0.35–1.0 で脈動）。明滅のため `renderLoop` を毎フレーム描画に変更（小キャンバスでコスト軽微）。
- **検証**: 固定G注入の headless 2フレーム比較でグロー強度が脈動（点滅）を確認・未捕捉例外0。

## 2026-07-09 — 挙動保存リファクタリング（フロント/バック横断）

### refactor: 全ソースの挙動保存整理（13ファイル +500/-511）
- **方針**: 観測可能な挙動を一切変えない機械的整理のみ。リスクの高い構造変更（ファイル分割・クロスファイル記号のリネーム・ES Module 化・シグネチャ変更・視覚に影響する CSS 変更）は**意図的に全除外**。
- **主な内容**:
  - 死コード削除: `ui_components.js` の `updateRotation3D()`、`lap-manager.js` の未参照「グローバル露出」8記号（いずれも `*.js`/`*.html` の独立 grep で裸参照ゼロを確認）。
  - マジックナンバーの定数化: `MAX_G`・`CAR_BODY_INSET`・`DEMO_MAX_RPM`・`KMH_TO_MS`/`GRAVITY_MS2`・`PEDAL_PCT_DIVISOR` 等（値は不変、多くは関数局所スコープで共有スコープ衝突を回避）。
  - 重複統合: `charts.js` の加速Gポリライン描画を `drawSeries()` に、`telemetry-analysis.js` の delta リセット3箇所を `clearDeltaUI()` に、`test-mode.js` の同一式の重複ローカルを集約。
  - `var`→`const`/`let`（局所のみ。クロスファイル参照されるトップレベル `var` は温存）、主要関数への JSDoc 付与。
  - `styles.css` は**完全一致する重複ルールのみ**をグルーピング統合。
- **検証**: 全 JS `node --check` / 全 PY `py_compile` 通過、ファイル毎の敵対的 diff レビューで 13/13 挙動保存（blocker 0）、Playwright headless での **TEST MODE** E2E スモークがリファクタ前後で同一 PASS（未捕捉 JS 例外 0 件、`speed`/`rpm`/`gear` がデモデータで駆動）。
- ⚠️ 実機（PS5）実テレメトリでは未確認。検証は TEST MODE + headless スモーク + 静的解析 + grep 監査による（実データ経路のロジックは未変更）。

### docs: リファクタリング報告書を新設
- `docs/refactoring-2026-07-09.md` を追加。実施内容・4層の検証結果・**意図的に見送った項目**を記録。
- ⚠️ 見送り項目に**潜在バグ2件**を明記: `showConnectionError`（`ui_components.js` 定義が `websocket.js` で上書きシャドウ）と `getSectorClass`（`websocket.js`/`test-mode.js` で閾値の異なる同名関数の二重定義）。→ 同日 `fix/duplicate-definitions-2026-07-09` で修正（下記）。

### fix: グローバル関数の二重定義2件を解消（読み込み順シャドウ）
- **背景**: 全JSがプレーン `<script>` で単一グローバルスコープを共有するため、同名トップレベル関数は後読み込みの宣言が先を上書きする。
- **`getSectorClass`（実害あり）**: `test-mode.js`（ガード無し・閾値0.3/0.6）が後読み込みで `websocket.js` の正準版（`best<=0→''` ガード付き・閾値0.1/0.3）を**実テレメトリ経路まで上書きシャドウ**していた。結果、実データのセクター色分けがデモ用の緩い閾値で判定され、かつベストセクター未設定時に `''` でなく `'red'` を返していた。→ `test-mode.js` の重複を削除し両経路を正準版に一本化。
- **`showConnectionError`（死コード）**: `ui_components.js` のトースト版が `websocket.js` のステータスピル版に上書きされ死んでいた。→ 死んでいた `ui_components.js` 版を削除（実行挙動は不変）。
- **検証**: 全対象 `node --check` 通過、`getSectorClass` 純関数ユニットテスト8/8（閾値+ガード）、Playwright TEST MODE E2E でセクター着色を確認・未捕捉例外0、敵対的レビュー3体が全て refuted=false。**網羅探索でトップレベル関数108個・var/let/const 57個すべて名前一意＝他の同種衝突なし**を確認。
- 詳細: `docs/bugfix-duplicate-definitions-2026-07-09.md`。⚠️ 実機PS5では未確認（実データ経路のロジックは未変更、閾値/ガードの是正のみ）。

### fix: WebGL 非対応環境で TEST MODE が起動しない不具合を修正
- **症状**: WebGL が使えないブラウザ/環境（GPU無効・リモートデスクトップ・ハードウェアアクセラレーションOFF 等）で TEST MODE ボタンを押しても数値が動かない（`THREE.WebGLRenderer: Error creating WebGL context`）。
- **原因**: `initCar3D()`（car-3d.js:142）のレンダラー生成が WebGL 失敗時に**例外を投げ**、TEST MODE クリックハンドラ（test-mode.js:67 の `ensureCar3DInitialized`）を中断 → 後続の `startTestMode()` に到達せずテストモードが起動しなかった。
- **修正**: レンダラー生成を try/catch で保護し、失敗時は `car3DState.webglFailed` を立てて 3D 表示のみ無効化・代替メッセージ表示で継続（例外を投げない）。関数冒頭ガードに `webglFailed` を追加し再試行を抑止。WebGL 有効時の挙動は不変。
- **検証**: Playwright で `getContext('webgl*')` を null 化し WebGL 非対応を強制再現 → 修正前は起動せず、修正後は起動（speed 更新・未捕捉例外0・3Dに代替表示）。WebGL 有効時も回帰なし。詳細: `docs/bugfix-webgl-graceful-degradation-2026-07-09.md`。

---

## 2026-07-08 — バックエンド安定化・構成整理

### fix: Salsa20 復号の致命的バグ修正（5日間の機能不全解消）
- **現象**: コンテナ稼働中に `Decryption failed: name 'Salsa20' is not defined` が **152万3669件**（`docker logs ... | grep -c` で実測）記録され、PS5 からの全テレメトリパケットが捨てられてダッシュボードが機能しなかった（TEST MODE のみ動作）。
- **原因**: `decoder.py` のコメント（L13-16）で「`_try_decrypt` 内で遅延 import する」と宣言されていた `from Crypto.Cipher import Salsa20` が**実装漏れ**で存在しなかった。
- **修正**: `_try_decrypt` メソッド冒頭に遅延 import を追加（コメント通りの動作にする）。
- **効果**: 復号成功で PS5 実機テレメトリが復活（⚠️ 実機での復号成功確認は未実施・コンテナ再ビルド後に要確認）。

### refactor: UDP 受信ループの非同期化
- **背景**: 従来 `telemetry.py` は同期ソケット + `settimeout(1.0)` のブロッキング `receive()` を `while True:` 内で呼び、`asyncio.sleep(0.01)` の空ポーリングで回していた（CPU 無駄・イベントループ阻塞）。
- **改修**:
  - `telemetry.py` を `asyncio.DatagramProtocol` ベースに全面書き換え。受信キュー（`asyncio.Queue`）経由で `await receive()` によりパケット到着時のみ処理。
  - `main.py` の受信ループから `asyncio.sleep(0.01)` を廃止。ハートビート送信は `_heartbeat_loop` に独立タスク化し受信ループから分離。
  - API 変更: `receive()` / `send_heartbeat()` が `async def` 化、`await connect()` 追加。
  - **レビュー後修正**: `send_heartbeat()` 内の間隔チェックを削除し、間隔制御を `_heartbeat_loop` 側（`asyncio.sleep`）に一元化。二重制御を解消。
- **効果**: イベントループの阻塞解消、CPU 使用率改善（⚠️ 実機での受信レート・遅延確認は未実施）。

### refactor: 旧亜種ディレクトリの `archive/` 退避
- `gt7_tool_dev` / `gt7_tool_car_attitude2` / `gt7dashboard` を `Projects/gt7/archive/` へ移動。
- **`gt7_tool` を唯一の正実装として明確化**。
- ⚠️ **訂正（レビューで発覚）**: 初版は「2亜種の `.git` は親消失済みの孤立ポインタ」と記載したが**誤り**。実際は親リポジトリ `/home/abem/docker/gt7_tool`（branch `feature/dev2026-06-14`）が現存し、**9ファイル約1300行の未コミット変更**（APEX Broadcast UI中間状態）が残っていた。
- `gt7_tool`（正実装）に同等作業がコミット済みであることを確認した上で破棄。ただし事前に差分を `archive/_snapshots/` にスナップショット保存（patch + 未追跡ファイル）。復元手順は `archive/_snapshots/README.md` 参照。

### refactor: デバッグ/検証スクリプトの `scripts/` 集約
- ルート直下に散乱していた `debug_*.py` / `verify_*.py` / `capture_*.py` / `check_*.py` 等 **26 ファイル**を `scripts/` へ整理（ワーキングツリー上の移動）。
- `test_course_detection.py` は正規単体テストとして `tests/` へ移動。
- `scripts/README.md` に分類と実行方法を明記。
- ⚠️ **重要**: 26ファイルは `.gitignore` パターンに一致するため **git非追跡**。コミットに含まれるのは `scripts/README.md` のみ。ワーキングツリー上にのみ存在し、別環境へクローンしても復元されない。

### test: Salsa20 復号の回帰テスト新設
- `tests/test_decoder.py` を追加（11 テスト）:
  - `_try_decrypt` の NameError 再発防止（Bug#1 回帰）
  - XOR フォールバック動作（A/B/~ 全ハートビートタイプ）
  - フィールド抽出（`parse`）の正常系・サイズ不足時のエラーハンドリング
  - `CourseEstimator` の基本動作・bounds ヘルパー
- `requirements.txt` に `pytest` を追加。
- `.gitignore` の `test_*.py` 除外ルールに対し `!tests/` 例外を追加（正規テストをトラック）。

検証: `pytest tests/ -v` → **12 passed**（`test_course_detection.py` 含む全件 PASS・コンソールエラー 0）。⚠️ 実機（PS5）での復号成功・受信レート・ハートビート周期は**未確認**。コンテナ再ビルド後の実機動作確認が必須。

### fix: 第2回レビュー指摘への対応（非同期受信の堅牢化）

第2回レビューで指摘された非同期受信回りの信頼性問題を修正:

- **キュー溢れ時の警告ログ追加** (`telemetry.py`): 受信キュー（256件）が溢れてパケットを破棄する際、60秒に1回・累積ドロップ数を `logger.warning` で通知。従来は無警告破棄で「テレメトリが遅い/飛ぶ」の原因診断ができなかった。
- **`receive()` の `CancelledError` を re-raise**: タスクキャンセル時に正しく終了できるよう、握りつぶしを廃止。
- **`telemetry_background_task` の再起動安全網** (`main.py`): 新設した `telemetry_supervisor` が異常終了を検知し、指数バックオフ（最大60秒）で再起動。従来は例外で終了するとテレメトリ受信が完全停止し、かつ気づく手段がなかった。
- **`last_heartbeat` を記録専用と明記**: ハートビート間隔制御を `_heartbeat_loop` に一元化した結果デッドコード化していたが、観測用に残しコメントで「未参照・記録専用」と明記。

また、archive/ 破棄前の「gt7_tool 側に同等作業がコミット済み」という主張について、**実際にファイル単位で比較検証**を実施（共通ベースコミット `769b299` を確認の上、patch適用状態と gt7_tool main を9ファイル全件 diff）。gt7_tool 側が docker側の APEX Broadcast 変更を含む上位集合（スーパーセット）であり、復元すべき未反映変更はないことを実証した。

検証: `pytest tests/ -v` → **12 passed**（再確認）。

### fix: 第3回レビュー指摘への対応（説明訂正・シャットダウン経路の明示）

第3回レビューで、archive/比較表の説明不正確と telemetry_supervisor のシャットダウン経路欠如を指摘され対応:

- **比較表の説明を patch 実物ベースで全面訂正** (`docs/refactoring-2026-07-08.md`):
  - course-map.js を「5引数API残余」としていたのは誤り（test-mode.js と混同）。実態は**グロー効果の配色変更のみ**。
  - index.html を「LAP HISTORY ラベル」としていたのも誤り。実態は color-scheme meta追加・aria-live属性・inline style→class化。
  - 初版は diff の `<` 行から推測で記述してしまったことが原因。全9ファイルを patch から抽出して再確認し、事実ベースで書き直した。結論（gt7_tool が上位集合）は不変。
- **`on_cleanup` フック新設** (`main.py`): telemetry_supervisor を明示的にキャンセル→await でクリーン終了。第2回で CancelledError を re-raise する設計にした一方、それを発火する経路が存在しない不整合を解消。`app.on_cleanup.append(on_cleanup)` で登録し、アプリ終了時に supervisor→background_task→heartbeat_loop が連鎖的にクリーンアップされる構造に。

検証: `pytest tests/ -v` → **12 passed**（再々確認）。

### fix: 第4回レビュー指摘への対応（第3回訂正自体の誤り是正）

第3回の「訂正」自体が別の意味で不正確だったことが発覚し、是正:

- **比較対象の取り違えが根本原因**: 第1回は本来見るべき「最終ファイル間 diff の `<` 行」を見ていたが、第3回は**比較対象を「patch単体」にすり替えてしまった**。両者は別物（patchが触れない行でもgt7_tool側の後続コミットで置換されていれば最終diffでは`<`行として現れる）。
- **具体例**: `index.html` の `LAP HISTORY` は共通祖先 `769b299` に元々存在し、docker側patchは触れていないためpatch単体には出ないが、gt7_tool側のDRIVE/ANALYSIS機能で別構造に置換されたため最終ファイル間diffではdocker側のみの行として現れる。つまり**第1回の記述は最終ファイル間diffとしては正しく、第3回がこれを誤って「訂正」していた**。
- **是正** (`docs/refactoring-2026-07-08.md`): 比較対象を冒頭で1行明記（`diff <(docker最終) <(gt7_tool main)` の `<` 行）し、全9ファイルの `<` 行を空行/コメント除外で再抽出して実数と内容を正確に記載。4ファイル（course-map.js・index.html・test-mode.js・websocket.js）に計9行のdocker側のみ行が実在し、いずれもgt7_tool側の後続実装に置換済みであることを確認。結論（復元すべき未反映変更なし）は不变。
- **再発防止**: 以降の同種検証では「何を比較しているか」を1行明記してから進める運用とする。

検証: `pytest tests/ -v` → **12 passed**（4度目の確認・コード変更なし、ドキュメント訂正のみ）。

---

## 2026-07-02 — DRIVE / ANALYSIS ビュー分離（実車テレメトリのドクトリン導入）

### feat: DRIVE ビュー（走行用最小表示、`drive-view.js` 新設）
- **背景**: 従来 UI は全パネル常時表示で「走行中に一瞬で読める情報」が埋もれていた。F1 ステアリングディスプレイ / MoTeC i2 / SimHub 等の実車・実務テレメトリの設計原則（ドライバー表示とエンジニア解析の分離、走行中の常時表示は 7 項目以下、色=状態）を調査し導入。
- **ヘッダーの DRIVE / ANALYSIS トグル** (`#view-mode-btn`): `body.drive-mode` で切替。選択は localStorage に永続化しリロード後も復元。
- **DRIVE モード**（Tier-1/2 のみ、1 カラム構成）:
  - Tier-1: ギア（最大グリフ、`--gear-size` 最大 220px）+ シフトライト拡大 + 速度 + **ギア隣接の大型ライブデルタ**（緑=ゲイン/赤=ロス、距離基準値を `telemetry-analysis.js` から再利用）
  - Tier-2 の `#drive-strip`（6 項目に制限): LAP / LAST / BEST(紫) / EST(PB 予測は紫) / FUEL LAPS（<3 周で赤・<5 周で黄）/ **タイヤ状態 2×2 色ブロック**（数値でなく色で読む: 青=冷 / 緑=適温 / 黄=温 / 赤=過熱）
  - コースマップは位置把握用に中央へ単独配置
  - Tier-3（チャート 4 枚・左右パネル・3D 姿勢・タイヤ詳細）は `display:none` で完全除去（描画コストも削減）
- **ANALYSIS モード**: 従来の全パネル表示（既定・完全後方互換）
- 配線: `websocket.js`（UI スロットルと同周期）と `test-mode.js` に `driveViewOnFrame` を typeof ガードで追加。TEST MODE でも DRIVE ビューを検証可能。
- 検証（Playwright 実ブラウザ）: トグル/レイアウト切替/デルタ・ラップ・燃料・タイヤ色の実データ更新/ANALYSIS 復帰時のチャート再描画/リロード後の永続化、全項目 PASS・コンソールエラー 0。

---

## 2026-07-02 — 距離基準ラップ解析 + UI 全面リデザイン

### feat: 距離基準ラップ解析機構（`telemetry-analysis.js` 新設、794 行）
- gt7dashboard / SimHub / Coach Dave Delta を参考に、距離索引ラップ解析をフロントエンドに実装（バックエンド不変、データバインディング契約 103 ID 保持）。
- **距離索引**: position(x, z) の弦長積算でトラック距離を導出（ワープ除外・速度積分フォールバック）。
- **ライブ・タイムデルタ**: 同一距離地点でのベストラップ通過タイムとの秒差。`#lap-delta` / `#delta-bar-*` を秒差表示に一本化し、`lap-manager.js` の粗い速度デルタは no-op 化して二重書込を排除。
- **推定ラップタイム** (`#est-lap-time`): 走行中の全周外挿 + PB 判定（紫表示）。
- **リファレンス速度重畳**: 距離軸チャート（`#analysis-speed-chart` / `#time-delta-chart`）に現在ラップ + ベストラップを重畳。
- **レースライン着色** (`#course-line-mode-btn`): スロットル緑 / ブレーキ赤 / コースト青 + 速度ピーク▴・バレー▾マーカー。
- **レースエンジニア通知** (`#race-engineer-feed`): 新トップスピード / PB / 燃料 50-20-10% / 残周回 / ファイナルラップ。
- **グリップ状態** (`#grip-status`)・**一貫性σ** (`#consistency-stat`)。
- `websocket.js` の `handleTelemetryMessage` と `test-mode.js` の `renderDemoFrame` に `analysisOnFrame` を配線（ライブ / TEST 両対応）。
- 検証: 契約 103 ID 保持 + 新 8 ID / 全 10 JS 構文 OK / 実描画で全新機能描画・コンソールエラー 0。

### feat: ダッシュボード UI 全面リデザイン（APEX Broadcast）
- モータースポーツ中継グラフィック風の全面刷新。dataviz 検証済みパレットで過飽和ネオンを全廃し、ニュートラルダーク面 + 単一 azure アクセント + 予約 status 色 + 等幅 tabular 数値の一貫したデザインシステム（72 トークン）に。
- `index.html` / `styles.css`: レイアウト再構成（全 ID 保持）。`constants.js` / `charts.js` / `course-map.js` / `ui_components.js` / `car-3d.js` の配色を新パレットへ同期。
- **fix**: `.center-split` の高さ 0 崩壊を修正（3D 姿勢 + コースマップの可視化）。
- **fix**: 存在しない要素 ID（rpm-bar / accel-g / suggested-gear / wheel-rotation / torque / energy-recovery / rot-*）への無ガード参照を全てガードし、毎フレーム例外による表示停止を解消（ライブ / TEST 両方）。
- **feat**: TEST MODE でチャート 4 枚 + 加速度チャート + コースマップも初期化・給餌。
- 検証: 敵対的 3 系統 + 実ブラウザで、契約 103 ID 保持 / パレット CVD・コントラスト合格 / 全パネル描画・コンソールエラー 0。

---

## 2026-06-14 — 改修一回目（コース判定修正・設定一元化・HTTPS）

### fix: コース判定ロジックのシャドウイング解消
- **問題**: `known_courses` の `real_track`(bounds ±10000) が先頭一致で評価され、ほぼ全座標にマッチして confidence 1.0 "Current Track" を返し、自動収集コース 19 件が到達不能（シャドウイング）だった。さらに原点中心の同一 placeholder bounds(±500 等)で複数コースが判別不能、first-match で非決定的だった。
- **修正** (`decoder.py` `CourseEstimator`):
  - (x, z) を内包する全候補を `known`/`auto` 横断で収集し、**bounds 面積が最小=最も具体的**なコースを選択（同面積は `known` 優先）。決定的。
  - `real_track` 等の超広域ボックスは `fallback:true` として分離し、**他に候補が無い時のみ低 confidence(0.2)** で返す。
  - confidence を出自・検証状態・面積から導出（`verified:true`→0.9 / 未検証→0.4–0.7 / fallback→0.2）。
  - 空・キー欠損 bounds は「マッチしない」よう厳格化（旧実装の全マッチ防止）。
  - 戻り値キー(`id`/`name`/`name_en`/`name_ja`/`confidence`)は後方互換維持。`verified`/`source` を追加。
- **データ** (`course_database.json` v1.2.0): 推測 bounds に `verified:false` を明示（**虚偽の精密値は作らない**）。`real_track` に `fallback:true`。実観測座標(x:-6〜90, z:1280〜1395)に整合する `grand_valley` を `verified:true`。
- **テスト** (`test_course_detection.py`): 重複定義を廃し `from decoder import CourseEstimator` に統一。実観測座標・シャドウ解消・最小面積・後方互換など 9 項目を検証（全 PASS）。
- **補足**: `decoder.py` の `parse()` では引き続きコース推定は無効（`course=unknown`）。未検証 bounds で誤コース表示を避けるため。実走テレメトリで bounds を検証後に有効化予定。

### refactor: Crypto を遅延 import 化
- `decoder.py` のトップレベル `from Crypto.Cipher import Salsa20` を `_try_decrypt` 内の遅延 import に変更。`CourseEstimator` が暗号ライブラリ非依存になり、Crypto 未導入環境でも `import decoder` とテストが可能。

### feat: 設定の一元管理（.env）
- `.env.example` を追加（コミット用テンプレート、実 IP はプレースホルダ）。`.env` は `.gitignore` 済み。
- `main.py` `load_config()` を拡張し、`PS5_IP` に加え `SEND_PORT`/`RECEIVE_PORT`/`HTTP_PORT`/`HEARTBEAT_INTERVAL` も環境変数で上書き可能に（`_int_env` ヘルパー、未設定時は `config.json` フォールバック＝後方互換）。

### feat: HTTPS 対応（既存）
- WebSocket/HTTP を SSL 化（`config.json` の `ssl_cert`/`ssl_key`、`ssl/` 配下の証明書）。`https://<host>:8080`、WebSocket は `wss://`。

---

## 2026-06 以前の主な変更

### feat — レーシングダッシュボード強化
- セクタータイム表示、テストモードの大幅強化、ラップ情報・デルタ表示・右パネルの改善、視覚効果とレスポンシブ対応の強化（Phase 2 & 3）。

### 2026-03-12 — refactor
- ANGULAR VELOCITY 3D セクションを CAR ATTITUDE に統合、未使用コード削除、`websocket.js` 末尾の不完全コードを補完。

### 2026-02-14 — feat: 3D 車両モデルリデザイン
- BoxGeometry の直方体からミッドシップスポーツカー風プロファイルへ。Shape + ExtrudeGeometry による車体造形、5 スポーク風ホイール、丸型 4 灯テールライト、リアウイング等。

### 2026-02-13 — feat/fix/refactor
- 全テレメトリフィールド対応（ハートビート `~`、Packet ~ 344 bytes 全フィールド）。
- バグ修正: タイヤ圧(0x94)→路面法線ベクトル、レース順位(0x84)→スタート順位+参加台数。
- バックエンド/フロントエンドのリファクタリング（グローバル変数排除、FuelTracker 導入、index.html 分割）。

### 2026-02-11 — docs
- API ドキュメント・ユーザーガイド追加。実機テスト全項目 PASS。

### 2026-02-09 — feat
- コース推定・マップ表示機能、テストモード、タイヤ詳細表示。

---

> モーション演出の詳細な変更履歴は [CHANGELOG_MOTION_EFFECTS.md](CHANGELOG_MOTION_EFFECTS.md) を参照。
