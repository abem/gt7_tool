/**
 * GT7 Telemetry Dashboard
 * コースマップCanvas描画
 *
 * 依存: ui_components.js (courseMapState, COURSE_MAP_CONFIG, getSpeedColor, debugLog)
 */

/**
 * CSS カスタムプロパティ値を取得（デザイントークン再利用・発光禁止の趣旨に沿う）
 * @param {string} name - --token 名
 * @param {string} fallback - 取得失敗時の即値
 * @returns {string} 色文字列
 */
function getCSSVar(name, fallback) {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch (e) {
        return fallback;
    }
}

function initCourseMap() {
    if (courseMapState.domReady) return;
    const canvas = document.getElementById('course-map');
    if (!canvas) {
        console.error('[COURSE_MAP] Canvas element not found');
        return;
    }

    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    courseMapState.canvas = canvas;
    courseMapState.ctx = canvas.getContext('2d');

    const resizeObserver = new ResizeObserver(function() {
        if (canvas && container) {
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight;
        }
    });
    resizeObserver.observe(container);

    courseMapState.domReady = true;
    courseMapState.infoEl = document.getElementById('course-map-info');

    debugLog('COURSE_MAP', 'Initialized', { width: canvas.width, height: canvas.height });
}

function updateCourseMapBounds(x, z) {
    if (!courseMapState.initialized) {
        courseMapState.bounds = {
            minX: x - 50, maxX: x + 50,
            minZ: z - 50, maxZ: z + 50
        };
        courseMapState.initialized = true;
    } else {
        const padding = 20;
        courseMapState.bounds.minX = Math.min(courseMapState.bounds.minX, x - padding);
        courseMapState.bounds.maxX = Math.max(courseMapState.bounds.maxX, x + padding);
        courseMapState.bounds.minZ = Math.min(courseMapState.bounds.minZ, z - padding);
        courseMapState.bounds.maxZ = Math.max(courseMapState.bounds.maxZ, z + padding);
    }
}

function gameToCanvas(x, z) {
    const bounds = courseMapState.bounds;
    const canvas = courseMapState.canvas;
    if (!canvas) return { x: 0, y: 0 };

    const rangeX = bounds.maxX - bounds.minX || 1;
    const rangeZ = bounds.maxZ - bounds.minZ || 1;

    const padding = 30;
    const availableWidth = canvas.width - 2 * padding;
    const availableHeight = canvas.height - 2 * padding;

    const scaleX = availableWidth / rangeX;
    const scaleZ = availableHeight / rangeZ;
    const scale = Math.min(scaleX, scaleZ);

    const offsetX = padding + (availableWidth - rangeX * scale) / 2;
    const offsetY = padding + (availableHeight - rangeZ * scale) / 2;

    return {
        x: offsetX + (x - bounds.minX) * scale,
        y: offsetY + (z - bounds.minZ) * scale
    };
}

function drawCourseMap() {
    const ctx = courseMapState.ctx;
    const canvas = courseMapState.canvas;
    if (!ctx || !canvas) return;

    const MAP_FONT = '12px "Segoe UI Mono", monospace';

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // グリッド
    ctx.strokeStyle = COURSE_MAP_CONFIG.colors.grid;
    ctx.lineWidth = 1;
    const gridSize = 50;
    for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }

    if (!courseMapState.initialized) {
        ctx.fillStyle = COURSE_MAP_CONFIG.colors.text;
        ctx.font = MAP_FONT;
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for position data...', canvas.width / 2, canvas.height / 2);
        return;
    }

    // 着色モード（'speed' = 速度3段階 / 'line' = 入力ゾーン）。
    // analysisState は telemetry-analysis.js 所有。未ロード時は速度着色にフォールバック。
    const lineMode = (typeof analysisState !== 'undefined' && analysisState)
        ? analysisState.lineMode : 'speed';

    // 軌跡
    if (courseMapState.trajectory.length > 1) {
        for (let i = 1; i < courseMapState.trajectory.length; i++) {
            const prev = courseMapState.trajectory[i - 1];
            const curr = courseMapState.trajectory[i];
            const prevCanvas = gameToCanvas(prev.x, prev.z);
            const currCanvas = gameToCanvas(curr.x, curr.z);

            ctx.beginPath();
            ctx.moveTo(prevCanvas.x, prevCanvas.y);
            ctx.lineTo(currCanvas.x, currCanvas.y);
            if (lineMode === 'line') {
                // 入力ゾーン着色: スロットル=緑 / ブレーキ=赤 / コースト=青
                const zone = (typeof classifyZone === 'function')
                    ? classifyZone(curr.throttle, curr.brake)
                    : (curr.brake > 5 && curr.brake >= curr.throttle ? 'brake'
                        : curr.throttle > 5 ? 'throttle' : 'coast');
                ctx.strokeStyle = zone === 'brake' ? getCSSVar('--series-brake', '#D84B4F')
                    : zone === 'throttle' ? getCSSVar('--series-throttle', '#1F9E57')
                    : getCSSVar('--accent-brand', '#3D9BFF');   // coast
            } else {
                ctx.strokeStyle = getSpeedColor(curr.speed);   // 既存の速度3段階（デフォルト維持）
            }
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

    // 速度ピーク(▴ 直線/トップスピード)/バレー(▾ コーナー頂点)マーカー
    // LINE モードかつリファレンスラップ確定時のみ。未確定/サンプル過少では空配列でマークなし。
    const refLap = (typeof analysisState !== 'undefined' && analysisState)
        ? analysisState.refLap : null;
    if (lineMode === 'line' && refLap) {
        ctx.font = MAP_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        (refLap.peaks || []).forEach(function(p) {
            const c = gameToCanvas(p.x, p.z);
            ctx.fillStyle = getCSSVar('--course-fast', '#8CC6FF');
            ctx.fillText('▴', c.x, c.y - 8);
        });
        (refLap.valleys || []).forEach(function(v) {
            const c = gameToCanvas(v.x, v.z);
            ctx.fillStyle = getCSSVar('--warning', '#FAB219');
            ctx.fillText('▾', c.x, c.y - 8);
        });
    }

    // 車両位置
    const carPos = gameToCanvas(
        courseMapState.currentPosition.x,
        courseMapState.currentPosition.z
    );

    // グロー効果（自車=live要素の抑制ハロ, --accent-brand azure）
    const GLOW_RADIUS = 15;
    const gradient = ctx.createRadialGradient(carPos.x, carPos.y, 0, carPos.x, carPos.y, GLOW_RADIUS);
    gradient.addColorStop(0, 'rgba(61, 155, 255, 0.25)');
    gradient.addColorStop(1, 'rgba(61, 155, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(carPos.x, carPos.y, GLOW_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // 車両マーカー（向きを考慮した矢印）
    const heading = courseMapState.currentPosition.heading || 0;
    ctx.save();
    ctx.translate(carPos.x, carPos.y);
    ctx.rotate(-heading); // キャンバス座標系に合わせて反転
    
    // 矢印形状
    ctx.beginPath();
    ctx.moveTo(0, -8);  // 先端
    ctx.lineTo(5, 6);   // 右後ろ
    ctx.lineTo(0, 3);   // 中心後ろ
    ctx.lineTo(-5, 6);  // 左後ろ
    ctx.closePath();
    
    ctx.fillStyle = COURSE_MAP_CONFIG.colors.car;
    ctx.fill();
    ctx.strokeStyle = '#3D9BFF';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    ctx.restore();

    // 情報表示
    const infoEl = courseMapState.infoEl;
    if (infoEl) {
        const rangeX = (courseMapState.bounds.maxX - courseMapState.bounds.minX).toFixed(0);
        const rangeZ = (courseMapState.bounds.maxZ - courseMapState.bounds.minZ).toFixed(0);
        infoEl.textContent =
            'X: ' + courseMapState.currentPosition.x.toFixed(1) +
            ' Z: ' + courseMapState.currentPosition.z.toFixed(1) +
            ' | Range: ' + rangeX + 'm x ' + rangeZ + 'm';
    }
}

function updateCourseMap(positionX, positionY, positionZ, speed, heading, throttle, brake) {
    courseMapState.currentPosition = {
        x: positionX,
        y: positionY,
        z: positionZ,
        heading: heading || 0
    };
    updateCourseMapBounds(positionX, positionZ);

    courseMapState.sampleCount++;
    if (courseMapState.sampleCount % COURSE_MAP_CONFIG.trajectorySampleInterval === 0) {
        courseMapState.trajectory.push({
            x: positionX,
            z: positionZ,
            speed: speed,
            throttle: throttle || 0,
            brake: brake || 0,
            timestamp: Date.now()
        });

        if (courseMapState.trajectory.length > COURSE_MAP_CONFIG.maxTrajectoryPoints) {
            courseMapState.trajectory.shift();
        }
    }

    drawCourseMap();
}
