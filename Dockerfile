FROM python:3.11-slim

WORKDIR /app

# Node.jsをインストール（Three.js用）
RUN apt-get update && apt-get install -y \
    gcc \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Node.js依存関係をインストール
COPY package*.json ./
RUN npm install --production

# アプリケーションファイルをコピー
COPY main.py telemetry.py decoder.py ./
COPY config.json packet_def.json ./
COPY course_database.json* ./
COPY index.html ./
COPY styles.css ./
COPY ui_components.js charts.js course-map.js websocket.js test-mode.js app.js car-3d.js constants.js lap-manager.js ./
COPY uplot.min.js uplot.min.css ./

ENV PYTHONUNBUFFERED=1

# ポートを公開（HTTP/WebSocketとUDP受信）
EXPOSE 18080/tcp
EXPOSE 33740/udp

CMD ["python", "main.py"]
