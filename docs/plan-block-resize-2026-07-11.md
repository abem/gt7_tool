# 計画書: ブロックの拡大縮小（リサイズ）機能

日付: 2026-07-11 / 対象ブランチ: feature/menu-redesign-2026-07-11 / ステータス: **実装済み（2026-07-11）** — v2 計画どおり実装、headless 検証8項目合格

> v1 に対する実装前レビュー（fable 2観点、headless 実測付き）で 8件の欠陥が CONFIRMED され、
> §7 の設計変更を反映した。主要な変更: グリップは**ボディ直下の単一オーバーレイ**方式に変更
> （カード内注入はスクロールコンテナと衝突するため）、浮遊中の overflow/min/max 制約の緩和を明記。

## 1. 目的

ドラッグ移動できる全トップレベルブロック（`.card` / `.chart-wrapper` / `.racing-top-bar`、計25個）を、
マウス/タッチ操作で**個別に拡大縮小**できるようにする。見たいペイン（STEER RESPONSE や
CAR ATTITUDE 等）を大きく、使わないカードを小さくして、ユーザーが自分の画面を構成できる。

## 2. 現状調査の結果（実装の土台）

| 機構 | 現状 | リサイズへの含意 |
|------|------|------------------|
| 浮遊化 | `floatCard(c, left, top, width, height)` が既に幅・高さを inline で適用 | サイズ適用経路は**既存** |
| 永続化 | `gt7-card-layout-v1` の各エントリは `{left, top, width, height}` を既に保持（復元時 `s.width \|\| rect.width`） | **スキーマ変更不要**・後方互換 |
| 個別リセット | ダブルクリック → `unfloat()` が `width`/`height` を含む inline スタイルを全解除 | サイズも**自動で**元に戻る |
| 全体リセット | ツールバー ALIGN → 全 unfloat | 同上 |
| uPlot チャート4本 | `setupChartResize()` が各ラッパーを ResizeObserver 監視 → `setSize()`（100ms デバウンス） | ラッパーをリサイズすれば**自動追従** |
| CAR ATTITUDE / STEER RESPONSE | 各自の ResizeObserver + DPR 対応 canvas | **自動追従** |
| スクロール/画面外対策 | `clampTop(top, h)` / 左右クランプが復元・リサイズ時に適用可能 | 高さ変更時に再利用 |

結論: リサイズは「幅・高さを対話的に変更して保存する」部分だけを新設すればよく、
描画追従・永続化・リセットは既存機構がそのまま機能する。

## 3. 設計

### 3.1 操作モデル
- 各トップレベルブロックの**右下にリサイズグリップ**（`.gt7-resize-handle`、18×18px、`cursor: nwse-resize`）を注入。
  ホバー時（および浮遊中）にのみ表示し、通常時は非表示（視覚ノイズを避ける）。
- グリップの pointerdown でリサイズ開始。**グリッド内ブロックはその場の座標・サイズで自動浮遊**
  （ドラッグ開始と同じ規約 — 「触れたら浮く」で一貫）。
- pointermove で幅・高さを更新（`setPointerCapture` 使用、ドラッグ実装と同じ流儀）。
- pointerup で store に `{left, top, width, height}` を保存。
- リサイズ開始時に z-index を最前面へ（ドラッグと同じ `++zTop`）。

### 3.2 クランプ（最小・最大）
| 種別 | 最小幅 | 最小高 | 根拠 |
|------|--------|--------|------|
| `.card` | 140px | 90px | タイトル+1行の可読限界 |
| `.chart-wrapper` | 180px | 110px | uPlot の軸+波形の判読限界 |
| `.racing-top-bar` | 360px | 90px | 速度+ギア+ペダルの最低配置 |

- 最大: 幅 `min(ドキュメント幅−left, 1600px)`、高さ `min(1200px, ページ下端まで)`。
- 高さ変更後に `clampTop` 再適用（スクロール不可レイアウトで画面外に逃げるのを防止 — R1 で修正した既知の罠）。

### 3.3 既存機構との整合
- **ドラッグとの衝突回避**: ドラッグ開始判定 `isInteractive()` にグリップ（`.gt7-resize-handle`）を追加し、
  グリップからはドラッグを開始しない。
- **ダブルクリック**: グリップ上のダブルクリックは無視（リセット誤爆防止）。カード本体のダブルクリックは
  従来どおり個別リセット（位置＋サイズとも復元 — unfloat が既にカバー）。
- **DRIVE モード**: 浮遊ブロックは従来規則どおり（steer-response/racing-bar 以外は非表示）。変更なし。
- **狭幅/スクロール**: 浮遊は `position:absolute`（ドキュメント基準）なので従来のスクロール追従と同一。

### 3.4 触らないもの（非目標）
- フォントサイズの連動スケーリング（内容は現行のまま流し込み。canvas 系は描画が追従する）。
- グリッド内ブロックの「その場リサイズ」（グリッドの再レイアウト連鎖が複雑 — 浮遊してからのリサイズに統一)。
- アスペクト比固定・スナップ・複数選択。
- 保存キーの変更（`gt7-card-layout-v1` を継続。既存保存レイアウトと完全互換）。

## 4. 実装ファイル

| ファイル | 変更 |
|----------|------|
| `card-drag.js` | グリップ注入・リサイズ pointer ハンドラ・クランプ・保存（既存 float/persist 関数を再利用） |
| `styles.css` | `.gt7-resize-handle`（右下グリップ、ホバー表示、APEX トークン準拠の視覚） |
| `docs/USER_GUIDE.md` | 「ブロックの移動」節にリサイズ操作を追記 |
| `menu.js` | ALIGN ボタンのツールチップに「サイズもリセット」の一言（1行） |

## 5. 検証計画（headless + 実測）

1. グリッド内カードのグリップをドラッグ → 浮遊してサイズ変更されること
2. チャートラッパーを拡大 → uPlot の `setSize` 追従（canvas 実寸で確認）
3. CAR ATTITUDE / STEER RESPONSE を拡大 → canvas 再描画（toDataURL 変化＋描画寸法）
4. リロード → 位置・サイズとも復元
5. ダブルクリック → 位置・サイズとも初期化 / ALIGN → 全初期化
6. 最小・最大クランプ（140×90 未満に潰せない・ドキュメント外へ広げられない）
7. リサイズ後の clampTop（狭幅→デスクトップのクロスレイアウト復元で画面外に逃げない）
8. ドラッグとリサイズの相互不干渉（グリップからドラッグが始まらない）
9. 未捕捉 JS エラー 0（全シナリオ）
10. 敵対的レビュー（fable、反証者2名/所見）で CONFIRMED 0 まで修正

## 6. リスクと対策

| リスク | 対策 |
|--------|------|
| uPlot の setSize が高頻度リサイズで重い | 既存の 100ms デバウンスが吸収（追加実装不要を確認済み） |
| 小さくしすぎて操作不能 | 最小クランプ + ダブルクリック/ALIGN の2系統の復帰手段 |
| 古い保存データとの互換 | width/height 欠落エントリは従来どおり自然サイズで復元（既存挙動） |
| グリップがカード内容（ボタン等）と重なる | §7-6 の単一オーバーレイ方式で解消 |

## 7. 実装前レビューの反映（v2 設計変更）— 8件 CONFIRMED、全て実測済み

1. **[high] 縮小時の内容あふれ**（16/25 ブロックがクリップ無し。FUEL 140×90 で 72px はみ出し隣接ブロック上に描画）
   → `.draggable-card.floating { overflow-x: hidden; overflow-y: auto; }` を追加。縮小しても内容へ
   スクロールで到達でき、あふれ描画を物理的に遮断する。
2. **[high] CSS の min/max が inline height に勝つ**（lap-history の max-height:clamp で 500px 指定が 198px に。
   steer-response-view の min-height:180px でカード縮小時に canvas がクリップ）
   → `.draggable-card.floating { max-height: none; min-height: 0; }` と、浮遊中の内部要素の緩和
   `.floating #steer-response-view, .floating #car-3d-view { min-height: 0; }` を追加。
3. **[medium] DISTANCE ANALYSIS の uPlot 2本は高さ固定**（clamp(72px,10vh,110px) — カード拡大で空白、縮小であふれ）
   → `.lap-analysis-card.floating .analysis-chart { flex: 1 1 0; min-height: 0; height: auto; }` を追加
   （RO=setupAnalysisChartResize は既存のため setSize は自動）。
4. **[medium] racing-top-bar の最小幅 360px は不成立**（min-content 実測 666px、360px ではペダル列全滅）
   → 最小幅を **670px** に改訂。最小高も min-height:112px と整合させ **112px** に改訂。
5. **[medium] 復元時に width/height がクランプされない**（広い画面で保存→狭い画面でグリップが画面外・到達不能）
   → restoreSaved と window resize 時に `w = clamp(w, minW, pageW()−left)`・
   `h = clamp(h, minH, スクロール不可なら innerHeight 基準)` を適用（clampTop と同じ分岐を流用）。
6. **[medium] カード内グリップはスクロールバー/スクロール内容と衝突**（tyres-card 実測、かつ §7-1 で
   全浮遊カードがスクロール可能になるため衝突は全カードに波及。position:static な .chart-wrapper では
   アンカーも不成立）
   → **方式変更**: グリップはカード内に注入せず、**body 直下の単一オーバーレイ要素**
   （`#gt7-resize-grip`、20×20px、ドキュメント座標）をホバー中ブロックの右下外縁に重ねて表示する。
   スクロールと無縁・positioning context 不要・DOM 注入も1個で済む。浮遊中のブロックには
   ホバー無しでも表示（タッチでの発見可能性）。
7. **[low] グリップの dblclick はリセットに化けない**よう stopPropagation。リサイズ中は
   `user-select: none` と `touch-action: none`（ドラッグ実装と同じ流儀）。
8. **検証計画の強化**: §5 の項目6を「指定値と実測 rect の一致 + あふれ描画ゼロ」に、項目8に
   「tyres-card のスクロールバー操作がリサイズに奪われない」を追加。
