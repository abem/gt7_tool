"""
数学ユーティリティモジュール

タイヤスリップ率、接地率などの計算ロジックを提供します。
"""


def calculate_slip_ratio(wheel_kmh: float, vehicle_kmh: float) -> float:
    """
    タイヤスリップ率を計算します

    Args:
        wheel_kmh: タイヤの速度 (km/h)
        vehicle_kmh: 車両の速度 (km/h)

    Returns:
        スリップ率 (0-100%)
    """
    if wheel_kmh > vehicle_kmh:
        slip = (wheel_kmh - vehicle_kmh) / wheel_kmh * 100
    else:
        slip = 0
    return min(max(slip, 0), 100)


def calculate_load_ratio(suspension_height: float, max_travel: float = 50.0) -> float:
    """
    接地率を計算します

    Args:
        suspension_height: サスペンション高さ (mm)
        max_travel: 最大サスペンションストローク (mm)

    Returns:
        接地率 (0-1)
    """
    travel = max_travel - suspension_height
    load_ratio = 1 - (travel / max_travel)
    return min(max(load_ratio, 0), 1)


def get_temp_color(temp_celsius: float) -> tuple:
    """
    温度に基づいて色を返します

    Args:
        temp_celsius: 温度 (°C)

    Returns:
        (色コード, 状態名)
    """
    if temp_celsius < 40:
        return '#44ffff', 'cold'
    elif temp_celsius < 80:
        return '#00ff88', 'optimal'
    else:
        return '#ff4444', 'hot'


def get_slip_color_class(slip_ratio: float) -> str:
    """
    スリップ率に基づいて色クラスを返します

    Args:
        slip_ratio: スリップ率 (0-100%)

    Returns:
        CSSクラス名
    """
    if slip_ratio > 50:
        return 'slip-danger'
    elif slip_ratio > 20:
        return 'slip-warn'
    else:
        return 'slip-good'


def get_load_color_class(load_ratio: float) -> str:
    """
    接地率に基づいて色クラスを返します

    Args:
        load_ratio: 接地率 (0-1)

    Returns:
        CSSクラス名
    """
    if load_ratio < 0.2:
        return 'load-void'
    elif load_ratio < 0.5:
        return 'load-low'
    else:
        return 'load-ideal'


def get_brake_temp_color(brake_temp: float) -> str:
    """
    ブレーキ温度に基づいて色を返します

    Args:
        brake_temp: ブレーキ温度 (°C)

    Returns:
        色コード
    """
    return '#ff4444' if brake_temp > 400 else '#ffaa00'


def format_wheel_rps(rps: float) -> str:
    """
    ホイール回転数を文字列にフォーマットします

    Args:
        rps: ホイール回転数 (rev/s)

    Returns:
        フォーマットされた文字列
    """
    return f"{rps:.2f} rps"


def format_temperature(temp_celsius: float) -> str:
    """
    温度を文字列にフォーマットします

    Args:
        temp_celsius: 温度 (°C)

    Returns:
        フォーマットされた文字列
    """
    return f"{temp_celsius:.1f}°C"


def format_speed_kmh(speed_kmh: float) -> str:
    """
    速度を文字列にフォーマットします

    Args:
        speed_kmh: 速度 (km/h)

    Returns:
        フォーマットされた文字列
    """
    return f"{speed_kmh:.0f}"


def format_suspension_height(susp_height: float) -> str:
    """
    サスペンション高さを文字列にフォーマットします

    Args:
        susp_height: サスペンション高さ (mm)

    Returns:
        フォーマットされた文字列
    """
    return f"{susp_height:.1f}mm"


def format_tyre_radius(radius: float) -> str:
    """
    タイヤ半径を文字列にフォーマットします

    Args:
        radius: タイヤ半径 (m)

    Returns:
        フォーマットされた文字列
    """
    return f"{radius:.3f}m"
