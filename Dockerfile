FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションファイルをコピー
COPY main.py telemetry.py decoder.py lapstore.py ./
COPY config.json ./
COPY course_database.json* ./
# 画面のファイル: トップレベルの *.html・*.js・*.css を、種類ごとに一括でコピーする(#575)。
# ファイルを1つずつ列挙すると、新しいファイルを足し忘れたときに、本番のイメージだけ動かなくなるため。
# イメージに入れたくないファイルは .dockerignore で除く(tests/static_check.py が、HTML の読み込むファイルが
# COPY に含まれることを検査する)。
COPY *.html *.js *.css ./
# ssl/(自己署名の証明書と秘密鍵)はイメージに入れない(#596)。docker-compose.yml が読み取り専用で
# マウントする。無ければ main.py が警告を出して平文 HTTP に落ちる(音声コマンドは https が必要)。

ENV PYTHONUNBUFFERED=1

# ポートを公開（HTTPS/WebSocketとUDP受信）
EXPOSE 8080/tcp
EXPOSE 33740/udp

CMD ["python", "main.py"]
