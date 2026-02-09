/**
 * GT7 Telemetry HUD
 * UIコンポーネント
 */


/**
 * ギア表示を更新します
 */
function updateGearDisplay(gear, rpm) {
    const gearElement = document.getElementById('gear');
    const gearRpmElement = document.getElementById('gear-rpm');

    gearElement.innerText = gear === 0 ? 'R' : (gear === 1 ? 'N' : gear - 1);
    gearRpmElement.innerText = Math.round(rpm) + ' RPM';
}


/**
 * スピード表示を更新します
 */
function updateSpeedDisplay(speedKmh) {
    document.getElementById('speed').innerText = formatSpeedKmh(speedKmh);
}


/**
 * RPMバーを更新します
 */
function updateRpmBar(rpm, maxRpm) {
    const rpmBar = document.getElementById('rpm-bar');
    const rpmText = document.getElementById('rpm-text');

    const rpmPct = (rpm / (maxRpm || 9000)) * 100;
    rpmBar.style.width = rpmPct + '%';
    rpmText.innerText = Math.round(rpm) + ' RPM';
}


/**
 * パドルを更新します
 */
function updatePedals(throttlePct, brakePct) {
    document.getElementById('throttle-bar').style.height = (throttlePct || 0) + '%';
    document.getElementById('brake-bar').style.height = (brakePct || 0) + '%';
}


/**
 * ホイール回転メーターを更新します
 */
function updateWheelMeters(wheelRps) {
    const positions = ['fl', 'fr', 'rl', 'rr'];

    positions.forEach((pos, index) => {
        const rps = wheelRps ? wheelRps[index] : null;
        const fill = document.getElementById('wheel-' + pos);
        const value = document.getElementById('wheel-' + pos + '-val');

        if (rps !== undefined) {
            const pct = Math.min((rps / 20) * 100, 100);
            fill.style.opacity = 0.8 * (pct / 100);
            value.innerText = formatWheelRps(rps);
        } else {
            fill.style.opacity = 0;
            value.innerText = '-- rps';
        }
    });
}


/**
 * タイヤデータを更新します
 */
function updateTyreData(position, tyreData) {
    const temp = tyreData.tyre_temp && tyreData.tyre_temp[0];
    const susp = tyreData.susp_height && tyreData.susp_height[0];
    const wheel = tyreData.wheel_rps && tyreData.wheel_rps[0];
    const radius = tyreData.tyre_radius && tyreData.tyre_radius[0];
    const slipRatio = tyreData.slip_ratio && tyreData.slip_ratio[0];
    const loadRatio = tyreData.load_ratio && tyreData.load_ratio[0];
    const brakeTemp = tyreData.brake_temp && tyreData.brake_temp[0];

    // Temperature
    if (temp !== undefined) {
        updateTemperatureDisplay(position, temp);
    }

    // Suspension
    if (susp !== undefined) {
        document.getElementById('tyre-' + position + '-susp').innerText = formatSuspensionHeight(susp);
    }

    // Wheel
    if (wheel !== undefined) {
        document.getElementById('tyre-' + position + '-wheel').innerText = formatWheelRps(wheel);
    }

    // Radius
    if (radius !== undefined) {
        document.getElementById('tyre-' + position + '-radius').innerText = formatTyreRadius(radius);
    }

    // Slip Ratio
    if (slipRatio !== undefined) {
        updateSlipRatioDisplay(position, slipRatio);
    }

    // Load Ratio
    if (loadRatio !== undefined) {
        updateLoadRatioDisplay(position, loadRatio);
    }

    // Brake Temp
    if (brakeTemp !== undefined) {
        updateBrakeTempDisplay(position, brakeTemp);
    }
}


/**
 * 温度表示を更新します
 */
function updateTemperatureDisplay(position, tempCelsius) {
    const tempElement = document.getElementById('tyre-' + position + '-temp');
    const tempBar = document.getElementById('tyre-' + position + '-temp-bar');
    const tempCard = document.getElementById('tyre-' + position);

    tempElement.innerText = formatTemperature(tempCelsius);

    const color, state = getTempColor(tempCelsius);

    const tempPct = Math.min(Math.max((tempCelsius - 20) / 80, 0), 1);

    tempBar.style.width = (tempPct * 100) + '%';
    tempBar.style.backgroundColor = color;
    tempElement.style.color = color;
    tempElement.style.textShadow = `0 0 10px ${color}`;

    tempCard.className = 'tyre-card ' + position + ' ' + state;
}


/**
 * スリップ率表示を更新します
 */
function updateSlipRatioDisplay(position, slipRatio) {
    const slipElement = document.getElementById('tyre-' + position + '-slip');
    const slipBar = document.getElementById('tyre-' + position + '-slip-bar');
    const slipContainer = document.getElementById('tyre-' + position + '-slip-container');

    if (slipContainer) {
        slipContainer.style.display = 'block';
        slipElement.innerText = slipRatio.toFixed(1) + '%';

        const colorClass = getSlipColorClass(slipRatio);

        slipBar.className = 'slip-bar ' + colorClass;
        slipBar.style.width = slipRatio + '%';
    }
}


/**
 * 接地率表示を更新します
 */
function updateLoadRatioDisplay(position, loadRatio) {
    const loadElement = document.getElementById('tyre-' + position + '-load');
    const loadBar = document.getElementById('tyre-' + position + '-load-bar');
    const loadContainer = document.getElementById('tyre-' + position + '-load-container');

    if (loadContainer) {
        loadContainer.style.display = 'block';
        loadElement.innerText = (loadRatio * 100).toFixed(0) + '%';

        const colorClass = getLoadColorClass(loadRatio);

        loadBar.className = 'load-bar ' + colorClass;
        loadBar.style.width = (loadRatio * 100) + '%';
    }
}


/**
 * ブレーキ温度表示を更新します
 */
function updateBrakeTempDisplay(position, brakeTemp) {
    const brakeElement = document.getElementById('tyre-' + position + '-brake');
    if (brakeElement) {
        brakeElement.className = 'tyre-data-item brake-temp';
        const color = getBrakeTempColor(brakeTemp);
        brakeElement.innerHTML = `
            <div class="tyre-data-label">BRAKE</div>
            <div class="tyre-data-value" style="color: ${color}">
                ${Math.round(brakeTemp)}°C
            </div>
        `;
    }
}


// すべてのタイヤデータを更新します
function updateAllTyreData(data) {
    updateTyreData('fl', data, 0);
    updateTyreData('fr', data, 1);
    updateTyreData('rl', data, 2);
    updateTyreData('rr', data, 3);
}
