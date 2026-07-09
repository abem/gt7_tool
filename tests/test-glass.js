#!/usr/bin/env node
/**
 * CAR ATTITUDE (Canvas2D) スモークテスト
 *
 * 旧 WebGL/Three.js 版のガラス描画ピクセル検査を置き換えるもの。GL を一切使わない 2D 姿勢図が
 * 実際に初期化され、キャンバスに中身が描かれることを確認する（青ガラス/赤ルーフ等の概念は廃止）。
 *
 * 検査項目:
 *  1. initCar3D が関数として存在する（THREE への依存が無い）
 *  2. initCar3D() 後に car3DState.initialized === true
 *  3. #car-3d-view に <canvas> が生成され、サイズが正
 *  4. キャンバスに非透明ピクセルがある（＝実際に描画されている）
 *  5. ページ例外が発生していない
 *
 * Usage: node test-glass.js [http://host:port]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const TARGET_URL = process.argv[2] || 'http://localhost:18080';
const SCREENSHOT_PATH = path.join(__dirname, 'test-attitude-result.png');
const CHROMIUM_ENV_VARS = ['CHROMIUM_PATH', 'PUPPETEER_EXECUTABLE_PATH'];
const DEFAULT_CHROMIUM_PATHS = [
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
];

function resolveChromiumPath() {
    for (const envVar of CHROMIUM_ENV_VARS) {
        const candidate = process.env[envVar];
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    for (const candidate of DEFAULT_CHROMIUM_PATHS) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
    console.log('=== CAR ATTITUDE (2D) スモークテスト ===');
    console.log('URL:', TARGET_URL);

    const executablePath = resolveChromiumPath();
    if (!executablePath) {
        console.error('FAIL: Chromium executable not found.');
        console.error('Set CHROMIUM_PATH or PUPPETEER_EXECUTABLE_PATH, or install chromium.');
        process.exit(1);
    }

    // 2D 図は WebGL を必要としないので、標準フラグのみで起動する
    const browser = await puppeteer.launch({
        executablePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });

    const pageErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') console.log('[PAGE ERROR]', msg.text()); });
    page.on('pageerror', err => { pageErrors.push(err.message); console.log('[PAGE EXCEPTION]', err.message); });

    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 15000 });

    // 依存確認: initCar3D があること / THREE への依存が無いこと
    const hasInitCar3D = await page.evaluate(() => typeof initCar3D === 'function');
    const threePresent = await page.evaluate(() => typeof THREE !== 'undefined');
    console.log(`initCar3D: ${hasInitCar3D ? 'OK' : 'NG'}, THREE依存: ${threePresent ? 'あり(想定外)' : 'なし(OK)'}`);
    if (!hasInitCar3D) {
        console.error('FAIL: car-3d.js (initCar3D) not loaded');
        await browser.close();
        process.exit(1);
    }

    // 初期化 + 適当な姿勢を流し込んで描画させる
    await page.evaluate(() => {
        initCar3D();
        if (typeof updateCar3D === 'function') {
            // pitch, yaw, roll, rpm, steering, susp[FL,FR,RL,RR]
            updateCar3D(0.18, 0.35, -0.12, 0, 0.2, [55, 40, 48, 60]);
        }
    });
    await sleep(1200);

    const info = await page.evaluate(() => {
        const container = document.getElementById('car-3d-view');
        if (!container) return { error: 'container #car-3d-view not found' };
        const canvas = container.querySelector('canvas');
        if (!canvas) return { error: 'canvas not found' };
        const inited = (typeof car3DState !== 'undefined') && car3DState.initialized === true;
        // 非透明ピクセル数をサンプリングして、実際に描画されているか確認
        let nonEmpty = -1;
        try {
            const w = canvas.width, h = canvas.height;
            const tmp = document.createElement('canvas');
            tmp.width = w; tmp.height = h;
            const tctx = tmp.getContext('2d');
            tctx.drawImage(canvas, 0, 0);
            const data = tctx.getImageData(0, 0, w, h).data;
            let painted = 0;
            for (let i = 3; i < data.length; i += 4 * 50) { if (data[i] > 10) painted++; }
            nonEmpty = painted;
        } catch (e) {
            return { error: 'getImageData failed: ' + e.message, width: canvas.width, height: canvas.height, inited };
        }
        return { width: canvas.width, height: canvas.height, inited, nonEmpty };
    });

    if (info.error) {
        console.error('FAIL:', info.error);
        await browser.close();
        process.exit(1);
    }
    console.log(`Canvas: ${info.width}x${info.height}, initialized: ${info.inited}, 描画ピクセル(サンプル): ${info.nonEmpty}`);

    const canvasEl = await page.$('#car-3d-view canvas');
    if (canvasEl) {
        await canvasEl.screenshot({ path: SCREENSHOT_PATH });
        console.log('スクリーンショット保存:', SCREENSHOT_PATH);
    }

    // === 判定 ===
    const checks = [
        { name: 'THREE 非依存', pass: !threePresent },
        { name: 'car3DState.initialized', pass: info.inited === true },
        { name: 'canvas サイズ > 0', pass: info.width > 0 && info.height > 0 },
        { name: 'キャンバスに描画あり', pass: info.nonEmpty > 0 },
        { name: 'ページ例外なし', pass: pageErrors.length === 0 }
    ];
    console.log('\n=== 検査結果 ===');
    let allPass = true;
    for (const c of checks) {
        const mark = c.pass ? 'PASS' : 'FAIL';
        if (!c.pass) allPass = false;
        console.log(`  [${mark}] ${c.name}`);
    }
    console.log(allPass ? '\n★ 全検査合格' : '\n✗ 不合格あり');

    await browser.close();
    process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
