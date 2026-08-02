/**
 * GT7 バーチャルピットウォール - ドライバー側受信処理(#434 P4)
 *
 * エンジニア役端末(engineer.html/engineer.js)から送られた
 * {"type":"engineer_message", "text":..., "severity":...} を受け取り、
 * 既存の通知トースト(pushNotification、telemetry-analysis.js #race-engineer-feed)
 * へ表示し、ブラウザ標準のSpeechSynthesis Web APIで読み上げる。
 *
 * @depends telemetry-analysis.js (pushNotification)
 * @depends websocket.js (typeof guard付きで呼ばれる。websocket.js自体は無改変)
 */

/**
 * エンジニアメッセージを受け取り、通知表示+音声読み上げを行う。
 * @param {Object} data - {"type":"engineer_message","text":string,"severity":string}
 */
function handleEngineerMessage(data) {
    const text = typeof data.text === 'string' ? data.text : '';
    if (!text) {
        return;
    }
    const severity = data.severity || 'notice';

    if (typeof pushNotification === 'function') {
        pushNotification('ENGINEER', text, severity);
    }

    speakEngineerMessage(text);
}

/**
 * SpeechSynthesis Web APIでテキストを読み上げる(新規外部依存なし)。
 * 未対応ブラウザではtypeofガードにより無音でスキップする。
 * @param {string} text
 */
function speakEngineerMessage(text) {
    if (typeof window.speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
        return;
    }
    try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';  // FUEL MAP 3等の英字コールアウトを想定した既定言語
        window.speechSynthesis.speak(utterance);
    } catch (e) {
        console.error('speakEngineerMessage failed:', e);
    }
}
