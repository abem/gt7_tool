FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .

# 依存関係をインストール
RUN apt-get update && apt-get install -y \
    gcc \
    && pip install --no-cache-dir -r requirements.txt \
    && rm -rf /var/lib/apt/lists/*

# アプリケーションファイルのみコピー
COPY main.py telemetry.py decoder.py ./
COPY config.json packet_def.json ./
COPY course_database.json* ./
COPY index.html ./
COPY styles.css ./
COPY ui_components.js charts.js course-map.js websocket.js test-mode.js app.js ./
COPY uplot.min.js uplot.min.css ./

ENV PYTHONUNBUFFERED=1

# ポートを公開（HTTP/WebSocketとUDP受信）
EXPOSE 8080/tcp
EXPOSE 33740/udp

CMD ["python", "main.py"]
