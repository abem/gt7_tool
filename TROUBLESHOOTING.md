# GT7 Dashboard グラフ表示不具合 - 対応履歴

## 発生内容
ユーザー報告: 「残量計　表示されていない」→「まだない」→「されてない　うえの5つのブロックのところ　何も表示がない」
- 5つのグラフ（SPEED, RPM, THROTTLE, BRAKE, FUEL）が全く表示されない
- グラフエリアに何も表示されない状態

## 環境
- サーバー: Python aiohttp on port 8080
- クライアント: ブラウザ（localhost）
- ライブラリ: uPlot (グラフ描画)

## 対応履歴

### 1. CDNアクセス確認 (2026-02-10 01:05)
**コマンド**: `curl -I https://cdn.jsdelivr.net/npm/uplot@1.6.26/dist/uPlot.min.js`

**結果**: HTTP 404 Not Found
```
HTTP/2 404
date: Mon, 09 Feb 2026 16:05:08 GMT
content-type: text/plain; charset=utf-8
```

**発見**: index.htmlで指定していたuPlot CDN URLが404を返している
```html
<script src="https://cdn.jsdelivr.net/npm/uplot@1.6.26/dist/uPlot.min.js"></script>
```

### 2. uPlotライブラリのローカル配置試行

#### 試行1: GitHubから直接ダウンロード
**コマンド**: `curl -sL "https://github.com/leeoniya/uPlot/raw/1.6.31/dist/uPlot.min.js" -o uplot.min.js`

**結果**: 298KBのファイルがダウンロードされたが、中身はHTMLエラーページ
```html
<!DOCTYPE html>
<html lang="en" data-color-mode="auto"...
```

#### 試行2: raw.githubusercontent.com
**コマンド**: `curl -sL "https://raw.githubusercontent.com/leeoniya/uPlot/master/dist/uPlot.min.js"`

**結果**: 404: Not Found

#### 試行3: unpkg.com
**コマンド**: `curl -sL "https://unpkg.com/uPlot@1.6.31/dist/uPlot.min.js"`

**結果**: "Not found: /uPlot@1.6.31/dist/uPlot.min.js"

#### 試行4: jsdelivr (別パス)
**コマンド**: `curl -sL "https://cdn.jsdelivr.net/npm/uPlot@1.6.31/dist/uPlot.cjs.js"`

**結果**: "Failed to fetch version info for uPlot."

#### 試行5: esm.sh
**コマンド**: `curl -sL "https://esm.sh/uPlot@1.6.32"`

**結果**: "version 1.6.32 of 'uPlot' not found"

#### 試行6: GitHub Releases
**コマンド**: `curl -sL "https://github.com/leeoniya/uPlot/releases/download/v1.6.32/uPlot.min.js"`

**結果**: "Not Found" (9バイトのエラーファイル)

### 3. npm経由でインストール (成功)
**コマンド**: `npm install uplot@1.6.32`

**結果**: 成功
```
added 1 package in 410ms
```

**ファイルコピー**:
```bash
cp node_modules/uplot/dist/uPlot.cjs.js uplot.min.js  # 145KB
cp node_modules/uplot/dist/uPlot.min.css uplot.min.css # 1.8KB
```

**検証**:
```bash
head -c 150 uplot.min.js
/**
* Copyright (c) 2025, Leon Sorokin
* All rights reserved. (MIT Licensed)
*
* uPlot.js (μPlot)
```

### 4. HTMLファイルの修正
**修正前**:
```html
<script src="https://cdn.jsdelivr.net/npm/uplot@1.6.26/dist/uPlot.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/uplot@1.6.26/dist/uPlot.min.css">
```

**修正後**:
```html
<script src="/uplot.min.js"></script>
<link rel="stylesheet" href="/uplot.min.css">
```

### 5. サーバーでの静的ファイル配信確認
**確認コマンド**:
```bash
curl -I http://127.0.0.1:8080/uplot.min.js
# 結果: HTTP/1.1 200 OK, Content-Type: application/javascript

curl -I http://127.0.0.1:8080/uplot.min.css
# 結果: HTTP/1.1 200 OK, Content-Type: text/css
```

**サーバープロセス確認**:
```
root      753488  python main.py  # 実行中
```

### 6. CommonJS版からIIFE版に変更 (2026-02-10 01:10)
**問題**: uPlot.cjs.js は CommonJS 形式で、ブラウザで直接使用するとグローバル `uPlot` 変数が定義されない可能性

**コマンド**: `cp node_modules/uplot/dist/uPlot.iife.min.js uplot.min.js`

**結果**:
- ファイルサイズ: 51KB (minified)
- ファイルヘッダー: `/*! https://github.com/leeoniya/uPlot (v1.6.32) */`
- グローバル定義: `var uPlot=function(){"use strict";...`

### 7. ユーザー報告「でていない」 (2026-02-10 01:11)
強制リロード後もグラフが表示されない

### 8. 現在の状態
- ✅ uplot.min.js (51KB) - IIFE版、グローバルuPlot変数を定義
- ✅ uplot.min.css (1.8KB) - 正しいCSSファイル
- ✅ サーバーが両ファイルをHTTP 200で配信
- ✅ HTMLがローカルファイルを参照
- ❌ ユーザー報告: 「でていない」

## 次のステップ（未実施）

### 1. ブラウザコンソール確認
ユーザーに以下の手順を依頼:
1. F12 で開発者ツールを開く
2. Consoleタブを確認
3. `typeof uPlot` を入力して結果を報告

期待される結果:
- `"function"` または `"object"` → ライブラリは読み込まれている
- `"undefined"` → ライブラリが読み込まれていない

### 2. ネットワークタブ確認
1. F12 → Networkタブ
2. ページをリロード
3. uplot.min.js と uplot.min.css のステータスを確認

期待される結果:
- 200 OK (緑色)
- ファイルサイズが正しい (JS: 145KB, CSS: 1.8KB)

### 3. JavaScriptエラー確認
コンソールにエラーが出ているか確認:
- `uPlot is not defined`
- `Uncaught ReferenceError`
- 404 errors for uplot.min.js or uplot.min.css

### 4. グラフコンテナ要素の確認
```javascript
// ブラウザコンソールで実行
document.querySelectorAll('.chart-container').length  // 5であるべき
document.getElementById('speed-chart')                // nullでないべき
```

### 5. initCharts()関数実行確認
コンソールにエラーが出ていないか確認:
- `initCharts` is not defined
- `Cannot read property 'new' of undefined`

## 考えられる原因

### 原因A: ブラウザキャッシュ
古いHTMLがキャッシュされている

**対策**: 強制リロード (Ctrl+F5 または Cmd+Shift+R)

### 原因B: WebSocket未接続
グラフ初期化は `ws.onopen` 内で呼ばれている
```javascript
ws.onopen = () => {
    initCharts();  // ここで初期化
};
```
WebSocketが接続されていないとグラフが初期化されない

**対策**: GT7からのデータが来ているか確認

### 原因C: JavaScriptエラー
他のスクリプトエラーでinitCharts()が実行されていない

**対策**: コンソールのエラーメッセージを確認

### 原因D: uPlotグローバル変数の問題
uPlot.cjs.jsはCommonJS形式で、グローバルに`uPlot`をエクスポートしない可能性

**対策**: IIFE版を使用するか、HTMLで直接 `<script type="module">` を使用

## ファイル一覧

```
/home/abem/docker/gt7_tool/
├── main.py              # サーバー (ポート8080)
├── index.html           # ダッシュボードHTML
├── uplot-test.html      # uPlot単体テストページ (新規)
├── uplot.min.js         # 51KB (uPlot IIFE版ライブラリ)
├── uplot.min.css        # 1.8KB (uPlotスタイル)
├── decoder.py           # デコーダー
├── telemetry.py         # テレメトリクライアント
├── config.json          # 設定ファイル
├── TROUBLESHOOTING.md   # このドキュメント
├── node_modules/        # npmパッケージ
│   └── uplot/           # インストールされたuPlot v1.6.32
└── package.json         # npm設定
```

### 8. uPlot単体テストページ作成 (2026-02-10 01:12)
**目的**: uPlotライブラリ単体の動作確認

**ファイル**: `uplot-test.html`

**テスト内容**:
1. uPlotが読み込まれているか確認 (`typeof uPlot`)
2. シンプルなグラフを作成
3. 成功/失敗を画面に表示

**アクセスURL**: `http://127.0.0.1:8080/uplot-test.html`

**期待される結果**:
- ✅ "PASS: uPlot is loaded! Creating chart... ✅ Chart created successfully!"
- グリーンの線グラフが表示される

**失敗時の結果**:
- ❌ "FAIL: uPlot is NOT loaded!"

## 更新履歴

| 日時 | 内容 | ステータス |
|------|------|-----------|
| 2026-02-10 01:05 | CDN 404エラー発見 | ❌ |
| 2026-02-10 01:06 | GitHubダウンロード試行（失敗） | ❌ |
| 2026-02-10 01:07 | 各種CDN試行（失敗） | ❌ |
| 2026-02-10 01:07 | npmインストール成功 | ✅ |
| 2026-02-10 01:07 | HTML修正・サー�ーバー配信確認 | ✅ |
| 2026-02-10 01:08 | ユーザー報告「表示されない」 | ❓ |
| 2026-02-10 01:10 | CommonJS版からIIFE版に変更 | ✅ |
| 2026-02-10 01:11 | ユーザー報告「でていない」 | ❌ |
| 2026-02-10 01:12 | uPlot単体テストページ作成 | 検証待 |
| 2026-02-10 01:13 | ユーザー報告「file not found」「consoleエラー」 | ⏸️ 保留 |

### 9. ユーザー報告「file not foundだ」「F12 consoleにえらーでていた」 (2026-02-10 01:13)
- uplot-test.html にアクセスすると "file not found"
- F12コンソールにエラーが表示されていた（詳細未確認）

**調査中**:
- サーバー側のcurlテストではHTML/JS/CSS共に正常配信を確認
- ブラウザ側で何らかのエラーが発生している可能性

**保留理由**: ユーザーより「一旦中止」の要望
