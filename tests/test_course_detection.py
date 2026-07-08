#!/usr/bin/env python3
"""
コース検出機能のテストスクリプト

decoder.CourseEstimator を直接 import し、推定ロジック本体を検証します。
独自の重複 CourseEstimator は廃止しました(本体との挙動乖離を防ぐため)。

実行方法:
  python3 test_course_detection.py
      -> run_assertions() を実行し、PASS/FAIL を表示(gt7data 不要)。
  python3 test_course_detection.py --regenerate
      -> gt7data を解析して course_database.json を再生成(破壊的・明示時のみ)。

pytest が導入されている場合は test_* 関数が自動収集されます。
"""

import json
import os

# decoder.CourseEstimator を import。decoder は Crypto を遅延 import するため
# 本環境(Crypto 未導入)でも import 可能。万一失敗した場合は可視化して skip する。
try:
    from decoder import CourseEstimator
    DECODER_AVAILABLE = True
    IMPORT_ERROR = None
except Exception as e:  # pragma: no cover - 環境依存
    DECODER_AVAILABLE = False
    IMPORT_ERROR = e
    CourseEstimator = None  # type: ignore
    print(f"[WARN] Could not import decoder.CourseEstimator: {e}")

# DB はプロジェクトルート（tests/ の1つ上）にある course_database.json を参照。
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_TESTS_DIR)
DB_FILE = os.path.join(_PROJECT_ROOT, 'course_database.json')


# ---------------------------------------------------------------------------
# 自己検証テスト (assert ベース。pytest 不在でも __main__ 実行で完結)
# ---------------------------------------------------------------------------

def run_assertions():
    """course_database.json に対し推定ロジックの不変条件を検証する。

    gt7data の有無に依存しない。全 assert 通過で [PASS] を出力。
    """
    if not DECODER_AVAILABLE:
        raise AssertionError(
            f"decoder.CourseEstimator を import できませんでした: {IMPORT_ERROR}"
        )

    e = CourseEstimator(DB_FILE)
    assert e.known_courses, "known_courses が読み込めていない (DB パス確認)"
    assert e.courses, "courses が読み込めていない (DB パス確認)"

    # --- 1. 実観測座標(grand_valley): docs 観測 x:-6〜90, z:1280〜1395 ---
    for (x, z) in [(50, 1300), (0, 1300), (90, 1395)]:
        r = e.estimate_course(x, z)
        assert r['id'] == 'grand_valley', \
            f"({x},{z}) は grand_valley を返すべき: got {r['id']}"
        assert r.get('verified') is True, \
            f"({x},{z}) grand_valley は verified=True であるべき: {r}"
        assert r['confidence'] >= 0.9, \
            f"({x},{z}) grand_valley の confidence は >=0.9: {r['confidence']}"

    # --- 2. シャドウ解消: real_track 専用領域は fallback として低 confidence ---
    r = e.estimate_course(-3000, 3000)
    assert r['id'] == 'real_track', f"real_track 専用領域: got {r['id']}"
    assert r.get('source') == 'fallback', f"source は 'fallback' であるべき: {r}"
    assert r['confidence'] <= 0.2, f"fallback confidence は <=0.2: {r['confidence']}"

    # --- 3. シャドウ解消(逆): 具体コースもある座標では real_track にならない ---
    r = e.estimate_course(0, 0)
    assert r.get('source') != 'fallback', \
        f"(0,0) は具体コースが優先され fallback にならない: {r}"
    assert r['id'] != 'real_track', f"(0,0) で real_track が返ってはならない: {r}"

    # --- 4. 重複解決(面積最小・known 優先・決定的) ---
    # (-380, 0) は tokyo east/west の重複領域。east(area 640000)が最小級かつ
    # known 優先で選ばれる。複数回呼んでも同一(決定的)であること。
    first = e.estimate_course(-380, 0)
    assert first['id'] == 'tokyo_expressway_east', \
        f"重複領域では面積最小+known 優先で east を選ぶ: got {first['id']}"
    for _ in range(5):
        again = e.estimate_course(-380, 0)
        assert again['id'] == first['id'], "推定結果が決定的でない(呼び出しごとに変化)"

    # --- 5. placeholder(推測 bounds, verified=false)の confidence レンジ ---
    # (0,0) は推測コース(goodwood 等, verified=false)が当たる。
    r = e.estimate_course(0, 0)
    assert r.get('verified') is False, f"(0,0) は未検証コース: {r}"
    assert 0.4 <= r['confidence'] <= 0.7, \
        f"未検証コースの confidence は 0.4..0.7: {r['confidence']}"

    # --- 6. unknown: どの bounds(real_track ±10000 含む)にも入らない座標 ---
    r = e.estimate_course(50000, 50000)
    assert r['id'] == 'unknown', f"範囲外は unknown: got {r['id']}"
    assert r['confidence'] == 0, f"unknown の confidence は 0: {r['confidence']}"

    # --- 7. 空 bounds 無効化 ---
    assert CourseEstimator._point_in_bounds(0, 0, {}) is False, \
        "空 bounds は False を返すべき(全マッチ防止)"
    assert CourseEstimator._point_in_bounds(0, 0, {'min_x': -1, 'max_x': 1}) is False, \
        "キー欠損 bounds は False を返すべき"
    assert CourseEstimator._bounds_valid({}) is False
    assert CourseEstimator._bounds_valid(
        {'min_x': -1, 'max_x': 1, 'min_z': -1, 'max_z': 1}
    ) is True

    # --- 8. UI 契約: 全ての結果に 'id' と 'name' キーが存在 ---
    for (x, z) in [(50, 1300), (-3000, 3000), (0, 0), (50000, 50000)]:
        r = e.estimate_course(x, z)
        assert 'id' in r and 'name' in r, \
            f"({x},{z}) 結果に id/name が無い(UI 契約違反): {r}"
        # 後方互換: confidence は常に存在し 0..1
        assert 'confidence' in r and 0.0 <= r['confidence'] <= 1.0, \
            f"({x},{z}) confidence が 0..1 でない: {r}"

    # --- 9. 戻り値スキーマ後方互換(マッチ時に id/name/name_en/name_ja/confidence) ---
    r = e.estimate_course(50, 1300)
    for key in ('id', 'name', 'name_en', 'name_ja', 'confidence'):
        assert key in r, f"後方互換キー '{key}' が欠落: {r}"

    print("[PASS] All course-detection assertions passed.")


# pytest 自動収集用の薄いラッパ(pytest 不在でも __main__ 実行で動く)
def test_course_estimation():
    run_assertions()


# ---------------------------------------------------------------------------
# テレメトリ解析ユーティリティ (読み取り専用)
# ---------------------------------------------------------------------------

def analyze_telemetry_files(data_dir='gt7data'):
    """テレメトリーデータファイルを分析して座標範囲を収集する(読み取り専用)。"""
    if not os.path.exists(data_dir):
        print(f"[ERROR] Directory not found: {data_dir}")
        return {}

    course_data = {}

    for filename in os.listdir(data_dir):
        if not filename.endswith('.json'):
            continue

        filepath = os.path.join(data_dir, filename)
        try:
            with open(filepath, 'r') as f:
                data = json.load(f)

            if not isinstance(data, list) or len(data) == 0:
                continue

            course_key = f"course_{filename[:20]}"

            x_values = []
            z_values = []
            for point in data:
                if 'position_x' in point and 'position_z' in point:
                    x_values.append(point['position_x'])
                    z_values.append(point['position_z'])

            if x_values:
                if course_key not in course_data:
                    course_data[course_key] = {'x': [], 'z': [], 'filename': filename}
                course_data[course_key]['x'].extend(x_values)
                course_data[course_key]['z'].extend(z_values)
                print(f"[ANALYZE] {filename}: {len(x_values)} points")

        except Exception as e:
            print(f"[ERROR] Failed to parse {filename}: {e}")

    return course_data


def generate_course_database(course_data, output_file='course_database.json'):
    """分析結果からコースDBを生成する(破壊的・--regenerate 指定時のみ呼ぶ)。"""
    if not course_data:
        print("[WARN] No course data available")
        return

    courses = []
    for i, (key, data) in enumerate(course_data.items()):
        x_values = data['x']
        z_values = data['z']
        course = {
            'id': f'track_{i:02d}',
            'name': f'Track {i + 1} (Auto-generated)',
            'description': f'Generated from {data["filename"]}',
            'verified': False,
            'bounds': {
                'min_x': float(min(x_values)),
                'max_x': float(max(x_values)),
                'min_z': float(min(z_values)),
                'max_z': float(max(z_values)),
            },
            'sample_count': len(x_values),
        }
        courses.append(course)
        print(f"[COURSE] {course['name']}: "
              f"X[{course['bounds']['min_x']:.1f}, {course['bounds']['max_x']:.1f}], "
              f"Z[{course['bounds']['min_z']:.1f}, {course['bounds']['max_z']:.1f}]")

    database = {
        'courses': courses,
        'metadata': {
            'version': '1.2.0',
            'description': 'GT7コースデータベース - 位置座標(x, z)からコースを推定',
            'note': '座標範囲は実際のテレメトリーデータから自動生成されました(verified:false)',
            'generated_courses': len(courses),
        },
    }

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(database, f, ensure_ascii=False, indent=4)
    print(f"[SAVE] Course database saved to {output_file}")


def regenerate_database(data_dir='gt7data', output_file='course_database.json'):
    """gt7data を解析して DB を再生成する(破壊的)。明示フラグ指定時のみ。"""
    print("[STEP 1] Analyzing telemetry data...")
    course_data = analyze_telemetry_files(data_dir)
    if not course_data:
        print("[WARN] No telemetry data found. Skipping database generation.")
        return
    print("[STEP 2] Generating course database (overwriting!)...")
    generate_course_database(course_data, output_file)


def main():
    import argparse

    parser = argparse.ArgumentParser(description='GT7 Course Detection Test')
    parser.add_argument('--data-dir', default='gt7data', help='Telemetry data directory')
    parser.add_argument('--output', default='course_database.json', help='Output database file')
    parser.add_argument('--regenerate', action='store_true',
                        help='gt7data を解析して course_database.json を上書き再生成する(破壊的)')

    args = parser.parse_args()

    print("=" * 60)
    print("GT7 Course Detection Test")
    print("=" * 60)

    # 自己検証は常に実行(DB 上書きしない)。
    run_assertions()

    if args.regenerate:
        print("\n[REGENERATE] --regenerate 指定: DB を再生成します")
        regenerate_database(args.data_dir, args.output)
    else:
        print("\n(--regenerate 未指定のため DB は変更しません)")


if __name__ == '__main__':
    main()
