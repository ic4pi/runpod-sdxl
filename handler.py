"""Runpod serverless handler for SDXL (Stable Diffusion XL).

Supports three modes:
  - text_to_image — pure prompt-driven generation, optional refiner pass
  - image_to_image — img2img with init image and strength
  - inpainting — masked inpainting with init image + mask image

Backed by `diffusers` pipelines. Caches one pipeline per
(model, mode, refiner, fp16) tuple so repeated calls reuse the same GPU
memory. Accepts a single prompt or a batch of prompts; each prompt's
result captures its own error so a bad prompt does not kill the batch.

Returns a list of `{prompt, seed_used, images_b64: [...], scheduler, model}`.
"""
from __future__ import annotations

import base64
import io
import os
import random
import re
from typing import Any, Dict, List, Optional, Tuple

import requests

try:
    import runpod
except Exception:
    runpod = None

try:
    import torch
except Exception as e:
    raise RuntimeError(
        "torch is required. Install a CUDA-enabled torch wheel."
    ) from e

try:
    import diffusers
    from diffusers import (
        StableDiffusionXLPipeline,
        StableDiffusionXLImg2ImgPipeline,
        StableDiffusionXLInpaintPipeline,
        DPMSolverMultistepScheduler,
        EulerDiscreteScheduler,
        EulerAncestralDiscreteScheduler,
        DDIMScheduler,
        DDPMScheduler,
        UniPCMultistepScheduler,
        DEISMultistepScheduler,
        LCMScheduler,
    )
except Exception as e:
    raise RuntimeError(
        "diffusers is required. `pip install diffusers>=0.27.0`"
    ) from e

try:
    import transformers
except Exception as e:
    raise RuntimeError("transformers is required.") from e

try:
    import numpy as np
    from PIL import Image
except Exception as e:
    raise RuntimeError(
        "Pillow and numpy are required for image I/O."
    ) from e




ALLOWED_MODELS = [
    "stabilityai/stable-diffusion-xl-base-1.0",
    "stabilityai/sdxl-turbo",
    "ByteDance/SDXL-Lightning",
    "stabilityai/stable-diffusion-xl-refiner-1.0",
    "RunDiffusion/Juggernaut-XL-v9",
    "playgroundai/playground-v2-1024px-aesthetic",
]


ALLOWED_SCHEDULERS = [
    "DPMSolverMultistep",
    "EulerDiscrete",
    "EulerAncestralDiscrete",
    "DDIM",
    "DDPM",
    "UniPCMultistep",
    "DEISMultistep",
    "LCMScheduler",
]


_SCHEDULER_CLASSES = {
    "DPMSolverMultistep": DPMSolverMultistepScheduler,
    "EulerDiscrete": EulerDiscreteScheduler,
    "EulerAncestralDiscrete": EulerAncestralDiscreteScheduler,
    "DDIM": DDIMScheduler,
    "DDPM": DDPMScheduler,
    "UniPCMultistep": UniPCMultistepScheduler,
    "DEISMultistep": DEISMultistepScheduler,
    "LCMScheduler": LCMScheduler,
}


ALLOWED_MODES = ["text_to_image", "image_to_image", "inpainting"]


ALLOWED_FORMATS = {"png", "jpg", "jpeg", "webp"}


DEFAULT_MODEL = os.getenv("SDXL_MODEL", "stabilityai/stable-diffusion-xl-base-1.0")


def _truthy(v: Optional[str]) -> bool:
    return bool(v) and v.lower() in ("1", "true", "yes", "y", "on")


ALLOW_ANY_HF_MODEL = _truthy(os.getenv("SDXL_ALLOW_ANY_HF_MODEL", ""))




_PIPE_CACHE: Dict[Tuple[str, str, Optional[str], bool], Any] = {}
_LORA_LOADED_FOR: Dict[int, Tuple[str, float]] = {}


def _device_and_dtype(fp16: bool) -> Tuple[str, "torch.dtype"]:
    if torch.cuda.is_available():
        return "cuda", torch.float16 if fp16 else torch.float32
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps", torch.float16 if fp16 else torch.float32
    return "cpu", torch.float32


def _pipeline_class_for_mode(mode: str):
    if mode == "text_to_image":
        return StableDiffusionXLPipeline
    if mode == "image_to_image":
        return StableDiffusionXLImg2ImgPipeline
    if mode == "inpainting":
        return StableDiffusionXLInpaintPipeline
    raise ValueError(f"unknown mode '{mode}'. allowed: {ALLOWED_MODES}")


def _validate_model(model: str) -> None:
    if model in ALLOWED_MODELS:
        return
    if ALLOW_ANY_HF_MODEL:
        return
    raise ValueError(
        f"unknown model '{model}'. allowed: {ALLOWED_MODELS} "
        f"(set SDXL_ALLOW_ANY_HF_MODEL=1 to permit any HF id)"
    )


def get_pipeline(
    model: str,
    mode: str,
    refiner_model: Optional[str],
    fp16: bool,
) -> Any:
    """Load (or return cached) diffusers pipeline for the given combination."""
    _validate_model(model)
    if refiner_model:
        _validate_model(refiner_model)

    key = (model, mode, refiner_model, bool(fp16))
    if key in _PIPE_CACHE:
        return _PIPE_CACHE[key]

    device, dtype = _device_and_dtype(fp16)
    pipe_cls = _pipeline_class_for_mode(mode)

    load_kwargs: Dict[str, Any] = {"torch_dtype": dtype}
    if fp16 and dtype == torch.float16:
        load_kwargs["variant"] = "fp16"
    load_kwargs["use_safetensors"] = True

    base = pipe_cls.from_pretrained(model, **load_kwargs)
    base = base.to(device)
    try:
        base.enable_vae_slicing()
    except Exception:
        pass
    try:
        base.enable_vae_tiling()
    except Exception:
        pass

    bundle: Dict[str, Any] = {
        "base": base,
        "device": device,
        "dtype": dtype,
        "model": model,
        "mode": mode,
    }

    if refiner_model:
        refiner = StableDiffusionXLImg2ImgPipeline.from_pretrained(
            refiner_model, **load_kwargs
        ).to(device)
        try:
            refiner.enable_vae_slicing()
        except Exception:
            pass
        try:
            refiner.enable_vae_tiling()
        except Exception:
            pass
        bundle["refiner"] = refiner

    _PIPE_CACHE[key] = bundle
    return bundle




def apply_scheduler(pipe: Any, scheduler: Optional[str]) -> Optional[str]:
    """Replace the pipeline scheduler in-place. Returns the active scheduler name."""
    if not scheduler:
        return type(pipe.scheduler).__name__
    if scheduler not in _SCHEDULER_CLASSES:
        raise ValueError(
            f"unknown scheduler '{scheduler}'. allowed: {ALLOWED_SCHEDULERS}"
        )
    cls = _SCHEDULER_CLASSES[scheduler]
    try:
        pipe.scheduler = cls.from_config(pipe.scheduler.config)
    except Exception as e:
        raise RuntimeError(
            f"failed to set scheduler {scheduler!r}: {e}"
        ) from e
    return scheduler




def maybe_load_lora(
    pipe: Any, lora_url: Optional[str], lora_scale: float
) -> Optional[str]:
    """Load a LoRA into the pipeline if `lora_url` is given.

    Accepts either a HuggingFace repo id (e.g. `org/lora-name`) or a direct
    URL to a `.safetensors` file. Skips reload when the same (url, scale) is
    already active on this pipeline instance.
    """
    if not lora_url:
        pid = id(pipe)
        if pid in _LORA_LOADED_FOR:
            try:
                pipe.unload_lora_weights()
            except Exception:
                pass
            _LORA_LOADED_FOR.pop(pid, None)
        return None

    pid = id(pipe)
    cur = _LORA_LOADED_FOR.get(pid)
    if cur == (lora_url, float(lora_scale)):
        return lora_url

    if cur is not None:
        try:
            pipe.unload_lora_weights()
        except Exception:
            pass

    if lora_url.startswith("http://") or lora_url.startswith("https://"):
        path = _download_to_tmp(lora_url, suffix=".safetensors")
        try:
            pipe.load_lora_weights(path)
        except Exception as e:
            raise RuntimeError(f"failed to load LoRA from URL: {e}") from e
    else:
        try:
            pipe.load_lora_weights(lora_url)
        except Exception as e:
            raise RuntimeError(f"failed to load LoRA repo: {e}") from e

    try:
        pipe.fuse_lora(lora_scale=float(lora_scale))
    except Exception:
        try:
            pipe.set_adapters(["default"], adapter_weights=[float(lora_scale)])
        except Exception:
            pass

    _LORA_LOADED_FOR[pid] = (lora_url, float(lora_scale))
    return lora_url




_DATA_URI_RE = re.compile(r"^data:([^;,]+);base64,(.+)$", re.IGNORECASE | re.DOTALL)


def download_bytes(url: str, timeout: int = 120) -> bytes:
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.content


def _download_to_tmp(url: str, suffix: str = "") -> str:
    import tempfile

    data = download_bytes(url)
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def decode_image_b64(s: str) -> bytes:
    if not isinstance(s, str) or not s:
        raise ValueError("image base64 data must be a non-empty string")
    m = _DATA_URI_RE.match(s.strip())
    payload = m.group(2) if m else s
    payload = "".join(payload.split())
    try:
        return base64.b64decode(payload, validate=False)
    except Exception as e:
        raise ValueError(f"invalid base64 image data: {e}") from e


def _resolve_image_input(
    inp: Dict[str, Any], url_key: str, b64_key: str
) -> Optional[Image.Image]:
    """Return a PIL.Image from the matching url/b64 keys, or None if neither set."""
    url = inp.get(url_key)
    b64 = inp.get(b64_key)
    if isinstance(url, str) and url:
        data = download_bytes(url)
    elif isinstance(b64, str) and b64:
        data = decode_image_b64(b64)
    else:
        return None
    with Image.open(io.BytesIO(data)) as im:
        return im.convert("RGB")


def _resolve_mask(inp: Dict[str, Any]) -> Optional[Image.Image]:
    """Mask is converted to L (single channel)."""
    url = inp.get("mask_image_url")
    b64 = inp.get("mask_image_b64")
    if isinstance(url, str) and url:
        data = download_bytes(url)
    elif isinstance(b64, str) and b64:
        data = decode_image_b64(b64)
    else:
        return None
    with Image.open(io.BytesIO(data)) as im:
        return im.convert("L")




def encode_pil(img: Image.Image, fmt: str, jpeg_quality: int = 95) -> Tuple[bytes, str]:
    fmt = fmt.lower()
    if fmt == "jpeg":
        fmt = "jpg"
    if fmt not in ALLOWED_FORMATS:
        raise ValueError(
            f"unsupported output_format '{fmt}'. allowed: {sorted(ALLOWED_FORMATS)}"
        )
    buf = io.BytesIO()
    if fmt == "png":
        img.save(buf, format="PNG", optimize=False)
        return buf.getvalue(), "image/png"
    if fmt == "webp":
        img.save(buf, format="WEBP", quality=int(jpeg_quality), lossless=False)
        return buf.getvalue(), "image/webp"
    rgb = img.convert("RGB") if img.mode != "RGB" else img
    rgb.save(buf, format="JPEG", quality=int(jpeg_quality), optimize=True)
    return buf.getvalue(), "image/jpeg"


def encode_b64(img: Image.Image, fmt: str, jpeg_quality: int) -> str:
    data, _mime = encode_pil(img, fmt, jpeg_quality)
    return base64.b64encode(data).decode("ascii")




def collect_prompts(inp: Dict[str, Any]) -> List[str]:
    prompts: List[str] = []
    if isinstance(inp.get("prompts"), list):
        for p in inp["prompts"]:
            if isinstance(p, str) and p.strip():
                prompts.append(p)
    elif isinstance(inp.get("prompt"), str) and inp["prompt"].strip():
        prompts.append(inp["prompt"])
    return prompts


def collect_negative_prompts(inp: Dict[str, Any], n: int) -> List[Optional[str]]:
    """Return one negative prompt slot per positive prompt.

    Accepts either `negative_prompt` (string applied to all) or
    `negative_prompts` (list aligned to prompts, padded with None).
    """
    if isinstance(inp.get("negative_prompts"), list):
        out: List[Optional[str]] = []
        for i in range(n):
            v = (
                inp["negative_prompts"][i]
                if i < len(inp["negative_prompts"])
                else None
            )
            out.append(v if (isinstance(v, str) and v.strip()) else None)
        return out
    np_str = inp.get("negative_prompt")
    if isinstance(np_str, str) and np_str.strip():
        return [np_str] * n
    return [None] * n




def _make_generator(device: str, seed: Optional[int]) -> Tuple[Any, int]:
    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    seed = int(seed)
    if device.startswith("cuda"):
        g = torch.Generator(device=device).manual_seed(seed)
    else:
        g = torch.Generator().manual_seed(seed)
    return g, seed


def _run_base(
    bundle: Dict[str, Any],
    mode: str,
    prompt: str,
    negative_prompt: Optional[str],
    width: int,
    height: int,
    num_inference_steps: int,
    guidance_scale: float,
    num_images_per_prompt: int,
    generator: Any,
    init_image: Optional[Image.Image],
    mask_image: Optional[Image.Image],
    strength: Optional[float],
    use_refiner: bool,
    refiner_denoising_end: Optional[float],
) -> List[Image.Image]:
    pipe = bundle["base"]

    common: Dict[str, Any] = {
        "prompt": prompt,
        "num_inference_steps": int(num_inference_steps),
        "guidance_scale": float(guidance_scale),
        "num_images_per_prompt": int(num_images_per_prompt),
        "generator": generator,
    }
    if negative_prompt:
        common["negative_prompt"] = negative_prompt

    if mode == "text_to_image":
        common["width"] = int(width)
        common["height"] = int(height)
        if use_refiner and "refiner" in bundle and refiner_denoising_end is not None:
            common["denoising_end"] = float(refiner_denoising_end)
            common["output_type"] = "latent"
    elif mode == "image_to_image":
        if init_image is None:
            raise ValueError("image_to_image requires init_image_url or init_image_b64")
        common["image"] = init_image
        if strength is not None:
            common["strength"] = float(strength)
    elif mode == "inpainting":
        if init_image is None:
            raise ValueError("inpainting requires init_image_url or init_image_b64")
        if mask_image is None:
            raise ValueError("inpainting requires mask_image_url or mask_image_b64")
        common["image"] = init_image
        common["mask_image"] = mask_image
        common["width"] = int(width)
        common["height"] = int(height)
        if strength is not None:
            common["strength"] = float(strength)

    out = pipe(**common)
    images_or_latents = out.images
    return list(images_or_latents)


def _run_refiner(
    bundle: Dict[str, Any],
    latents: List[Any],
    prompt: str,
    negative_prompt: Optional[str],
    num_inference_steps: int,
    guidance_scale: float,
    refiner_denoising_start: Optional[float],
    generator: Any,
) -> List[Image.Image]:
    refiner = bundle["refiner"]
    kwargs: Dict[str, Any] = {
        "prompt": prompt,
        "num_inference_steps": int(num_inference_steps),
        "guidance_scale": float(guidance_scale),
        "image": latents,
        "generator": generator,
    }
    if negative_prompt:
        kwargs["negative_prompt"] = negative_prompt
    if refiner_denoising_start is not None:
        kwargs["denoising_start"] = float(refiner_denoising_start)
    return list(refiner(**kwargs).images)




def process_prompt(
    bundle: Dict[str, Any],
    prompt: str,
    negative_prompt: Optional[str],
    mode: str,
    cfg: Dict[str, Any],
    init_image: Optional[Image.Image],
    mask_image: Optional[Image.Image],
) -> Dict[str, Any]:
    device = bundle["device"]

    seed_in = cfg.get("seed")
    seed_in = None if seed_in in (None, "", "random") else seed_in
    generator, seed_used = _make_generator(device, seed_in)

    width = int(cfg.get("width", 1024))
    height = int(cfg.get("height", 1024))
    steps = int(cfg.get("num_inference_steps", 30))
    guidance = float(cfg.get("guidance_scale", 7.0))
    n_per = int(cfg.get("num_images_per_prompt", 1))
    strength = cfg.get("strength")
    use_refiner = bool(cfg.get("use_refiner", False) and "refiner" in bundle)
    refiner_end = cfg.get("refiner_denoising_end", 0.8) if use_refiner else None
    refiner_start = cfg.get("refiner_denoising_start", 0.8) if use_refiner else None
    refiner_steps = int(cfg.get("refiner_num_inference_steps", steps))

    first = _run_base(
        bundle,
        mode,
        prompt,
        negative_prompt,
        width,
        height,
        steps,
        guidance,
        n_per,
        generator,
        init_image,
        mask_image,
        strength,
        use_refiner,
        refiner_end,
    )

    if use_refiner and "refiner" in bundle and refiner_end is not None:
        images = _run_refiner(
            bundle,
            first,
            prompt,
            negative_prompt,
            refiner_steps,
            guidance,
            refiner_start,
            generator,
        )
    else:
        images = first

    out_format = str(cfg.get("output_format", "png")).lower()
    jpeg_quality = int(cfg.get("jpeg_quality", 95))
    images_b64 = [encode_b64(img, out_format, jpeg_quality) for img in images]

    return {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "seed_used": seed_used,
        "images_b64": images_b64,
        "num_images": len(images_b64),
        "scheduler": type(bundle["base"].scheduler).__name__,
        "model": bundle["model"],
        "mode": mode,
        "width": width,
        "height": height,
        "num_inference_steps": steps,
        "guidance_scale": guidance,
        "output_format": out_format if out_format != "jpeg" else "jpg",
    }




def handler(event: Dict[str, Any]) -> Dict[str, Any]:
    inp = event.get("input") or {}

    prompts = collect_prompts(inp)
    if not prompts:
        return {"error": "Missing 'prompt' or 'prompts' in input."}

    task = inp.get("task", "text_to_image")
    if task not in ALLOWED_MODES:
        return {
            "error": f"unknown task '{task}'. allowed: {ALLOWED_MODES}"
        }

    model = inp.get("model", DEFAULT_MODEL)
    if model not in ALLOWED_MODELS and not ALLOW_ANY_HF_MODEL:
        return {
            "error": f"unknown model '{model}'. allowed: {ALLOWED_MODELS}"
        }

    refiner_model = inp.get("refiner_model")
    use_refiner = bool(inp.get("use_refiner", False))
    if use_refiner and not refiner_model:
        refiner_model = "stabilityai/stable-diffusion-xl-refiner-1.0"
    if refiner_model and refiner_model not in ALLOWED_MODELS and not ALLOW_ANY_HF_MODEL:
        return {
            "error": f"unknown refiner_model '{refiner_model}'. allowed: {ALLOWED_MODELS}"
        }

    scheduler = inp.get("scheduler")
    if scheduler is not None and scheduler not in ALLOWED_SCHEDULERS:
        return {
            "error": f"unknown scheduler '{scheduler}'. allowed: {ALLOWED_SCHEDULERS}"
        }

    output_format = str(inp.get("output_format", "png")).lower()
    if output_format == "jpeg":
        output_format = "jpg"
    if output_format not in ALLOWED_FORMATS:
        return {
            "error": f"unknown output_format '{output_format}'. allowed: {sorted(ALLOWED_FORMATS)}"
        }

    fp16 = bool(inp.get("fp16", True))

    try:
        bundle = get_pipeline(model, task, refiner_model if use_refiner else None, fp16)
    except Exception as e:
        return {"error": f"pipeline load failed: {e}"}

    try:
        active_scheduler = apply_scheduler(bundle["base"], scheduler)
        if "refiner" in bundle and scheduler:
            apply_scheduler(bundle["refiner"], scheduler)
    except Exception as e:
        return {"error": str(e)}

    lora_url = inp.get("lora_url")
    lora_scale = float(inp.get("lora_scale", 0.8))
    try:
        maybe_load_lora(bundle["base"], lora_url, lora_scale)
    except Exception as e:
        return {"error": f"lora load failed: {e}"}

    init_image: Optional[Image.Image] = None
    mask_image: Optional[Image.Image] = None
    try:
        if task in ("image_to_image", "inpainting"):
            init_image = _resolve_image_input(inp, "init_image_url", "init_image_b64")
            if init_image is None:
                return {
                    "error": (
                        f"{task} requires 'init_image_url' or 'init_image_b64'."
                    )
                }
        if task == "inpainting":
            mask_image = _resolve_mask(inp)
            if mask_image is None:
                return {
                    "error": "inpainting requires 'mask_image_url' or 'mask_image_b64'."
                }
    except Exception as e:
        return {"error": f"image input failed: {e}"}

    cfg: Dict[str, Any] = {
        "seed": inp.get("seed"),
        "width": inp.get("width", 1024),
        "height": inp.get("height", 1024),
        "num_inference_steps": inp.get("num_inference_steps", 30),
        "guidance_scale": inp.get("guidance_scale", 7.0),
        "num_images_per_prompt": inp.get("num_images_per_prompt", 1),
        "strength": inp.get("strength"),
        "use_refiner": use_refiner,
        "refiner_denoising_end": inp.get("refiner_denoising_end", 0.8),
        "refiner_denoising_start": inp.get("refiner_denoising_start", 0.8),
        "refiner_num_inference_steps": inp.get(
            "refiner_num_inference_steps", inp.get("num_inference_steps", 30)
        ),
        "output_format": output_format,
        "jpeg_quality": inp.get("jpeg_quality", 95),
    }

    negatives = collect_negative_prompts(inp, len(prompts))

    results: List[Dict[str, Any]] = []
    for prompt, neg in zip(prompts, negatives):
        try:
            r = process_prompt(
                bundle,
                prompt,
                neg,
                task,
                cfg,
                init_image,
                mask_image,
            )
        except Exception as e:
            r = {
                "prompt": prompt,
                "negative_prompt": neg,
                "error": str(e),
                "scheduler": active_scheduler,
                "model": model,
                "mode": task,
            }
        results.append(r)

    return {
        "results": results,
        "model": model,
        "refiner_model": refiner_model if use_refiner else None,
        "scheduler": active_scheduler,
        "task": task,
        "count": len(results),
        "lora_url": lora_url,
        "lora_scale": lora_scale if lora_url else None,
        "fp16": fp16,
        "defaults": {
            "output_format": output_format,
            "jpeg_quality": cfg["jpeg_quality"],
            "num_images_per_prompt": cfg["num_images_per_prompt"],
            "num_inference_steps": cfg["num_inference_steps"],
            "guidance_scale": cfg["guidance_scale"],
            "width": cfg["width"],
            "height": cfg["height"],
        },
    }


if runpod is not None:
    runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    if runpod is None:
        raise RuntimeError(
            "runpod is not installed; cannot start serverless worker."
        )
