---
name: Image Generation
description: Create AI images with optimized prompts, style control, and production-ready output.
metadata: { "clawdbot": { "emoji": "🎨", "os": ["linux", "darwin", "win32"] } }
---

# AI Image Generation

Help users create and refine AI-generated images.

**Rules:**

- Ask what they want: text-to-image, image editing, style transfer, or upscaling
- Check provider files for setup: `openai.md`, `midjourney.md`, `stable-diffusion.md`, `flux.md`, `leonardo.md`, `ideogram.md`, `replicate.md`
- Check `api-patterns.md` for async handling and best practices
- Check `prompting.md` for prompt engineering techniques
- Start with draft resolution to validate prompt before upscaling

---

## Provider Selection

| Use Case                    | Recommended                |
| --------------------------- | -------------------------- |
| Photorealism, product shots | Midjourney, Flux Pro       |
| Text rendering in images    | Ideogram, DALL-E 3         |
| Fast iteration, API access  | Flux Schnell, Leonardo     |
| Maximum control, local      | Stable Diffusion           |
| Editing, inpainting         | DALL-E 3, Stable Diffusion |
| Cost-effective API          | Replicate, Leonardo        |

---

## Prompting Fundamentals

- **Subject first** — "A red fox" not "In the forest there is a red fox"
- **Style keywords** — "cinematic lighting", "studio photography", "oil painting"
- **Negative prompts** — exclude unwanted elements (supported by SD, Midjourney)
- **Aspect ratio matters** — 1:1 portraits, 16:9 landscapes, 9:16 mobile
- **Be specific** — "golden hour sunlight" not just "good lighting"

---

## Resolution & Formats

- **Draft:** 512x512 or 1024x1024 for iteration
- **Production:** 2048x2048 or higher
- **Upscaling:** Use dedicated upscalers (Real-ESRGAN, Topaz) for final output
- **Formats:** PNG for transparency, JPEG for photos, WebP for web

---

## Common Workflows

### Text-to-Image

1. Write detailed prompt with style keywords
2. Generate 4+ variations at draft resolution
3. Select best, regenerate with variations
4. Upscale winner to production resolution

### Image Editing

1. Provide source image + mask (if inpainting)
2. Describe desired changes
3. Use img2img strength 0.3-0.7 (lower = closer to original)

### Style Transfer

1. Provide reference image for style
2. Describe subject/content separately
3. Adjust style strength per provider

---

## Cost Optimization

- Draft at lowest resolution first
- Batch similar prompts
- Use fast models for iteration (Flux Schnell, SDXL Turbo)
- Switch to quality models only for finals
- Cache and reuse seeds for consistent characters

---

## Failure Modes

- **Hands/fingers wrong** — regenerate or use inpainting to fix
- **Text garbled** — use Ideogram or add text in post-production
- **Faces distorted** — add "detailed face" to prompt, use face-fix models
- **Style inconsistent** — lock seed, use reference images
- **Watermarks appearing** — check model training, use clean models

---

### Current Setup

<!-- Provider: status -->

### Projects

<!-- What they're creating -->

### Preferences

<!-- Settings that work: model, style, resolution -->

---

_Empty sections = not configured yet. Check provider files for setup._
