FROM nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04

WORKDIR /app

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
       python3-pip python3-dev build-essential \
       libgl1 libglib2.0-0 \
       git \
    && rm -rf /var/lib/apt/lists/*

RUN ldconfig /usr/local/cuda-12.1/compat/

RUN python3 -m pip install --no-cache-dir --upgrade pip

RUN python3 -m pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cu121 \
    torch==2.3.1 torchvision==0.18.1

COPY requirements.txt /requirements.txt
RUN python3 -m pip install --no-cache-dir -r /requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1 \
    SDXL_MODEL=stabilityai/stable-diffusion-xl-base-1.0 \
    HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_OFFLINE=0 \
    HF_HUB_ENABLE_HF_TRANSFER=1

CMD ["python3", "-u", "handler.py"]
