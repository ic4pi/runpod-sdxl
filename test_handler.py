"""Smoke tests for handler.py — runnable WITHOUT diffusers / transformers / torch.

Strategy:
  - Inject fake `torch`, `diffusers`, `transformers`, and `runpod` modules into
    sys.modules BEFORE importing the handler. The fakes provide just enough
    surface area for the handler to load and run end-to-end.
  - Fake pipelines accept the documented kwargs and return small PIL images
    of the right size, so the wrapping logic, scheduler swap, LoRA load,
    seed handling, refiner pass, batch dispatch, and output encoding are
    all exercised — without any GPU or model downloads.

Run with:
    python3 test_handler.py

Expected to end with "ALL TESTS PASSED".
"""
from __future__ import annotations

import base64
import io
import os
import sys
import time
import traceback
import types
from typing import Any, Dict, List, Optional, Tuple




def _install_fake_torch() -> None:
    torch_mod = types.ModuleType("torch")

    class _Generator:
        def __init__(self, device: Optional[str] = None):
            self.device = device or "cpu"
            self._seed = 0

        def manual_seed(self, seed: int) -> "_Generator":
            self._seed = int(seed)
            return self

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

    class _Mps:
        @staticmethod
        def is_available() -> bool:
            return False

    backends = types.SimpleNamespace(mps=_Mps())

    torch_mod.Generator = _Generator
    torch_mod.cuda = _Cuda()
    torch_mod.backends = backends
    torch_mod.float16 = "float16"
    torch_mod.float32 = "float32"
    torch_mod.float = "float32"
    torch_mod.bfloat16 = "bfloat16"

    class dtype:
        pass

    torch_mod.dtype = dtype
    sys.modules["torch"] = torch_mod




def _install_fake_transformers() -> None:
    mod = types.ModuleType("transformers")
    mod.__version__ = "0.0.0-fake"
    sys.modules["transformers"] = mod




_FAKE_DIFFUSERS_CALLS: Dict[str, List[Any]] = {
    "from_pretrained": [],
    "pipe_call": [],
    "scheduler_set": [],
    "load_lora_weights": [],
    "unload_lora_weights": [],
    "fuse_lora": [],
    "set_adapters": [],
}


class _FakeSchedulerConfig(dict):
    pass


class _FakeScheduler:
    def __init__(self, name: str = "DDIM"):
        self.name = name
        self.config = _FakeSchedulerConfig({"_class_name": name})

    @classmethod
    def from_config(cls, cfg: Any) -> "_FakeScheduler":
        instance = cls.__new__(cls)
        instance.name = cls.__name__
        instance.config = cfg if isinstance(cfg, dict) else _FakeSchedulerConfig()
        return instance


def _scheduler_factory(name: str):
    cls = type(name, (_FakeScheduler,), {})
    return cls


_FAKE_SCHEDULERS = {
    n: _scheduler_factory(n + "Scheduler")
    for n in [
        "DPMSolverMultistep",
        "EulerDiscrete",
        "EulerAncestralDiscrete",
        "DDIM",
        "DDPM",
        "UniPCMultistep",
        "DEISMultistep",
    ]
}
_FAKE_SCHEDULERS["LCM"] = _scheduler_factory("LCMScheduler")


class _FakeImage:
    """Lightweight stand-in returned by the fake pipeline (not a real PIL Image).
    The handler will call encode_b64 on it via PIL — we wrap a real PIL Image
    in the result instead. See _make_pil_white below.
    """

    pass


def _make_pil_white(width: int, height: int):
    from PIL import Image

    return Image.new("RGB", (int(width), int(height)), (200, 220, 250))


class _FakeOutput:
    def __init__(self, images: List[Any]):
        self.images = images


class _BaseFakePipeline:
    """Common fake pipeline behavior: scheduler attr, lora hooks, callable."""

    PIPE_TYPE = "base"

    def __init__(self, model: str, dtype: Any):
        self.model = model
        self.dtype = dtype
        self.scheduler = _FakeSchedulerConfig({"_class_name": "DDIMScheduler"})
        self.scheduler = type(
            "DDIMScheduler",
            (_FakeScheduler,),
            {},
        )()
        self.scheduler.config = _FakeSchedulerConfig()
        self._device = "cpu"
        self._loras: List[str] = []

    @classmethod
    def from_pretrained(cls, model_id: str, **kwargs):
        _FAKE_DIFFUSERS_CALLS["from_pretrained"].append(
            {"cls": cls.__name__, "model": model_id, "kwargs": kwargs}
        )
        return cls(model_id, kwargs.get("torch_dtype"))

    def to(self, device: str):
        self._device = device
        return self

    def enable_vae_slicing(self):
        return None

    def enable_vae_tiling(self):
        return None

    def load_lora_weights(self, path_or_repo: str, **kw):
        _FAKE_DIFFUSERS_CALLS["load_lora_weights"].append(path_or_repo)
        self._loras.append(path_or_repo)

    def unload_lora_weights(self):
        _FAKE_DIFFUSERS_CALLS["unload_lora_weights"].append(True)
        self._loras.clear()

    def fuse_lora(self, lora_scale: float = 1.0):
        _FAKE_DIFFUSERS_CALLS["fuse_lora"].append(lora_scale)

    def set_adapters(self, names, adapter_weights=None):
        _FAKE_DIFFUSERS_CALLS["set_adapters"].append((names, adapter_weights))

    def __call__(self, **kwargs):
        _FAKE_DIFFUSERS_CALLS["pipe_call"].append(
            {"cls": type(self).__name__, "kwargs": {k: kwargs.get(k) for k in (
                "prompt", "negative_prompt", "num_inference_steps",
                "guidance_scale", "num_images_per_prompt", "width", "height",
                "strength", "denoising_end", "denoising_start",
                "output_type",
            )}}
        )

        width = int(kwargs.get("width") or 1024)
        height = int(kwargs.get("height") or 1024)
        n = int(kwargs.get("num_images_per_prompt") or 1)

        img_in = kwargs.get("image")
        if img_in is not None:
            try:
                if hasattr(img_in, "size"):
                    width, height = img_in.size
                elif isinstance(img_in, list) and img_in and hasattr(img_in[0], "size"):
                    width, height = img_in[0].size
            except Exception:
                pass

        images = [_make_pil_white(width, height) for _ in range(n)]
        return _FakeOutput(images)


class _FakeSDXLPipeline(_BaseFakePipeline):
    PIPE_TYPE = "text_to_image"


class _FakeSDXLImg2ImgPipeline(_BaseFakePipeline):
    PIPE_TYPE = "image_to_image"


class _FakeSDXLInpaintPipeline(_BaseFakePipeline):
    PIPE_TYPE = "inpainting"


def _install_fake_diffusers() -> None:
    mod = types.ModuleType("diffusers")
    mod.StableDiffusionXLPipeline = _FakeSDXLPipeline
    mod.StableDiffusionXLImg2ImgPipeline = _FakeSDXLImg2ImgPipeline
    mod.StableDiffusionXLInpaintPipeline = _FakeSDXLInpaintPipeline
    mod.DPMSolverMultistepScheduler = _FAKE_SCHEDULERS["DPMSolverMultistep"]
    mod.EulerDiscreteScheduler = _FAKE_SCHEDULERS["EulerDiscrete"]
    mod.EulerAncestralDiscreteScheduler = _FAKE_SCHEDULERS["EulerAncestralDiscrete"]
    mod.DDIMScheduler = _FAKE_SCHEDULERS["DDIM"]
    mod.DDPMScheduler = _FAKE_SCHEDULERS["DDPM"]
    mod.UniPCMultistepScheduler = _FAKE_SCHEDULERS["UniPCMultistep"]
    mod.DEISMultistepScheduler = _FAKE_SCHEDULERS["DEISMultistep"]
    mod.LCMScheduler = _FAKE_SCHEDULERS["LCM"]
    mod.__version__ = "0.0.0-fake"
    sys.modules["diffusers"] = mod




def _install_fake_runpod() -> None:
    if "runpod" in sys.modules:
        return
    rp = types.ModuleType("runpod")
    serverless = types.ModuleType("runpod.serverless")

    def _start(_cfg):
        return None

    serverless.start = _start
    rp.serverless = serverless
    sys.modules["runpod"] = rp
    sys.modules["runpod.serverless"] = serverless


_install_fake_torch()
_install_fake_transformers()
_install_fake_diffusers()
_install_fake_runpod()


import handler as H




_FAILURES: List[str] = []


def _section(title: str) -> None:
    print(f"\n=== {title} ===")


def _check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS {name}")
    else:
        msg = f"  FAIL {name}: {detail}" if detail else f"  FAIL {name}"
        print(msg)
        _FAILURES.append(name)


def _reset_caches() -> None:
    H._PIPE_CACHE.clear()
    H._LORA_LOADED_FOR.clear()
    for k in _FAKE_DIFFUSERS_CALLS:
        _FAKE_DIFFUSERS_CALLS[k].clear()


def _b64_png(width: int = 32, height: int = 32, color=(120, 80, 200)) -> str:
    from PIL import Image

    im = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")




def test_constants_present():
    _section("constants — allowed lists exposed")
    _check("ALLOWED_MODELS non-empty", isinstance(H.ALLOWED_MODELS, list) and len(H.ALLOWED_MODELS) >= 6)
    _check("ALLOWED_SCHEDULERS has 8", len(H.ALLOWED_SCHEDULERS) == 8, str(H.ALLOWED_SCHEDULERS))
    _check("ALLOWED_MODES has 3", len(H.ALLOWED_MODES) == 3, str(H.ALLOWED_MODES))
    _check("ALLOWED_FORMATS includes png", "png" in H.ALLOWED_FORMATS)


def test_collect_prompts():
    _section("collect_prompts — string vs list")
    _check(
        "single prompt",
        H.collect_prompts({"prompt": "hello"}) == ["hello"],
    )
    _check(
        "prompts list (3)",
        H.collect_prompts({"prompts": ["a", "b", "c"]}) == ["a", "b", "c"],
    )
    _check(
        "empty inputs -> []",
        H.collect_prompts({}) == [],
    )
    _check(
        "empty-string prompt filtered",
        H.collect_prompts({"prompt": "   "}) == [],
    )
    _check(
        "prompts list skips blanks",
        H.collect_prompts({"prompts": ["x", "", "y", "  "]}) == ["x", "y"],
    )
    _check(
        "prompts list wins over prompt",
        H.collect_prompts({"prompt": "single", "prompts": ["a", "b"]}) == ["a", "b"],
    )


def test_collect_negative_prompts():
    _section("collect_negative_prompts — alignment")
    inp = {"negative_prompt": "bad"}
    _check(
        "string broadcast",
        H.collect_negative_prompts(inp, 3) == ["bad", "bad", "bad"],
    )
    inp = {"negative_prompts": ["x", "y"]}
    out = H.collect_negative_prompts(inp, 3)
    _check(
        "list aligned + padded with None",
        out == ["x", "y", None],
        str(out),
    )
    out = H.collect_negative_prompts({}, 2)
    _check("no negatives -> [None, None]", out == [None, None])


def test_handler_missing_input():
    _section("handler — missing prompt returns error")
    _reset_caches()
    out = H.handler({"input": {}})
    _check("error key present", "error" in out, str(out))
    _check(
        "error mentions prompt",
        "prompt" in out.get("error", "").lower(),
        out.get("error", ""),
    )


def test_handler_unknown_model():
    _section("handler — unknown model rejected")
    _reset_caches()
    out = H.handler({"input": {"prompt": "x", "model": "fake/not-a-model"}})
    _check("error key present", "error" in out, str(out))
    _check("error mentions model", "model" in out.get("error", "").lower(), out.get("error", ""))


def test_handler_unknown_scheduler():
    _section("handler — unknown scheduler rejected")
    _reset_caches()
    out = H.handler({"input": {"prompt": "x", "scheduler": "NotAScheduler"}})
    _check("error present", "error" in out, str(out))
    _check(
        "error mentions scheduler",
        "scheduler" in out.get("error", "").lower(),
        out.get("error", ""),
    )


def test_handler_unknown_task():
    _section("handler — unknown task rejected")
    _reset_caches()
    out = H.handler({"input": {"prompt": "x", "task": "stretch_to_image"}})
    _check("error present", "error" in out, str(out))
    _check(
        "error mentions task",
        "task" in out.get("error", "").lower(),
        out.get("error", ""),
    )


def test_text_to_image_end_to_end():
    _section("end-to-end — text_to_image mocked")
    _reset_caches()
    out = H.handler(
        {
            "input": {
                "prompt": "a cat painted in the style of monet",
                "negative_prompt": "ugly, blurry",
                "width": 512,
                "height": 512,
                "num_inference_steps": 20,
                "guidance_scale": 7.5,
                "seed": 1234,
                "scheduler": "EulerAncestralDiscrete",
            }
        }
    )

    _check("results length 1", len(out.get("results", [])) == 1, str(out)[:300])
    r = out["results"][0]
    _check("no top-level error", "error" not in out, str(out)[:300])
    _check("no per-prompt error", "error" not in r, str(r)[:300])
    _check("images_b64 non-empty", isinstance(r.get("images_b64"), list) and len(r["images_b64"]) >= 1)
    _check("prompt echoed", r.get("prompt") == "a cat painted in the style of monet")
    _check(
        "seed_used == 1234",
        r.get("seed_used") == 1234,
        str(r.get("seed_used")),
    )
    _check(
        "scheduler name reflects swap",
        r.get("scheduler") == "EulerAncestralDiscreteScheduler",
        str(r.get("scheduler")),
    )
    _check("model echoed", r.get("model") == H.DEFAULT_MODEL, str(r.get("model")))
    _check("count == 1", out.get("count") == 1)

    from PIL import Image

    decoded = base64.b64decode(r["images_b64"][0])
    with Image.open(io.BytesIO(decoded)) as im:
        _check("decoded image size 512x512", im.size == (512, 512), str(im.size))


def test_batch_prompts():
    _section("end-to-end — batch prompts")
    _reset_caches()
    out = H.handler(
        {
            "input": {
                "prompts": ["foo", "bar", "baz"],
                "width": 256,
                "height": 256,
                "num_inference_steps": 5,
                "seed": 7,
            }
        }
    )
    _check("three results", len(out.get("results", [])) == 3, str(len(out.get("results", []))))
    for i, r in enumerate(out["results"]):
        _check(
            f"result[{i}] has images_b64",
            isinstance(r.get("images_b64"), list) and len(r["images_b64"]) == 1,
            str(r),
        )
    seeds = [r.get("seed_used") for r in out["results"]]
    _check("all seeds == 7 (broadcast)", seeds == [7, 7, 7], str(seeds))


def test_num_images_per_prompt():
    _section("num_images_per_prompt > 1")
    _reset_caches()
    out = H.handler(
        {
            "input": {
                "prompt": "anything",
                "num_images_per_prompt": 3,
                "width": 256,
                "height": 256,
                "seed": 99,
            }
        }
    )
    r = out["results"][0]
    _check(
        "3 images returned per prompt",
        len(r.get("images_b64", [])) == 3,
        str(len(r.get("images_b64", []))),
    )
    _check("num_images echoed", r.get("num_images") == 3, str(r.get("num_images")))


def test_image_to_image():
    _section("end-to-end — image_to_image with fake init image")
    _reset_caches()
    init_b64 = _b64_png(64, 64)
    out = H.handler(
        {
            "input": {
                "task": "image_to_image",
                "prompt": "turn this into a watercolor",
                "init_image_b64": init_b64,
                "strength": 0.6,
                "num_inference_steps": 15,
                "seed": 1,
            }
        }
    )
    _check("no error", "error" not in out, str(out)[:300])
    r = out["results"][0]
    _check("mode == image_to_image", r.get("mode") == "image_to_image", str(r.get("mode")))
    _check("images_b64 present", len(r.get("images_b64", [])) == 1, str(r.get("images_b64", [])))

    pipe_calls = _FAKE_DIFFUSERS_CALLS["pipe_call"]
    _check("pipeline called once", len(pipe_calls) == 1, str(len(pipe_calls)))
    _check("strength forwarded", pipe_calls[0]["kwargs"].get("strength") == 0.6, str(pipe_calls[0]))


def test_inpainting():
    _section("end-to-end — inpainting with fake init + mask")
    _reset_caches()
    init_b64 = _b64_png(64, 64, (255, 0, 0))
    mask_b64 = _b64_png(64, 64, (0, 0, 0))
    out = H.handler(
        {
            "input": {
                "task": "inpainting",
                "prompt": "replace with a red apple",
                "init_image_b64": init_b64,
                "mask_image_b64": mask_b64,
                "width": 64,
                "height": 64,
                "num_inference_steps": 10,
                "seed": 1,
            }
        }
    )
    _check("no error", "error" not in out, str(out)[:300])
    r = out["results"][0]
    _check("mode == inpainting", r.get("mode") == "inpainting", str(r.get("mode")))
    _check("images_b64 present", len(r.get("images_b64", [])) == 1)


def test_inpainting_missing_mask():
    _section("inpainting — missing mask returns error")
    _reset_caches()
    init_b64 = _b64_png(32, 32)
    out = H.handler(
        {
            "input": {
                "task": "inpainting",
                "prompt": "x",
                "init_image_b64": init_b64,
            }
        }
    )
    _check("error present", "error" in out, str(out))
    _check(
        "error mentions mask",
        "mask" in out.get("error", "").lower(),
        out.get("error", ""),
    )


def test_img2img_missing_init():
    _section("img2img — missing init image returns error")
    _reset_caches()
    out = H.handler(
        {
            "input": {
                "task": "image_to_image",
                "prompt": "x",
            }
        }
    )
    _check("error present", "error" in out, str(out))
    _check(
        "error mentions init_image",
        "init_image" in out.get("error", "").lower(),
        out.get("error", ""),
    )


def test_seed_determinism_documented():
    _section("seed determinism — same seed produces same recorded seed_used")
    _reset_caches()
    out1 = H.handler({"input": {"prompt": "x", "seed": 314, "width": 64, "height": 64}})
    out2 = H.handler({"input": {"prompt": "x", "seed": 314, "width": 64, "height": 64}})
    s1 = out1["results"][0]["seed_used"]
    s2 = out2["results"][0]["seed_used"]
    _check("seed_used == 314 (run 1)", s1 == 314, str(s1))
    _check("seed_used == 314 (run 2)", s2 == 314, str(s2))
    _check("seeds match", s1 == s2)


def test_random_seed_generated():
    _section("seed=None -> random seed is generated and surfaced")
    _reset_caches()
    out = H.handler({"input": {"prompt": "x", "width": 64, "height": 64}})
    r = out["results"][0]
    _check(
        "seed_used is an int",
        isinstance(r.get("seed_used"), int),
        str(type(r.get("seed_used"))),
    )
    _check("seed_used >= 0", r.get("seed_used") >= 0)


def test_pipeline_cache_reuse():
    _section("pipeline cache — same (model,mode,refiner,fp16) reused")
    _reset_caches()
    H.handler({"input": {"prompt": "a", "width": 64, "height": 64, "seed": 1}})
    H.handler({"input": {"prompt": "b", "width": 64, "height": 64, "seed": 2}})
    loads = [c for c in _FAKE_DIFFUSERS_CALLS["from_pretrained"]]
    _check("from_pretrained called exactly once for base", len(loads) == 1, str(loads))


def test_with_refiner():
    _section("end-to-end — refiner pass loaded and called")
    _reset_caches()
    out = H.handler(
        {
            "input": {
                "prompt": "a futuristic city",
                "use_refiner": True,
                "refiner_model": "stabilityai/stable-diffusion-xl-refiner-1.0",
                "num_inference_steps": 20,
                "refiner_num_inference_steps": 20,
                "refiner_denoising_end": 0.8,
                "refiner_denoising_start": 0.8,
                "width": 256,
                "height": 256,
                "seed": 3,
            }
        }
    )
    _check("no error", "error" not in out, str(out)[:300])
    pipe_calls = _FAKE_DIFFUSERS_CALLS["pipe_call"]
    _check(
        "pipeline called twice (base + refiner)",
        len(pipe_calls) == 2,
        str(len(pipe_calls)),
    )
    _check(
        "base call used output_type=latent",
        pipe_calls[0]["kwargs"].get("output_type") == "latent",
        str(pipe_calls[0]["kwargs"]),
    )
    _check(
        "refiner_model echoed",
        out.get("refiner_model") == "stabilityai/stable-diffusion-xl-refiner-1.0",
        str(out.get("refiner_model")),
    )


def test_lora_url():
    _section("end-to-end — LoRA load via HF repo id")
    _reset_caches()
    out = H.handler(
        {
            "input": {
                "prompt": "a pixel art knight",
                "lora_url": "nerijs/pixel-art-xl",
                "lora_scale": 0.85,
                "width": 64,
                "height": 64,
                "seed": 1,
            }
        }
    )
    _check("no error", "error" not in out, str(out)[:300])
    _check(
        "load_lora_weights called",
        len(_FAKE_DIFFUSERS_CALLS["load_lora_weights"]) == 1,
        str(_FAKE_DIFFUSERS_CALLS["load_lora_weights"]),
    )
    _check(
        "fuse_lora called with scale 0.85",
        0.85 in _FAKE_DIFFUSERS_CALLS["fuse_lora"],
        str(_FAKE_DIFFUSERS_CALLS["fuse_lora"]),
    )
    _check("lora_url echoed", out.get("lora_url") == "nerijs/pixel-art-xl")


def test_output_format_jpg():
    _section("output_format jpg — header is JPEG")
    _reset_caches()
    out = H.handler(
        {
            "input": {
                "prompt": "x",
                "output_format": "jpg",
                "jpeg_quality": 80,
                "width": 64,
                "height": 64,
                "seed": 1,
            }
        }
    )
    r = out["results"][0]
    _check("output_format jpg echoed", r.get("output_format") == "jpg", str(r.get("output_format")))
    raw = base64.b64decode(r["images_b64"][0])
    _check("decoded bytes start with JPEG SOI marker", raw[:2] == b"\xff\xd8", repr(raw[:4]))


def test_per_prompt_error_capture():
    _section("per-prompt error capture in batch")
    _reset_caches()

    out_first = H.handler({"input": {"prompt": "warmup", "seed": 1, "width": 64, "height": 64}})
    _check("warmup ok", "error" not in out_first, str(out_first)[:200])

    bundle = list(H._PIPE_CACHE.values())[0]
    pipe = bundle["base"]
    pipe_cls = type(pipe)
    original_call = pipe_cls.__call__
    state = {"n": 0}

    def flaky(self, **kwargs):
        state["n"] += 1
        if state["n"] == 2:
            raise RuntimeError("simulated oom on prompt 2")
        return original_call(self, **kwargs)

    pipe_cls.__call__ = flaky

    try:
        out = H.handler(
            {
                "input": {
                    "prompts": ["alpha", "beta", "gamma"],
                    "width": 64,
                    "height": 64,
                    "seed": 11,
                }
            }
        )
    finally:
        pipe_cls.__call__ = original_call

    rs = out["results"]
    _check("three results", len(rs) == 3, str(len(rs)))
    _check("prompt 0 ok", "images_b64" in rs[0] and "error" not in rs[0], str(rs[0])[:200])
    _check(
        "prompt 1 captured error",
        "error" in rs[1] and "simulated oom" in rs[1]["error"],
        str(rs[1])[:200],
    )
    _check("prompt 2 ok", "images_b64" in rs[2] and "error" not in rs[2], str(rs[2])[:200])




def main():
    started = time.time()
    suites = [
        test_constants_present,
        test_collect_prompts,
        test_collect_negative_prompts,
        test_handler_missing_input,
        test_handler_unknown_model,
        test_handler_unknown_scheduler,
        test_handler_unknown_task,
        test_text_to_image_end_to_end,
        test_batch_prompts,
        test_num_images_per_prompt,
        test_image_to_image,
        test_inpainting,
        test_inpainting_missing_mask,
        test_img2img_missing_init,
        test_seed_determinism_documented,
        test_random_seed_generated,
        test_pipeline_cache_reuse,
        test_with_refiner,
        test_lora_url,
        test_output_format_jpg,
        test_per_prompt_error_capture,
    ]
    for fn in suites:
        try:
            fn()
        except Exception:
            print(f"  FAIL {fn.__name__} raised:")
            traceback.print_exc()
            _FAILURES.append(fn.__name__)

    dur = time.time() - started
    print(f"\n--- Done in {dur:.1f}s — {len(_FAILURES)} failure(s) ---")
    if _FAILURES:
        for f in _FAILURES:
            print(f"  FAIL {f}")
        sys.exit(1)
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
