# バグ修正: グローバル関数の二重定義（読み込み順シャドウ）

> ※ `getSectorClass`（Bug #2）が対象としていたセクタータイム表示機能は、GT7 のテレメトリパケットにセクター情報が含まれないため後日撤去された（README「セクタータイムは非対応」参照）。現行コードに `getSectorClass` は存在しない。本書は読み込み順シャドウという設計上の教訓（Bug #1・#2 共通）の記録として有効。

> **日付**: 2026-07-09
> **ブランチ**: `fix/duplicate-definitions-2026-07-09`（`refactor/dashboard-2026-07-09` から分岐）
> **対象**: 共有グローバルスコープでの同名関数の二重定義 2 件
> **検証**: 構文チェック・純関数ユニットテスト・E2E スモーク・敵対的レビュー3体（全て refuted=false）

---

## 背景

本フロントエンドは全 JS をプレーン `<script>` で読み込み**単一のグローバルスコープ**を共有する。同名のトップレベル関数を複数ファイルで宣言すると、**後に読み込まれたファイルの宣言が先のものを上書き**する（読み込み順: … → `websocket.js` → `test-mode.js` → `app.js`）。2026-07-09 のリファクタリングで潜在バグとして記録した 2 件を本修正で解消した。

---

## Bug #1: `showConnectionError` の二重定義（死コード）

- `ui_components.js` … フローティングトースト（`#connection-error` を動的生成、5秒で自動消去）
- `websocket.js` … `console.error` + ヘッダーのステータスピル（`#connection-status`）更新

`websocket.js` が後読み込みのため**実行中は常に websocket.js 版が有効**で、`ui_components.js` 版は死コードだった（唯一の呼び出し元 `websocket.js:723/725` も websocket.js 版に束縛）。`#connection-error` を参照する箇所は `*.js`/`*.html`/`*.css` に皆無。

**修正**: 死んでいた `ui_components.js` 版を削除。**観測挙動は不変**（有効な websocket.js 版を温存）。

> ℹ️ より目立つトースト通知を使いたい場合は別途 UX 判断で websocket.js 版を差し替える余地がある（本修正の対象外）。

## Bug #2: `getSectorClass` の二重定義（実害あり）

| 定義 | ガード | 閾値 | 用途 |
|------|--------|------|------|
| `websocket.js:452` | `best<=0 → ''` あり | `<0.1 green / <0.3 yellow` | 実テレメトリ（`websocket.js:469/474/479`） |
| `test-mode.js`（旧） | なし | `<0.3 green / <0.6 yellow` | デモ（`test-mode.js:397/402/407`） |

`test-mode.js` が後読み込みのため、その定義が**実テレメトリ側の呼び出しまで上書きシャドウ**していた。結果、実データのセクター色分けが：
1. 意図した閾値（0.1/0.3）ではなく**デモ用の緩い閾値（0.3/0.6）**で判定されていた。
2. ベストセクター未設定時（`best<=0`/`undefined`）にガードが効かず、`diff` が `NaN`/正値となり **`''`（無色）であるべきところ `'red'`** を返していた。

**修正**: `test-mode.js` の重複定義を削除し、両経路をガード付き正準版（`websocket.js`）に一本化。デモの呼び出し元は正準版に解決される（best=20/25/18>0 のためガードは発火せず、例外なし）。

> ℹ️ 副作用: デモのセクター色が緩い閾値（0.3/0.6）から実閾値（0.1/0.3）に変わり、purple/red 中心の表示になる。実挙動への統一であり不具合ではない。

---

## 検証

| 検証 | 結果 |
|------|------|
| `node --check`（ui_components/test-mode/websocket） | ✅ 全通過 |
| 二重定義の解消 | ✅ `getSectorClass`/`showConnectionError` とも定義は websocket.js の 1 箇所のみ |
| ユニットテスト（websocket.js から `getSectorClass` を抽出し評価） | ✅ 8/8（purple/green/yellow/red 各閾値 + `best<=0`/`undefined`/`負値` ガード） |
| E2E スモーク（Playwright headless + TEST MODE） | ✅ セクターが有効な色クラスで着色・未捕捉JS例外0 |
| 敵対的レビュー3体（各Fixの反証 + 他衝突の網羅探索） | ✅ 全て refuted=false。トップレベル関数108個・var/let/const 57個すべて名前一意で**他の衝突なし** |

## まとめ

読み込み順シャドウによる二重定義 2 件を解消。Bug #1 は挙動保存の死コード除去、Bug #2 は**実テレメトリのセクター色分けを正しい閾値・ガードに是正する実バグ修正**。網羅探索により他の同種衝突は存在しないことを確認済み。
