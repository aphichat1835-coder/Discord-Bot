FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir --only-binary :all: -r requirements.txt
COPY main.py .
COPY cogs/ ./cogs/
RUN useradd -m -u 1000 botuser
USER botuser
CMD ["python", "main.py"]
