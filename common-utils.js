/**
 * 共通ユーティリティ(#571)
 *
 * 複数のファイルに同じ形で書かれていた小さな処理を、1か所にまとめたもの。
 * - constants.js の直後に読み込む(以降のどのファイルからも、typeof の確認なしで使える)。
 * - プレーンな <script> は1つのグローバルスコープを共有するため、名前はすべて gt / GT_ で始める。
 * - 状態は持たない。入力だけで結果が決まる処理と、DOM の定型処理だけを置く。
 *
 * ここへ寄せていないもの(挙動が違うため。寄せると結果が変わる):
 * - telemetry-analysis.js / review-view.js / replay-mode.js の距離積算
 *   (一時停止中のフレームを飛ばす・サンプルごとの累積値を作る、など出力が違う)
 * - race-metrics.js の中央値(偶数個のとき、上側の値を採る)
 * - lap-trend.js の σ(母標準偏差)と corner-report.js の σ(標本標準偏差)
 * - track-map.js / channel-plots.js の canvas の準備
 *   (前者は寸法が同じなら作り直さず描画状態を持ち越す。後者は毎回作り直して描画状態を初期化する)
 * - card-groups.js のツールバーボタン(#149 の隔離設計のため、他のファイルに依存させない)
 */

// 1サンプルの移動量がこれを超えたら、瞬間移動(ピット・リスポーン等)とみなして距離に加えない
const GT_PATH_DISCONTINUITY_M = 120;
const GT_RETRY_MAX = 20;            // gtRetryUntil のやり直し回数
const GT_RETRY_INTERVAL_MS = 100;   // gtRetryUntil のやり直し間隔

/**
 * 位置(position_x/position_z)の弦長を積算した走行距離[m]。
 * 位置の無いサンプルは飛ばし、瞬間移動(GT_PATH_DISCONTINUITY_M 超)は加算しない。
 * @param {Array<Object>|null} samples - /api/laps/{file} の samples
 * @returns {number}
 */
function gtPathDistance(samples) {
    let dist = 0;
    let px = null;
    let pz = null;
    (samples || []).forEach(function(s) {
        if (s.position_x == null || s.position_z == null) {
            return;
        }
        if (px !== null) {
            const seg = Math.hypot(s.position_x - px, s.position_z - pz);
            if (seg <= GT_PATH_DISCONTINUITY_M) {
                dist += seg;
            }
        }
        px = s.position_x;
        pz = s.position_z;
    });
    return dist;
}

/** 中央値(偶数個は中央の2値の平均)。空の配列は NaN。渡された配列は並べ替えない。 */
function gtMedian(values) {
    const a = values.slice().sort(function(x, y) { return x - y; });
    const n = a.length;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** localStorage の値(文字列)を読む。無い・読めない(プライベートブラウズ等)ときは null。 */
function gtStorageGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

/**
 * localStorage へ文字列を書く(value が null なら削除)。
 * @returns {boolean} 保存できたか。false でも、その場の動作は続けられる
 */
function gtStorageSet(key, value) {
    try {
        if (value === null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * fn() が true を返すまで、一定間隔でやり直す(最初の1回は、その場で呼ぶ)。
 * menu.js のツールバーなど、DOMContentLoaded で作られる要素を待つために使う。
 */
function gtRetryUntil(fn) {
    if (fn()) {
        return;
    }
    let tries = 0;
    const t = setInterval(function() {
        if (fn() || ++tries > GT_RETRY_MAX) {
            clearInterval(t);
        }
    }, GT_RETRY_INTERVAL_MS);
}

/**
 * ツールバー(#app-toolbar)用のボタンを作る(挿入と、クリック時の処理は呼び出し側)。
 * @param {{id: string, label: string, icon: string, title: (string|undefined)}} o
 * @returns {HTMLButtonElement}
 */
function gtCreateToolbarButton(o) {
    const btn = document.createElement('button');
    btn.id = o.id;
    btn.type = 'button';
    btn.className = 'tb-btn';
    if (o.title) {
        btn.title = o.title;
    }
    btn.setAttribute('aria-label', o.label);
    const ico = document.createElement('span');
    ico.className = 'tb-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = o.icon;
    const label = document.createElement('span');
    label.className = 'tb-label';
    label.textContent = o.label;
    btn.appendChild(ico);
    btn.appendChild(label);
    return btn;
}

/**
 * 表の行の、ホバー・クリック(タップ)・キーボード操作を、強調表示へつなぐ。
 * - ホバー: 固定中でなければ、その行の範囲を強調する。表から出たら解除する。
 * - クリック: 行を固定する。固定中の行をもう一度押すと解除する(タッチ端末ではホバーが無いため)。
 * - Enter / Space: フォーカス中の行を、クリックと同じに扱う。
 * @param {HTMLElement} table
 * @param {{getPinned: function(): number, setPinned: function(number),
 *          rangeOf: function(HTMLElement): Array<number>, highlight: function(number, number),
 *          pinnedClass: string}} o - 固定中の行番号は呼び出し側が持つ(-1 は固定なし)
 */
function gtBindRowHighlight(table, o) {
    table.addEventListener('mouseover', function(ev) {
        const tr = ev.target.closest && ev.target.closest('tbody tr');
        if (tr && o.getPinned() < 0) {
            const r = o.rangeOf(tr);
            o.highlight(r[0], r[1]);
        }
    });
    table.addEventListener('mouseleave', function() {
        if (o.getPinned() < 0) {
            o.highlight(-1, -1);
        }
    });
    table.addEventListener('click', function(ev) {
        const tr = ev.target.closest && ev.target.closest('tbody tr');
        if (!tr) {
            return;
        }
        const rows = Array.prototype.slice.call(tr.parentNode.children);
        const idx = rows.indexOf(tr);
        rows.forEach(function(x) { x.classList.remove(o.pinnedClass); });
        if (o.getPinned() === idx) {
            o.setPinned(-1);
            o.highlight(-1, -1);
        } else {
            o.setPinned(idx);
            const r = o.rangeOf(tr);
            o.highlight(r[0], r[1]);
            tr.classList.add(o.pinnedClass);
        }
    });
    table.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            ev.target.click();
        }
    });
}
