"""
タイヤヘルパーモジュール

タイヤデータの変換、履歴管理などを提供します。
"""


class TyreHistory:
    """
    タイヤ温度の履歴を管理します
    """

    def __init__(self, max_history: int = 10):
        """
        履歴を初期化します

        Args:
            max_history: 最大履歴数
        """
        self.max_history = max_history
        self.history = []

    def add(self, tyre_temps: list):
        """
        履歴を追加します

        Args:
            tyre_temps: 4つのタイヤ温度のリスト [FL, FR, RL, RR]
        """
        self.history.append(tyre_temps.copy())
        if len(self.history) > self.max_history:
            self.history.pop(0)

    def get_history(self) -> list:
        """
        履歴を取得します

        Returns:
        """
        return self.history

    def clear(self):
        """履歴をクリアします"""
        self.history = []
