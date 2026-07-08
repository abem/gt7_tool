"""
GT7 デコーダーの回帰テスト

このテストは Bug#1（Salsa20 import 漏れによる5日間の復号不全）の再発を防止する。
実機の暗号化パケットが無いため、Salsa20 で「暗号化」した合成パケットを生成し、
それを decoder が正しく復号・解析できるかを検証する（暗号化ヘルパーは GT7 の
IV 生成アルゴリズムを再現）。

実行:
    pytest tests/ -v
    # または
    python -m pytest tests/ -v
"""

import struct

import pytest

from decoder import GT7Decoder, CourseEstimator


# ─────────────────────────────────────────────────────────────────────
# 暗号化パケット生成ヘルパー（GT7 の IV 生成アルゴリズムを再現）
# ─────────────────────────────────────────────────────────────────────

SALSA20_KEY = b'Simulator Interface Packet GT7 ver 0.0'
MAGIC_G7S0 = 0x47375330


def _build_plaintext(magic: int = MAGIC_G7S0, package_id: int = 1,
                     speed_ms: float = 50.0, rpm: float = 5000.0,
                     gear: int = 3, size: int = 0x158) -> bytes:
    """復号後に現れるべき平文パケットを構築。

    GT7 パケットフォーマットの主要オフセットに既知値を埋め込む:
      0x00: magic (G7S0)
      0x3C: rpm (float)
      0x4C: speed_ms (float)
      0x70: package_id (int32)
      0x90: gear (下位4bit) / suggested (上位4bit)
      0x40: oiv（IV 生成元。暗号化側でも読むので平文にも置いておく）
    残りは 0。
    """
    d = bytearray(size)
    struct.pack_into('<I', d, 0x00, magic)
    struct.pack_into('<f', d, 0x3C, rpm)
    struct.pack_into('<f', d, 0x4C, speed_ms)
    struct.pack_into('<i', d, 0x70, package_id)
    struct.pack_into('<B', d, 0x90, gear & 0x0F)
    # oiv は任意の4バイトでよい（暗号化時に同じ位置から読む）
    struct.pack_into('<I', d, 0x40, 0x11223344)
    return bytes(d)


def _encrypt_packet(plaintext: bytes, xor_value: int) -> bytes:
    """GT7 の IV 生成アルゴリズムを使って平文を暗号化（decoder.decrypt の逆変換）。

    GT7 パケットでは data[0x40:0x44] (=oiv) は「暗号化されたバイト列の中の」
    位置として扱われる。decoder._try_decrypt は暗号文の 0x40 位置を読んで IV を
    組み立てる。従って暗号化側は:
      1. 平文全体を Salsa20 で暗号化
      2. 生成した暗号文の 0x40 位置を IV 計算元として使えるよう、
         暗号文の 0x40:0x44 を、IV 計算に使う oiv で上書き（平文と一致させる）
    これで decoder が同じ oiv から同一 IV を再現して復号できる。

    decoder._try_decrypt の IV 構築:
        oiv = data[0x40:0x44]            # 暗号文の 0x40
        iv1 = int.from_bytes(oiv, 'little')
        iv2 = iv1 ^ xor_value
        iv  = iv2(4B) + iv1(4B)
    """
    from Crypto.Cipher import Salsa20
    # 平文の oiv を IV 計算元として使う
    oiv = plaintext[0x40:0x44]
    iv1 = int.from_bytes(oiv, byteorder='little')
    iv2 = iv1 ^ xor_value
    iv = iv2.to_bytes(4, 'little') + iv1.to_bytes(4, 'little')
    cipher = Salsa20.new(SALSA20_KEY[:32], bytes(iv))
    encrypted = cipher.encrypt(plaintext)
    # 暗号文の 0x40 位置を平文の oiv で上書きし、decoder が同一 IV を再現できるようにする
    encrypted = encrypted[:0x40] + oiv + encrypted[0x44:]
    return encrypted


@pytest.fixture
def decoder():
    return GT7Decoder()


@pytest.fixture
def course_estimator():
    return CourseEstimator()


# ─────────────────────────────────────────────────────────────────────
# Bug#1 回帰テスト: Salsa20 import 漏れ
# ─────────────────────────────────────────────────────────────────────

class TestSalsa20ImportRegression:
    """Bug#1: _try_decrypt が NameError を起こさないことを検証。

    従来 from Crypto.Cipher import Salsa20 が未実装で、全パケットが
    NameError で復号失敗していた（5日間・152万件）。このクラスで再発を防ぐ。
    """

    def test_try_decrypt_does_not_raise_nameerror(self, decoder):
        """_try_decrypt が NameError ではなく正常に復帰することを確認。

        ダミーデータ（0埋め）は magic 不一致で空バイトを返すが、
        重要なのは NameError が出ないこと。
        """
        dummy = b'\x00' * 0x100
        # NameError が出なければ PASS。b'' が返るのが正しい。
        result = decoder._try_decrypt(dummy, 0xDEADBEAF)
        assert result == b'', "ダミーデータは magic 不一致で空バイトを返すべき"

    def test_decrypt_small_packet_returns_empty(self, decoder):
        """パケットサイズ不足時は b'' を返し、例外を出さない"""
        result = decoder.decrypt(b'\x00' * 10)
        assert result == b''

    def test_decrypt_valid_packet_succeeds(self, decoder):
        """合成した有効な暗号化パケットを正しく復号できることを確認。

        これが Bug#1 修正の本質: 復号が成功し magic が G7S0 に一致する。
        """
        plaintext = _build_plaintext(package_id=42, speed_ms=55.5, rpm=6000.0, gear=4)
        encrypted = _encrypt_packet(plaintext, decoder._xor_value)
        decrypted = decoder.decrypt(encrypted)
        assert len(decrypted) > 0, "有効パケットは復号成功で空でないデータを返すべき"
        magic = int.from_bytes(decrypted[0:4], byteorder='little')
        assert magic == MAGIC_G7S0, "復号後の magic が G7S0 に一致するべき"


# ─────────────────────────────────────────────────────────────────────
# XOR フォールバックテスト
# ─────────────────────────────────────────────────────────────────────

class TestXorFallback:
    """ハートビートタイプ別の XOR フォールバック動作を検証。"""

    def test_fallback_to_alternate_xor(self, decoder):
        """デフォルト XOR で暗号化したパケットを、別 XOR でも復号できることを確認。

        decoder.decrypt は現在の XOR で失敗時、他の XOR 値を順に試す。
        どれか1つでも成功すればフォールバック成立。
        """
        # どの XOR でも暗号化パケットを作れば、少なくとも1つはマッチする
        plaintext = _build_plaintext(package_id=100)
        # 任意の XOR（A 系）で暗号化
        encrypted = _encrypt_packet(plaintext, 0xDEADBEAF)
        decrypted = decoder.decrypt(encrypted)
        assert len(decrypted) > 0, "フォールバック含めいずれかの XOR で復号できるべき"

    def test_all_heartbeat_types_decrypt(self):
        """A / B / ~ の全ハートビートタイプで暗号化→復号が成功することを確認"""
        for hb_type, xor_val in GT7Decoder.XOR_MAP.items():
            dec = GT7Decoder(heartbeat_type=hb_type)
            plaintext = _build_plaintext(package_id=7)
            encrypted = _encrypt_packet(plaintext, xor_val)
            decrypted = dec.decrypt(encrypted)
            assert len(decrypted) > 0, f"heartbeat '{hb_type.decode()}' で復号できるべき"


# ─────────────────────────────────────────────────────────────────────
# パース（フィールド抽出）テスト
# ─────────────────────────────────────────────────────────────────────

class TestParse:
    """復号済みパケットからのフィールド抽出を検証。"""

    def test_parse_extracts_known_fields(self, decoder):
        """既知値を埋め込んだパケットを parse して正しく抽出できること"""
        plaintext = _build_plaintext(
            package_id=123, speed_ms=55.5, rpm=6000.0, gear=4
        )
        result = decoder.parse(plaintext)
        assert result is not None, "有効サイズのパケットは parse で None を返さない"
        assert result['package_id'] == 123
        assert result['speed_ms'] == pytest.approx(55.5, abs=0.01)
        assert result['speed_kmh'] == pytest.approx(55.5 * 3.6, abs=0.1)
        assert result['rpm'] == pytest.approx(6000.0, abs=1.0)
        assert result['gear'] == 4

    def test_parse_too_small_returns_none(self, decoder):
        """最小解析サイズ未満のパケットは None を返す"""
        result = decoder.parse(b'\x00' * 10)
        assert result is None

    def test_end_to_end_decrypt_then_parse(self, decoder):
        """暗号化→復号→解析の完全なパイプラインが既知値を保持すること"""
        plaintext = _build_plaintext(package_id=999, speed_ms=80.0, rpm=7500.0, gear=6)
        encrypted = _encrypt_packet(plaintext, decoder._xor_value)
        decrypted = decoder.decrypt(encrypted)
        parsed = decoder.parse(decrypted)
        assert parsed['package_id'] == 999
        assert parsed['speed_kmh'] == pytest.approx(80.0 * 3.6, abs=0.1)


# ─────────────────────────────────────────────────────────────────────
# CourseEstimator テスト
# ─────────────────────────────────────────────────────────────────────

class TestCourseEstimator:
    """コース推定ロジックの基本動作を検証（Crypto 非依存）。"""

    def test_unknown_point_returns_low_confidence(self, course_estimator):
        """DB に無い座標は unknown を返す"""
        # 極端に遠い座標（どのコース bounds にも含まれない想定）
        result = course_estimator.estimate_course(999999.0, 999999.0)
        assert result['id'] == 'unknown'
        assert result['confidence'] <= 0.2

    def test_estimate_returns_required_keys(self, course_estimator):
        """戻り値が UI 契約（id, name, confidence）のキーを持つこと"""
        result = course_estimator.estimate_course(0.0, 0.0)
        assert 'id' in result
        assert 'name' in result
        assert 'confidence' in result

    def test_bounds_helpers(self):
        """_bounds_valid / _point_in_bounds / _bounds_area の単体検証"""
        bounds = {'min_x': -10, 'max_x': 10, 'min_z': -5, 'max_z': 5}
        assert CourseEstimator._bounds_valid(bounds) is True
        assert CourseEstimator._bounds_area(bounds) == 20 * 10
        assert CourseEstimator._point_in_bounds(0, 0, bounds) is True
        assert CourseEstimator._point_in_bounds(11, 0, bounds) is False
        # キー欠損 bounds は無効
        assert CourseEstimator._bounds_valid({'min_x': 0}) is False
        assert CourseEstimator._point_in_bounds(0, 0, {}) is False
