"""disk_guard.py のモックテスト(#557)。副作用なし。

実際のディスク・通知(alert)・trash削除・gt7data の退避・状態ファイルには一切触れない。
すべて差し替えて、閾値判定と分岐(警告/緊急/退避の有無/通知のクールダウン)だけを確認する。

使い方: python3 -B scripts/disk_guard_test.py
"""
import importlib.util
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def load_module(path):
    spec = importlib.util.spec_from_file_location("disk_guard_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


TARGET = os.environ.get("DISK_GUARD_PATH", os.path.join(HERE, "disk_guard.py"))
dg = load_module(TARGET)

RETENTION = {"enabled": True, "trash_days": 14}


class Harness:
    """1ケース分の差し替え一式。"""

    def __init__(self, root, data, same_fs):
        self.calls = {"alert": [], "purge": 0, "stage": 0}
        self.tmp = tempfile.mkdtemp()
        usage = {"/": root, os.path.realpath(dg.DATA_DIR): data}
        self._patches = [
            mock.patch.object(dg, "disk_pct", side_effect=lambda p: usage.get(p, usage.get(os.path.realpath(p), root))),
            mock.patch.object(dg, "data_disk", side_effect=lambda: (data[0], data[1], same_fs)),
            mock.patch.object(dg, "alert", side_effect=lambda *a, **k: self.calls["alert"].append((a, k))),
            mock.patch.object(dg.R, "load_retention_config", return_value=RETENTION),
            mock.patch.object(dg.R, "purge_trash", side_effect=self._purge),
            mock.patch.object(dg, "emergency_stage_to_trash", side_effect=self._stage),
            mock.patch.object(dg, "STATE_FILE", os.path.join(self.tmp, "state.json")),
            mock.patch.object(dg.os, "access", return_value=True),
        ]

    def _purge(self, *a, **k):
        self.calls["purge"] += 1
        return []

    def _stage(self, *a, **k):
        self.calls["stage"] += 1
        return 7

    def __enter__(self):
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()


class DiskGuardTest(unittest.TestCase):
    def run_main(self, root, data, same_fs=False):
        with Harness(root, data, same_fs) as h:
            with mock.patch("builtins.print"):
                rc = dg.main()
            return rc, h.calls

    def test_both_below_warn_does_nothing(self):
        rc, c = self.run_main((46.0, 115.0), (29.0, 165.0))
        self.assertEqual(rc, 0)
        self.assertEqual(c["alert"], [])
        self.assertEqual(c["purge"], 0)
        self.assertEqual(c["stage"], 0)

    def test_data_fs_warn_is_detected_even_if_root_is_low(self):
        # 修正の主目的: 「/」は46%でも、gt7data が載る /data が86%なら検知する
        rc, c = self.run_main((46.0, 115.0), (86.0, 30.0))
        self.assertEqual(len(c["alert"]), 1)
        self.assertIn("警告", c["alert"][0][0][0])
        self.assertIn("/data", c["alert"][0][0][1])       # 高い方のFSを明示
        self.assertEqual(c["purge"], 1)                    # 期限切れtrashの掃除は従来どおり
        self.assertEqual(c["stage"], 0)                    # 警告では退避しない

    def test_data_fs_emergency_stages_and_alerts(self):
        rc, c = self.run_main((46.0, 115.0), (91.0, 10.0))
        self.assertEqual(c["stage"], 1)
        self.assertEqual(len(c["alert"]), 1)
        self.assertIn("緊急", c["alert"][0][0][0])
        self.assertIn("7件", c["alert"][0][0][1])

    def test_root_only_emergency_does_not_stage_gt7data(self):
        # 「/」だけが90%超: gt7data の退避では空き容量が増えないので退避せず通知のみ
        rc, c = self.run_main((92.0, 8.0), (29.0, 165.0))
        self.assertEqual(c["stage"], 0)
        self.assertEqual(len(c["alert"]), 1)
        self.assertIn("gt7data以外", c["alert"][0][0][1])
        self.assertEqual(c["alert"][0][1].get("urgency"), "critical")

    def test_same_fs_behaves_like_before(self):
        # gt7data が「/」と同一FS: 従来どおり「/」の値で判定・退避する
        rc, c = self.run_main((91.0, 10.0), (91.0, 10.0), same_fs=True)
        self.assertEqual(c["stage"], 1)
        self.assertEqual(len(c["alert"]), 1)

    def test_alert_cooldown(self):
        with Harness((46.0, 115.0), (86.0, 30.0), False) as h:
            with mock.patch("builtins.print"):
                dg.main()
                dg.main()          # クールダウン(12h)内の再実行では再通知しない
            self.assertEqual(len(h.calls["alert"]), 1)

    def test_data_dir_unreadable_falls_back_to_root(self):
        with Harness((46.0, 115.0), (0.0, 0.0), False) as h:
            with mock.patch.object(dg, "data_disk", return_value=None), mock.patch("builtins.print"):
                rc = dg.main()
            self.assertEqual(rc, 0)
            self.assertEqual(h.calls["alert"], [])

    def test_thresholds_unchanged(self):
        self.assertEqual((dg.WARN_PCT, dg.EMERGENCY_PCT), (85, 90))


if __name__ == "__main__":
    unittest.main(verbosity=2)
