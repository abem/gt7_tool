/**
 * GT7 Telemetry HUD
 * UIコンポーネント
 */

// フォーマット関数
function formatSpeedKmh(speedKmh) {
    return speedKmh ? Math.round(speedKmh).toString() : '0';
}

function formatWheelRps(rps) {
    return rps ? rps.toFixed(2) + ' rps' : '-- rps';
}

function formatTemperature(tempCelsius) {
    return tempCelsius ? tempCelsius.toFixed(1) + '°C' : '--°C';
}

function formatSuspensionHeight(suspHeight) {
    return suspHeight ? (suspHeight * 1000).toFixed(1) + 'mm' : '--mm';
}

function formatTyreRadius(radius) {
    return radius ? radius.toFixed(3) + 'm' : '--m';
}

// 色関数
function getTempColor(tempCelsius) {
    if (tempCelsius < 40) {
        return { color: '#44ffff', state: 'cold' };
    } else if (tempCelsius < 80) {
        return { color: '#00ff88', state: 'optimal' };
    } else {
        return { color: '#ff4444', state: 'hot' };
    }
}

function getSlipColorClass(slipRatio) {
    if (slipRatio > 50) {
        return 'slip-danger';
    } else if (slipRatio > 20) {
        return 'slip-warn';
    }
    return 'slip-good';
}

function getLoadColorClass(loadRatio) {
    if (loadRatio < 0.2) {
        return 'load-void';
    } else if (loadRatio < 0.5) {
        return 'load-low';
    }
    return 'load-ideal';
}

function getBrakeTempColor(brakeTemp) {
    return brakeTemp > 400 ? '#ff4444' : '#ffaa00';
}

// 色の修正
function updateTemperatureDisplay(position, tempCelsius) {
    const tempElement = document.getElementById('tyre-' + position + '-temp');
    const tempBar = document.getElementById('tyre-' + position + '-temp-bar');
    const tempCard = document.getElementById('tyre-' + position);

    tempElement.innerText = formatTemperature(tempCelsius);

    const tempInfo = getTempColor(tempCelsius);
    const tempPct = Math.min(Math.max((tempCelsius - 20) / 80, 0), 1);

    tempBar.style.width = (tempPct * 100) + '%';
    tempBar.style.backgroundColor = tempInfo.color;
    tempElement.style.color = tempInfo.color;
    tempElement.style.textShadow = `0 0 10px ${tempInfo.color}`;

    tempCard.className = 'tyre-card ' + position + ' ' + tempInfo.state;
}

// 元の関数を上書き
function updateTemperatureDisplay_Original(position, tempCelsius) {
    updateTemperatureDisplay(position, tempCelsius);
}



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
function updateTyreData(position, tyreData, index) {
    const temp = tyreData.tyre_temp && tyreData.tyre_temp[index];
    const susp = tyreData.susp_height && tyreData.susp_height[index];
    const wheel = tyreData.wheel_rps && tyreData.wheel_rps[index];
    const radius = tyreData.tyre_radius && tyreData.tyre_radius[index];
    const slipRatio = tyreData.slip_ratio && tyreData.slip_ratio[index];
    const loadRatio = tyreData.load_ratio && tyreData.load_ratio[index];
    const brakeTemp = tyreData.brake_temp && tyreData.brake_temp[index];

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
