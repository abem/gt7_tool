/**
 * GT7 Telemetry Dashboard
 * コースマップCanvas描画
 *
 * 依存: ui_components.js (courseMapState, COURSE_MAP_CONFIG, getSpeedColor, debugLog)
 */

function initCourseMap() {
    if (courseMapState.domReady) return;
    var canvas = document.getElementById('course-map');
    if (!canvas) {
        console.error('[COURSE_MAP] Canvas element not found');
        return;
    }

    var container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    courseMapState.canvas = canvas;
    courseMapState.ctx = canvas.getContext('2d');

    var resizeObserver = new ResizeObserver(function() {
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
        var padding = 20;
        courseMapState.bounds.minX = Math.min(courseMapState.bounds.minX, x - padding);
        courseMapState.bounds.maxX = Math.max(courseMapState.bounds.maxX, x + padding);
        courseMapState.bounds.minZ = Math.min(courseMapState.bounds.minZ, z - padding);
        courseMapState.bounds.maxZ = Math.max(courseMapState.bounds.maxZ, z + padding);
    }
}

function gameToCanvas(x, z) {
    var bounds = courseMapState.bounds;
    var canvas = courseMapState.canvas;
    if (!canvas) return { x: 0, y: 0 };

    var rangeX = bounds.maxX - bounds.minX || 1;
    var rangeZ = bounds.maxZ - bounds.minZ || 1;

    var padding = 30;
    var availableWidth = canvas.width - 2 * padding;
    var availableHeight = canvas.height - 2 * padding;

    var scaleX = availableWidth / rangeX;
    var scaleZ = availableHeight / rangeZ;
    var scale = Math.min(scaleX, scaleZ);

    var offsetX = padding + (availableWidth - rangeX * scale) / 2;
    var offsetY = padding + (availableHeight - rangeZ * scale) / 2;

    return {
        x: offsetX + (x - bounds.minX) * scale,
        y: offsetY + (z - bounds.minZ) * scale
    };
}

function drawCourseMap() {
    var ctx = courseMapState.ctx;
    var canvas = courseMapState.canvas;
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // グリッド
    ctx.strokeStyle = COURSE_MAP_CONFIG.colors.grid;
    ctx.lineWidth = 1;
    var gridSize = 50;
    for (var x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (var y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }

    if (!courseMapState.initialized) {
        ctx.fillStyle = COURSE_MAP_CONFIG.colors.text;
        ctx.font = '12px "Segoe UI Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for position data...', canvas.width / 2, canvas.height / 2);
        return;
    }

    // 軌跡
    if (courseMapState.trajectory.length > 1) {
        for (var i = 1; i < courseMapState.trajectory.length; i++) {
            var prev = courseMapState.trajectory[i - 1];
            var curr = courseMapState.trajectory[i];
            var prevCanvas = gameToCanvas(prev.x, prev.z);
            var currCanvas = gameToCanvas(curr.x, curr.z);

            ctx.beginPath();
            ctx.moveTo(prevCanvas.x, prevCanvas.y);
            ctx.lineTo(currCanvas.x, currCanvas.y);
            ctx.strokeStyle = getSpeedColor(curr.speed);
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

    // 車両位置
    var carPos = gameToCanvas(
        courseMapState.currentPosition.x,
        courseMapState.currentPosition.z
    );

    // グロー効果
    var gradient = ctx.createRadialGradient(carPos.x, carPos.y, 0, carPos.x, carPos.y, 15);
    gradient.addColorStop(0, 'rgba(0, 255, 136, 0.5)');
    gradient.addColorStop(1, 'rgba(0, 255, 136, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(carPos.x, carPos.y, 15, 0, Math.PI * 2);
    ctx.fill();

    // 車両マーカー
    ctx.fillStyle = COURSE_MAP_CONFIG.colors.car;
    ctx.beginPath();
    ctx.arc(carPos.x, carPos.y, 6, 0, Math.PI * 2);
    ctx.fill();

    // 情報表示
    var infoEl = courseMapState.infoEl;
    if (infoEl) {
        var rangeX = (courseMapState.bounds.maxX - courseMapState.bounds.minX).toFixed(0);
        var rangeZ = (courseMapState.bounds.maxZ - courseMapState.bounds.minZ).toFixed(0);
        infoEl.textContent =
            'X: ' + courseMapState.currentPosition.x.toFixed(1) +
            ' Z: ' + courseMapState.currentPosition.z.toFixed(1) +
            ' | Range: ' + rangeX + 'm x ' + rangeZ + 'm';
    }
}

function updateCourseMap(positionX, positionY, positionZ, speed) {
    courseMapState.currentPosition = { x: positionX, y: positionY, z: positionZ };
    updateCourseMapBounds(positionX, positionZ);

    courseMapState.sampleCount++;
    if (courseMapState.sampleCount % COURSE_MAP_CONFIG.trajectorySampleInterval === 0) {
        courseMapState.trajectory.push({
            x: positionX,
            z: positionZ,
            speed: speed,
            timestamp: Date.now()
        });

        if (courseMapState.trajectory.length > COURSE_MAP_CONFIG.maxTrajectoryPoints) {
            courseMapState.trajectory.shift();
        }
    }

    drawCourseMap();
}
