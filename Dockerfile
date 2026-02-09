FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .

# 依存関係をインストール
RUN apt-get update && apt-get install -y \
    gcc \
    && pip install --no-cache-dir -r requirements.txt \
    && rm -rf /var/lib/apt/lists/*

# 全てのソースファイルをコピー
COPY *.py .
COPY *.json .
COPY *.html .
COPY *.css .
COPY *.js .

ENV PYTHONUNBUFFERED=1

# ポートを公開（HTTP/WebSocketとUDP受信）
EXPOSE 8080/tcp
EXPOSE 33740/udp

CMD ["python", "main.py"]
