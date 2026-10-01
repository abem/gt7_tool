FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションファイルをコピー
COPY main.py telemetry.py decoder.py lapstore.py ./
COPY config.json ./
COPY course_database.json* ./
COPY index.html ./
COPY styles.css ./
COPY ui_components.js charts.js steer-response.js websocket.js test-mode.js app.js car-3d.js constants.js lap-manager.js telemetry-analysis.js drive-view.js card-drag.js menu.js review-view.js replay-mode.js race-metrics.js card-groups.js ./
COPY pit-wall.js voice-command.js audio-callout.js persistent-ref.js sector-time.js laptime-predict.js engineer.js track-map.js theory-best.js segment-report.js lap-trend.js channel-plots.js corner-report.js replay-diag.js ./
COPY uplot.min.js uplot.min.css review.css replay.css race-metrics.css card-groups.css ./
COPY engineer.css voice-command.css sector-time.css track-map.css segment-report.css lap-trend.css channel-plots.css corner-report.css persistent-ref.css ./
COPY engineer.html ./
COPY ssl ./ssl

ENV PYTHONUNBUFFERED=1

# ポートを公開（HTTPS/WebSocketとUDP受信）
EXPOSE 8080/tcp
EXPOSE 33740/udp

CMD ["python", "main.py"]
