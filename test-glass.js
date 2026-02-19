#!/usr/bin/env node
/**
 * 3Dカーモデルのガラス描画自動検査スクリプト
 *
 * 検査項目:
 * 1. ガラスが水色で見えているか（青ピクセル比率）
 * 2. ルーフが赤のままか（ガラスに浸食されていないか）
 * 3. サイドウインドウがボディからはみ出していないか
 * 4. 暗い下地が目立っていないか
 *
 * Usage: node test-glass.js [http://host:port]
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const TARGET_URL = process.argv[2] || 'http://localhost:18080';
const SCREENSHOT_PATH = path.join(__dirname, 'test-glass-result.png');

// 色判定ヘルパー
function isBlueGlass(r, g, b) {
    return b > 80 && g > 60 && b > r * 1.3 && (g + b) > r * 2.5;
}
function isRedBody(r, g, b) {
    return r > 120 && r > g * 2 && r > b * 2;
}
function isDarkBack(r, g, b) {
    return r < 40 && g < 40 && b < 40;
}
function isBackground(r, g, b) {
    // シーン背景色 0x1a1a2e = (26,26,46)
    return r < 35 && g < 35 && b < 55 && b > g;
}

async function main() {
    console.log('=== ガラス描画 自動検査 ===');
    console.log('URL:', TARGET_URL);

    const browser = await puppeteer.launch({
        executablePath: '/snap/bin/chromium',
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            '--use-angle=swiftshader-webgl',
            '--enable-unsafe-swiftshader'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });

    // コンソールログをキャプチャ
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[PAGE ERROR]', msg.text());
    });
    page.on('pageerror', err => console.log('[PAGE EXCEPTION]', err.message));

    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 15000 });

    // Three.jsとcar-3d.jsがロードされているか確認
    const hasThreeJS = await page.evaluate(() => typeof THREE !== 'undefined');
    const hasInitCar3D = await page.evaluate(() => typeof initCar3D === 'function');
    console.log(`Three.js: ${hasThreeJS ? 'OK' : 'NG'}, initCar3D: ${hasInitCar3D ? 'OK' : 'NG'}`);

    if (!hasThreeJS || !hasInitCar3D) {
        console.error('FAIL: Three.js or car-3d.js not loaded');
        await browser.close();
        process.exit(1);
    }

    // initCar3Dを手動呼び出し（WebSocket接続なしでも3Dを初期化）
    await page.evaluate(() => {
        initCar3D();
    });

    // レンダリング完了待ち
    await new Promise(r => setTimeout(r, 1500));

    // canvas存在確認
    const canvasInfo = await page.evaluate(() => {
        const container = document.getElementById('car-3d-view');
        if (!container) return { error: 'container not found' };
        const canvas = container.querySelector('canvas');
        if (!canvas) return { error: 'canvas not found' };
        return { width: canvas.width, height: canvas.height };
    });

    if (canvasInfo.error) {
        console.error('FAIL:', canvasInfo.error);
        await browser.close();
        process.exit(1);
    }
    console.log(`Canvas: ${canvasInfo.width}x${canvasInfo.height}`);

    // 強制レンダリング + ピクセルデータ取得
    // preserveDrawingBuffer:true なのでreadPixels可能
    const pixelData = await page.evaluate(() => {
        // 強制的にもう一回レンダリング
        if (car3DState.renderer && car3DState.scene && car3DState.camera) {
            car3DState.renderer.render(car3DState.scene, car3DState.camera);
        }

        const container = document.getElementById('car-3d-view');
        const canvas = container.querySelector('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) {
            // WebGL unavailable: fallback to 2D readback via toDataURL
            return null;
        }

        const w = canvas.width;
        const h = canvas.height;
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // WebGLは左下原点なので上下反転
        const flipped = new Uint8Array(w * h * 4);
        for (let row = 0; row < h; row++) {
            const srcOff = row * w * 4;
            const dstOff = (h - 1 - row) * w * 4;
            flipped.set(pixels.subarray(srcOff, srcOff + w * 4), dstOff);
        }

        // 全ゼロチェック（preserveDrawingBufferが効いていない場合）
        let nonZero = 0;
        for (let i = 0; i < flipped.length; i += 400) {
            if (flipped[i] !== 0) { nonZero++; }
        }

        return { width: w, height: h, data: Array.from(flipped), nonZero };
    });

    if (!pixelData || pixelData.nonZero === 0) {
        console.log('WebGL readPixels returned empty, trying canvas toDataURL fallback...');

        // Fallback: canvasのスクリーンショットをelement screenshotで取得
        const canvasEl = await page.$('#car-3d-view canvas');
        if (!canvasEl) {
            console.error('FAIL: canvas element not found for screenshot');
            await browser.close();
            process.exit(1);
        }
        await canvasEl.screenshot({ path: SCREENSHOT_PATH });
        console.log('スクリーンショット保存:', SCREENSHOT_PATH);

        // 2DキャンバスでtoDataURLから読む
        const fallbackData = await page.evaluate(() => {
            const container = document.getElementById('car-3d-view');
            const srcCanvas = container.querySelector('canvas');
            const w = srcCanvas.width;
            const h = srcCanvas.height;

            // WebGLキャンバスのスナップショットを2Dキャンバスにコピー
            const tmpCanvas = document.createElement('canvas');
            tmpCanvas.width = w;
            tmpCanvas.height = h;
            const ctx = tmpCanvas.getContext('2d');
            ctx.drawImage(srcCanvas, 0, 0);
            const imageData = ctx.getImageData(0, 0, w, h);
            return { width: w, height: h, data: Array.from(imageData.data) };
        });

        if (!fallbackData) {
            console.error('FAIL: fallback pixel read also failed');
            await browser.close();
            process.exit(1);
        }

        return analyzeAndReport(fallbackData, page, browser);
    }

    // スクリーンショット保存
    const canvasEl = await page.$('#car-3d-view canvas');
    if (canvasEl) {
        await canvasEl.screenshot({ path: SCREENSHOT_PATH });
    } else {
        await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    }
    console.log('スクリーンショット保存:', SCREENSHOT_PATH);

    return analyzeAndReport(pixelData, page, browser);
}

async function analyzeAndReport(pixelData, page, browser) {
    const { width: W, height: H, data } = pixelData;

    // ピクセル集計
    let totalPixels = W * H;
    let blueCount = 0;
    let redCount = 0;
    let darkCount = 0;
    let bgCount = 0;

    // 領域別解析: 上半分/下半分, 左1/3/中1/3/右1/3
    const regions = {
        topLeft: { blue: 0, red: 0, total: 0 },
        topCenter: { blue: 0, red: 0, total: 0 },
        topRight: { blue: 0, red: 0, total: 0 },
        bottomLeft: { blue: 0, red: 0, total: 0 },
        bottomCenter: { blue: 0, red: 0, total: 0 },
        bottomRight: { blue: 0, red: 0, total: 0 },
    };

    // 車体の左端・右端を特定するためのスキャン
    let carLeftEdge = W;
    let carRightEdge = 0;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];

            const isBg = isBackground(r, g, b);
            if (!isBg) {
                if (x < carLeftEdge) carLeftEdge = x;
                if (x > carRightEdge) carRightEdge = x;
            }

            const isBlue = isBlueGlass(r, g, b);
            const isRed = isRedBody(r, g, b);
            if (isBlue) blueCount++;
            if (isRed) redCount++;
            if (isDarkBack(r, g, b)) darkCount++;
            if (isBg) bgCount++;

            // 領域分類
            const ry = y < H / 2 ? 'top' : 'bottom';
            const rx = x < W / 3 ? 'Left' : x < W * 2 / 3 ? 'Center' : 'Right';
            const region = regions[ry + rx];
            region.total++;
            if (isBlue) region.blue++;
            if (isRed) region.red++;
        }
    }

    const carPixels = totalPixels - bgCount;
    const bluePct = carPixels > 0 ? (blueCount / carPixels * 100).toFixed(1) : 0;
    const redPct = carPixels > 0 ? (redCount / carPixels * 100).toFixed(1) : 0;
    const carWidth = carRightEdge - carLeftEdge;

    console.log('\n--- ピクセル集計 ---');
    console.log(`車体ピクセル: ${carPixels} (背景除外: ${bgCount})`);
    console.log(`水色ガラス: ${blueCount} (${bluePct}%)`);
    console.log(`赤ボディ:   ${redCount} (${redPct}%)`);
    console.log(`暗い面:     ${darkCount}`);
    console.log(`車体X範囲: ${carLeftEdge}~${carRightEdge} (幅${carWidth}px)`);

    console.log('\n--- 領域別 青/赤ピクセル率 ---');
    for (const [name, reg] of Object.entries(regions)) {
        const nonBg = reg.total - Math.round(bgCount * reg.total / totalPixels);
        const pct = nonBg > 0 ? (reg.blue / nonBg * 100).toFixed(1) : '0';
        const redPctR = nonBg > 0 ? (reg.red / nonBg * 100).toFixed(1) : '0';
        console.log(`  ${name.padEnd(14)}: 青=${pct}% 赤=${redPctR}%`);
    }

    // === はみ出し検査: 車体シルエットの外に青ピクセルがあるか ===
    // 行ごとに車体(非背景)の左端右端を特定し、その外側に青があるか
    let blueOutsideSilhouette = 0;
    let blueInsideSilhouette = 0;
    for (let y = 0; y < H; y++) {
        let rowLeft = W;
        let rowRight = 0;
        let rowHasBody = false;

        // まず赤ボディのx範囲を特定（ガラスでなくボディ端を基準）
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (isRedBody(r, g, b) || isDarkBack(r, g, b)) {
                if (x < rowLeft) rowLeft = x;
                if (x > rowRight) rowRight = x;
                rowHasBody = true;
            }
        }

        if (!rowHasBody) continue;

        // この行でボディ範囲外に青ピクセルがあるか
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (isBlueGlass(r, g, b)) {
                // ボディ範囲に余裕3pxをもたせる
                if (x < rowLeft - 3 || x > rowRight + 3) {
                    blueOutsideSilhouette++;
                } else {
                    blueInsideSilhouette++;
                }
            }
        }
    }

    const outsidePct = blueCount > 0 ? (blueOutsideSilhouette / blueCount * 100).toFixed(1) : 0;
    console.log(`\nはみ出し青: ${blueOutsideSilhouette} (青全体の${outsidePct}%)`);

    // === 検査項目 ===
    const results = [];

    // 検査1: ガラスが見えているか（青ピクセルが車体の3%以上）
    const test1 = blueCount > carPixels * 0.03;
    results.push({ name: 'ガラス視認性（青>3%）', pass: test1, detail: `${bluePct}%` });

    // 検査2: ルーフが赤のままか (topCenterで赤>青*2)
    const tc = regions.topCenter;
    const roofRedDominant = tc.red > tc.blue * 2;
    results.push({ name: 'ルーフが赤（上部中央 赤>青*2）', pass: roofRedDominant,
        detail: `赤=${tc.red} 青=${tc.blue}` });

    // 検査3: サイドウインドウがボディシルエットからはみ出していないか
    // はみ出し青が青全体の5%未満
    const test3 = blueOutsideSilhouette < blueCount * 0.05 || blueOutsideSilhouette < 50;
    results.push({ name: 'サイド浮き無し（はみ出し<5%）', pass: test3,
        detail: `${outsidePct}% (${blueOutsideSilhouette}px)` });

    // 検査4: 暗い下地が大きく目立っていないか
    // タイヤ・インテーク・スプリッター等の暗い部品で約19%は正常
    // 異常な暗い下地はみ出しは30%超で検出
    const darkPct = carPixels > 0 ? (darkCount / carPixels * 100) : 0;
    const test4 = darkPct < 30;
    results.push({ name: '暗い面が目立たない（<30%）', pass: test4,
        detail: `${darkPct.toFixed(1)}%` });

    // 結果表示
    console.log('\n=== 検査結果 ===');
    let allPass = true;
    for (const r of results) {
        const mark = r.pass ? 'PASS' : 'FAIL';
        if (!r.pass) allPass = false;
        console.log(`  [${mark}] ${r.name} (${r.detail})`);
    }
    console.log(allPass ? '\n★ 全検査合格' : '\n✗ 不合格あり');

    await browser.close();
    process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
