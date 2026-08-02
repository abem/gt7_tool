/**
 * GT7 バーチャルピットウォール - エンジニア役端末(#434 P4)
 *
 * 別端末から /ws へ接続し、{"type":"engineer_message", "text":..., "severity":...}
 * をドライバー側クライアントへ送信する専用の軽量ページ。
 * メインダッシュボード(index.html/websocket.js)とは独立したファイルであり、
 * テレメトリ受信・解析は一切行わない(送信専用)。
 */

const engineerState = {
    ws: null,
    reconnectDelay: 1000,
    reconnectTimer: null,
};

function engineerSetStatus(text, cls) {
    const el = document.getElementById('connection-status');
    if (el) {
        el.textContent = text;
        el.className = cls;
    }
}

function engineerLog(text, failed) {
    const list = document.getElementById('engineer-log');
    if (!list) {
        return;
    }
    const li = document.createElement('li');
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    li.textContent = `[${ts}] ${text}`;
    if (failed) {
        li.classList.add('failed');
    }
    list.prepend(li);
    while (list.children.length > 20) {
        list.removeChild(list.lastChild);
    }
}

function engineerSetControlsEnabled(enabled) {
    document.querySelectorAll('.engineer-preset-btn').forEach(function(btn) {
        btn.disabled = !enabled;
    });
    const sendBtn = document.getElementById('engineer-send-btn');
    if (sendBtn) {
        sendBtn.disabled = !enabled;
    }
}

function engineerSendMessage(text, severity) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
        return;
    }
    if (!engineerState.ws || engineerState.ws.readyState !== WebSocket.OPEN) {
        engineerLog(`送信失敗(未接続): ${trimmed}`, true);
        return;
    }
    engineerState.ws.send(JSON.stringify({
        type: 'engineer_message',
        text: trimmed,
        severity: severity || 'notice',
    }));
    engineerLog(trimmed, false);
}

function engineerConnect() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = wsProtocol + '//' + window.location.host + '/ws';
    engineerState.ws = new WebSocket(wsUrl);

    engineerState.ws.onopen = function() {
        engineerSetStatus('Connected', 'connected');
        engineerSetControlsEnabled(true);
        engineerState.reconnectDelay = 1000;
    };

    engineerState.ws.onclose = function() {
        engineerSetStatus('Disconnected', 'disconnected');
        engineerSetControlsEnabled(false);
        scheduleEngineerReconnect();
    };

    engineerState.ws.onerror = function() {
        engineerSetStatus('Error', 'error');
    };

    // 受信メッセージ(テレメトリ・他エンジニア端末からの送信echo等)は本ページでは処理不要
    engineerState.ws.onmessage = function() {};
}

function scheduleEngineerReconnect() {
    if (engineerState.reconnectTimer) {
        return;
    }
    engineerState.reconnectTimer = setTimeout(function() {
        engineerState.reconnectTimer = null;
        engineerConnect();
    }, engineerState.reconnectDelay);
    engineerState.reconnectDelay = Math.min(engineerState.reconnectDelay * 2, 10000);
}

function initEngineerPage() {
    engineerSetControlsEnabled(false);

    document.querySelectorAll('.engineer-preset-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            engineerSendMessage(btn.dataset.text, 'notice');
        });
    });

    const input = document.getElementById('engineer-text-input');
    const sendBtn = document.getElementById('engineer-send-btn');
    if (sendBtn && input) {
        sendBtn.addEventListener('click', function() {
            engineerSendMessage(input.value, 'notice');
            input.value = '';
        });
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                engineerSendMessage(input.value, 'notice');
                input.value = '';
            }
        });
    }

    engineerConnect();
}

document.addEventListener('DOMContentLoaded', initEngineerPage);
