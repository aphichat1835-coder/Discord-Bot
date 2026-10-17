FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir --only-binary :all: discord.py==2.4.0 pydantic==2.8.2 python-dotenv==1.0.1
COPY main.py .
COPY cogs/ ./cogs/
RUN useradd -m -u 1000 botuser
USER botuser
CMD ["python", "main.py"]
