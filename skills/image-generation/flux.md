# Flux (Black Forest Labs)

**Best for:** Photorealism, prompt adherence, fast generation

**API:** https://docs.bfl.ai/

## Models

- **Flux Pro** — Best quality, API only
- **Flux Dev** — High quality, non-commercial license
- **Flux Schnell** — 1-4 steps, Apache 2.0 license, fastest

## Setup (Local - Diffusers)

```bash
pip install diffusers transformers accelerate sentencepiece
```

## Quick Start (Flux Schnell)

```python
import torch
from diffusers import FluxPipeline

pipe = FluxPipeline.from_pretrained(
    "black-forest-labs/FLUX.1-schnell",
    torch_dtype=torch.bfloat16
)
pipe.enable_model_cpu_offload()

image = pipe(
    prompt="A cat holding a sign that says hello world",
    height=1024,
    width=1024,
    guidance_scale=0,  # Schnell doesn't use guidance
    num_inference_steps=4,
    max_sequence_length=256
).images[0]

image.save("flux-output.png")
```

## Quick Start (Flux Dev)

```python
pipe = FluxPipeline.from_pretrained(
    "black-forest-labs/FLUX.1-dev",
    torch_dtype=torch.bfloat16
)
pipe.to("cuda")

image = pipe(
    prompt="A detailed portrait of an astronaut",
    height=1024,
    width=1024,
    guidance_scale=3.5,
    num_inference_steps=50,
    max_sequence_length=512
).images[0]
```

## BFL API (Flux Pro)

```bash
curl -X POST https://api.bfl.ai/v1/image \
  -H "Authorization: Bearer $BFL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A serene mountain landscape",
    "width": 1024,
    "height": 1024
  }'
```

## Requirements

- Schnell: 12GB+ VRAM
- Dev: 24GB+ VRAM (or CPU offload with 16GB)

## Pricing (API)

- Flux Pro: ~$0.05/image
- Via Replicate/fal.ai: varies

## Tips

- Flux excels at text in images
- Schnell is best for rapid iteration
- Dev/Pro for final production quality
- Use longer prompts for better results (up to 512 tokens)
