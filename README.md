# Runpod SDXL (Text-to-Image · Img2Img · Inpaint)

[![Runpod](https://api.runpod.io/badge/your-org/runpod-sdxl)](https://console.runpod.io/hub/your-org/runpod-sdxl)

Serverless GPU Stable Diffusion XL worker for Runpod, powered by [diffusers](https://github.com/huggingface/diffusers). Generate images from text, transform existing images, or inpaint masked regions — all from a single serverless endpoint. Supports SDXL Base 1.0, SDXL Turbo, SDXL Lightning, Juggernaut XL, Playground V2, plus the official SDXL refiner for a final detail pass.

## Features

- Three tasks in one endpoint — `text_to_image`, `image_to_image`, `inpainting`
- 6 curated models with one-click presets — SDXL Base, SDXL Turbo (1-step fast path), SDXL Lightning (4-step), Juggernaut XL v9, Playground V2 1024px Aesthetic, and the SDXL refiner for two-pass workflows
- Optional refiner pass — base produces latents at `denoising_end`, refiner finishes them for sharper detail
- 8 schedulers — DPMSolverMultistep, EulerDiscrete, EulerAncestralDiscrete, DDIM, DDPM, UniPCMultistep, DEISMultistep, LCMScheduler
- Batch prompts — submit a list of prompts and get one result per prompt; per-prompt errors are captured without killing the batch
- Negative prompts — broadcast a single string or align a list to your prompts
- LoRA loading — pass a HuggingFace repo id or direct `.safetensors` URL via `lora_url` with controllable `lora_scale`; cached so repeated calls reuse the same fused LoRA
- Seed control — fixed integer for reproducible runs, or `null` for a random seed (always echoed back as `seed_used`)
- Multi-image generation per prompt via `num_images_per_prompt`
- Configurable output size, classifier-free guidance scale, inference steps, output format (PNG/JPG/WebP) and JPEG quality
- Pipeline cache keyed by `(model, mode, refiner, fp16)` — one model load per worker lifetime
- Memory-friendly defaults (`enable_vae_slicing` + `enable_vae_tiling`) so 1024² works on a 12 GB GPU

## Model table

| Model id | Type | Best for | Recommended steps | VRAM (fp16) |
| --- | --- | --- | --- | --- |
| `stabilityai/stable-diffusion-xl-base-1.0` | Base | General-purpose default | 25-40 | 8-10 GB |
| `stabilityai/sdxl-turbo` | Distilled | 1-2 step fast path | 1-4 | 8 GB |
| `ByteDance/SDXL-Lightning` | Distilled | 2/4/8 step fast path | 4-8 | 8 GB |
| `stabilityai/stable-diffusion-xl-refiner-1.0` | Refiner | Final detail pass after base | 20-40 | 8 GB |
| `RunDiffusion/Juggernaut-XL-v9` | Fine-tune | Photorealism | 30-40 | 8-10 GB |
| `playgroundai/playground-v2-1024px-aesthetic` | Fine-tune | Aesthetic 1024px output | 30-50 | 8-10 GB |

Set `SDXL_ALLOW_ANY_HF_MODEL=1` to let callers pass any HuggingFace SDXL-compatible model id (off by default).

## Input schema

### Required

| Field | Type | Description |
| --- | --- | --- |
| `prompt` | string | A single text prompt (use this OR `prompts`) |
| `prompts` | string[] | A batch of text prompts; takes precedence over `prompt` |

### Common knobs (all optional)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `task` | string | `"text_to_image"` | One of `text_to_image`, `image_to_image`, `inpainting` |
| `model` | string | env `SDXL_MODEL` | One of the 6 allowed models above |
| `refiner_model` | string | `null` | Refiner model id (defaults to `stabilityai/stable-diffusion-xl-refiner-1.0` when `use_refiner=true`) |
| `use_refiner` | bool | `false` | Enable the SDXL refiner pass |
| `scheduler` | string | model default | One of the 8 schedulers above |
| `negative_prompt` | string | `null` | Single negative prompt broadcast to all prompts in the batch |
| `negative_prompts` | string[] | `null` | List of negative prompts aligned to `prompts[]`; shorter lists are padded with `null` |
| `num_inference_steps` | int | `30` | Number of diffusion steps |
| `guidance_scale` | float | `7.0` | Classifier-free guidance scale (use ~0 for SDXL Turbo) |
| `width` | int | `1024` | Output width (text_to_image / inpainting) |
| `height` | int | `1024` | Output height (text_to_image / inpainting) |
| `seed` | int \| null | `null` | Fixed seed for reproducibility; `null` picks a random one |
| `num_images_per_prompt` | int | `1` | Images to generate per prompt |
| `lora_url` | string | `null` | HF repo id or direct `.safetensors` URL |
| `lora_scale` | float | `0.8` | LoRA fuse scale |
| `output_format` | string | `"png"` | One of `png`, `jpg`, `webp` |
| `jpeg_quality` | int | `95` | Used for JPG/WebP encoding |
| `fp16` | bool | `true` | Load weights in float16 on GPU |

### Refiner-specific

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `refiner_denoising_end` | float | `0.8` | Fraction of timesteps the base pipeline runs before handing latents to the refiner |
| `refiner_denoising_start` | float | `0.8` | Fraction at which the refiner picks up the latents |
| `refiner_num_inference_steps` | int | `num_inference_steps` | Steps for the refiner pass |

### Img2img / inpainting inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `init_image_url` | string | one of url/b64 for img2img + inpainting | URL of the initial image |
| `init_image_b64` | string | one of url/b64 for img2img + inpainting | Base64-encoded image or `data:image/...;base64,...` URI |
| `mask_image_url` | string | one of url/b64 for inpainting | URL of the mask image (white = inpaint, black = keep) |
| `mask_image_b64` | string | one of url/b64 for inpainting | Base64-encoded mask image |
| `strength` | float | optional | Img2img / inpainting transformation strength, 0.0-1.0 (default ~0.8) |

## Output shape

```json
{
  "results": [
    {
      "prompt": "a watercolor of a foggy mountain at dawn",
      "negative_prompt": null,
      "seed_used": 1234,
      "images_b64": ["iVBORw0KG..."],
      "num_images": 1,
      "scheduler": "EulerAncestralDiscreteScheduler",
      "model": "stabilityai/stable-diffusion-xl-base-1.0",
      "mode": "text_to_image",
      "width": 1024,
      "height": 1024,
      "num_inference_steps": 25,
      "guidance_scale": 7.0,
      "output_format": "png"
    }
  ],
  "model": "stabilityai/stable-diffusion-xl-base-1.0",
  "refiner_model": null,
  "scheduler": "EulerAncestralDiscreteScheduler",
  "task": "text_to_image",
  "count": 1,
  "lora_url": null,
  "lora_scale": null,
  "fp16": true,
  "defaults": {
    "output_format": "png",
    "jpeg_quality": 95,
    "num_images_per_prompt": 1,
    "num_inference_steps": 25,
    "guidance_scale": 7.0,
    "width": 1024,
    "height": 1024
  }
}
```

Notes:
- `images_b64[i]` is a base64-encoded PNG/JPG/WebP per the requested `output_format`.
- `seed_used` is always populated — even when `seed: null` was requested, so callers can reproduce the generation later.
- `scheduler` reflects the actual scheduler class name on the pipeline after the swap.
- Per-prompt failures attach an `error` field on that result; the rest of the batch still completes.
- Top-level `error` is only set when input validation fails (missing prompt, unknown model/scheduler/task) or pipeline loading fails.

## Example payloads

### 1) Basic text-to-image

```json
{
  "input": {
    "prompt": "a photorealistic golden retriever puppy sitting on a meadow at sunset, cinematic lighting",
    "width": 1024,
    "height": 1024,
    "num_inference_steps": 30,
    "guidance_scale": 7.0,
    "seed": 12345
  }
}
```

### 2) Negative prompt

```json
{
  "input": {
    "prompt": "a high-fashion editorial portrait of a woman in a futuristic outfit, studio lighting",
    "negative_prompt": "blurry, low quality, deformed hands, extra fingers, text, watermark",
    "num_inference_steps": 30,
    "guidance_scale": 8.0,
    "seed": 42
  }
}
```

### 3) Batch prompts

```json
{
  "input": {
    "prompts": [
      "a watercolor painting of a foggy mountain at dawn",
      "a vintage 1970s polaroid photograph of a cat on a windowsill",
      "an isometric pixel art castle floating in the clouds"
    ],
    "negative_prompts": ["", "", "low quality, blurry"],
    "num_inference_steps": 25,
    "seed": 7
  }
}
```

### 4) SDXL Turbo (1-step, low guidance)

```json
{
  "input": {
    "model": "stabilityai/sdxl-turbo",
    "prompt": "a tiny astronaut riding a tortoise on Mars, ultra-detailed digital art",
    "scheduler": "EulerAncestralDiscrete",
    "num_inference_steps": 1,
    "guidance_scale": 0.0,
    "width": 512,
    "height": 512,
    "seed": 999
  }
}
```

### 5) Image-to-image

```json
{
  "input": {
    "task": "image_to_image",
    "prompt": "transform this photograph into a Studio Ghibli style anime illustration, soft pastels",
    "init_image_url": "https://example.com/photo.jpg",
    "strength": 0.65,
    "num_inference_steps": 30,
    "guidance_scale": 7.0,
    "seed": 21
  }
}
```

### 6) Inpainting

```json
{
  "input": {
    "task": "inpainting",
    "prompt": "a bright red apple resting on a wooden table, photorealistic",
    "init_image_url": "https://example.com/scene.jpg",
    "mask_image_url": "https://example.com/scene-mask.png",
    "num_inference_steps": 30,
    "guidance_scale": 8.0,
    "width": 1024,
    "height": 1024,
    "seed": 100
  }
}
```

### 7) LoRA

```json
{
  "input": {
    "prompt": "a portrait of a wizard in pixel art style, intricate details",
    "lora_url": "nerijs/pixel-art-xl",
    "lora_scale": 0.85,
    "num_inference_steps": 30,
    "guidance_scale": 7.0,
    "seed": 555
  }
}
```

`lora_url` accepts either a HuggingFace repo id (e.g. `nerijs/pixel-art-xl`) or a direct `.safetensors` URL.

### 8) Two-stage pipeline (base + refiner)

```json
{
  "input": {
    "prompt": "an architectural photograph of a futuristic glass skyscraper at golden hour, ultra-detailed",
    "use_refiner": true,
    "refiner_model": "stabilityai/stable-diffusion-xl-refiner-1.0",
    "refiner_denoising_end": 0.8,
    "refiner_denoising_start": 0.8,
    "num_inference_steps": 30,
    "refiner_num_inference_steps": 30,
    "guidance_scale": 7.5,
    "seed": 27
  }
}
```

The base pipeline returns latents at the `denoising_end` fraction, then the refiner picks them up at `denoising_start` for a high-frequency-detail polishing pass.

## Scheduler descriptions

| Scheduler | Typical use |
| --- | --- |
| `DPMSolverMultistep` | Strong default; produces high-quality results with 20-30 steps |
| `EulerDiscrete` | Sharp, fast, deterministic; great with SDXL Base |
| `EulerAncestralDiscrete` | Adds noise per step for more variety; recommended for SDXL Turbo |
| `DDIM` | Classic deterministic sampler; needs more steps |
| `DDPM` | Slow but reference-quality |
| `UniPCMultistep` | Strong few-step results (8-15 steps), low memory |
| `DEISMultistep` | DEIS sampler; useful for low-step regimes |
| `LCMScheduler` | Latent Consistency Models — great with LoRA-distilled LCM models in 4-8 steps |

## Sampling tips

- **SDXL Base 1.0** — 30 steps, guidance 7.0, DPMSolverMultistep is a solid baseline.
- **SDXL Turbo** — 1-4 steps, guidance ~0 (no CFG), EulerAncestralDiscrete; designed for real-time use.
- **SDXL Lightning** — 4 or 8 steps depending on the variant; UniPCMultistep or LCMScheduler works well.
- **Refiner workflow** — keep `refiner_denoising_end` and `refiner_denoising_start` aligned (0.7-0.85) and use the same scheduler family for base and refiner.
- **LoRA + Turbo** — set `guidance_scale` to ~0 and `lora_scale` 0.6-0.9; the LoRA influence reduces with low guidance.
- **Native resolutions** — SDXL is trained at 1024px; non-square aspect ratios such as 1216×832, 1152×896, 896×1152, 832×1216 also work natively.

## VRAM notes

- 12 GB GPU — supports 1024² fp16 generation comfortably with `enable_vae_slicing` and `enable_vae_tiling` (both on by default in this worker).
- 24 GB GPU — comfortable headroom for batched prompts and base+refiner two-stage pipelines.
- 8 GB GPU — works for 768² or smaller; expect tighter limits when combining LoRA + refiner.
- First call for a given `(model, mode, refiner, fp16)` triggers a model download (~6.5 GB per SDXL checkpoint). Mount a persistent volume at `HF_HOME` to avoid re-downloads across worker cold starts.

## Local testing

```bash
pip install Pillow numpy requests
python3 test_handler.py
```

The test suite stubs `torch`, `diffusers`, `transformers`, and `runpod` so it runs CPU-only without any GPU or model downloads. It covers:

- Constants and allowed model/scheduler/mode lists
- Prompt collection (single, list, blank-filtering)
- Negative prompt alignment (string broadcast vs aligned list with padding)
- Input dispatch (`prompt` vs `prompts`)
- Error handling (missing prompt, unknown model, unknown scheduler, unknown task, missing init image/mask)
- End-to-end `text_to_image` (mocked) — `result["results"][0]["images_b64"]` non-empty, scheduler swap, seed echo
- Batch prompts (3) with seed broadcast
- `num_images_per_prompt > 1`
- `image_to_image` with a fake init image — `strength` forwarded
- `inpainting` with fake init + mask
- Seed determinism (documented — same seed → same `seed_used`)
- Pipeline cache reuse (one `from_pretrained` call across two requests)
- Refiner pass (base + refiner both called)
- LoRA loading via HF repo id (`load_lora_weights` + `fuse_lora` invoked with correct scale)
- Output format JPG produces real JPEG bytes
- Per-prompt error capture in a batch (middle prompt fails, batch continues)

Expected output ends with `ALL TESTS PASSED`.

## Deployment

1. Build the image: `docker build -t runpod-sdxl .`
2. Push to your registry, or connect this repo to Runpod Hub via `.runpod/hub.json`.
3. Create a GitHub release to trigger Hub ingestion.

The first cold start of a worker downloads the chosen model from HuggingFace (~6.5 GB for SDXL Base, ~8 GB for Playground V2). Mount a persistent volume at `HF_HOME` (`/root/.cache/huggingface`) so weights survive across worker restarts.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SDXL_MODEL` | `stabilityai/stable-diffusion-xl-base-1.0` | Default model when `model` is not given in the request |
| `HF_HOME` | `/root/.cache/huggingface` | HuggingFace cache directory — point at a persistent volume |
| `SDXL_ALLOW_ANY_HF_MODEL` | `0` | Set to `1` to allow any HuggingFace model id (default: restricted to the curated list) |
| `HF_HUB_ENABLE_HF_TRANSFER` | `1` | Faster model downloads (set in the Dockerfile) |
| `PYTHONUNBUFFERED` | `1` | Stream logs immediately |
