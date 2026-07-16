FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションファイルをコピー
COPY main.py telemetry.py decoder.py ./
COPY config.json ./
COPY course_database.json* ./
COPY index.html ./
COPY styles.css ./
COPY ui_components.js charts.js steer-response.js websocket.js test-mode.js app.js car-3d.js constants.js lap-manager.js telemetry-analysis.js drive-view.js card-drag.js menu.js review-view.js replay-mode.js ./
COPY uplot.min.js uplot.min.css review.css replay.css ./
COPY ssl ./ssl

ENV PYTHONUNBUFFERED=1

# ポートを公開（HTTPS/WebSocketとUDP受信）
EXPOSE 8080/tcp
EXPOSE 33740/udp

CMD ["python", "main.py"]
