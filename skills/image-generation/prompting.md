# Image Prompting Guide

Techniques for writing effective image generation prompts.

## Prompt Structure

**Basic formula:**

```
[Subject] + [Style] + [Lighting] + [Composition] + [Quality modifiers]
```

**Example:**

```
A red fox in a snowy forest, digital art style, golden hour lighting,
close-up portrait, highly detailed, 8k resolution
```

## Subject Description

- Start with the main subject
- Be specific: "a tabby cat" not "a cat"
- Include pose/action: "sitting", "running", "looking at camera"
- Describe clothing/accessories if relevant

## Style Keywords

**Art Styles:**

- photorealistic, hyperrealistic
- digital art, concept art
- oil painting, watercolor
- anime, manga style
- 3D render, CGI

**Photography Styles:**

- portrait photography
- street photography
- product photography
- macro photography
- cinematic still

**Artist References:**

- "in the style of [artist]"
- "inspired by Studio Ghibli"
- "art nouveau style"

## Lighting

- golden hour, sunset lighting
- studio lighting, soft box
- dramatic lighting, chiaroscuro
- neon lighting, cyberpunk
- natural light, overcast
- backlit, rim lighting

## Composition

- close-up, extreme close-up
- full body shot
- wide angle, panoramic
- bird's eye view, top down
- low angle, worm's eye view
- rule of thirds

## Quality Modifiers

**Positive:**

- highly detailed, intricate details
- sharp focus, crisp
- 8k, 4k resolution
- professional photography
- award winning

**Avoid (often overused):**

- "beautiful" (too vague)
- "amazing" (doesn't help)
- "perfect" (triggers nothing specific)

## Negative Prompts

Tell the model what to avoid:

```
Negative: blurry, low quality, distorted, disfigured,
bad anatomy, wrong proportions, watermark, signature,
text, logo, ugly, duplicate, morbid, mutilated
```

**Per-model support:**

- Stable Diffusion: Full support
- Midjourney: `--no [element]`
- DALL-E: Not supported
- Flux: Limited support

## Prompt Length

| Model            | Optimal Length   |
| ---------------- | ---------------- |
| DALL-E 3         | 20-100 words     |
| Midjourney       | 20-60 words      |
| Stable Diffusion | 75-150 tokens    |
| Flux             | Up to 512 tokens |

Longer isn't always better — be concise and specific.

## Weights & Emphasis

**Stable Diffusion / ComfyUI:**

```
(important element:1.5)  # More weight
[less important:0.5]     # Less weight
```

**Midjourney:**

```
element:: 2  # Double weight
```

## Seeds for Consistency

Lock the seed to reproduce results:

- Same seed + same prompt = same image
- Useful for character consistency
- Change seed to explore variations

## Iterative Refinement

1. Start with simple prompt
2. Generate, evaluate
3. Add specificity where needed
4. Remove elements that don't help
5. Repeat until satisfied

## Common Mistakes

- **Too vague:** "a nice picture" → "a serene lake at sunset, reflection"
- **Too long:** Models ignore later tokens
- **Conflicting styles:** "realistic anime" confuses models
- **Missing context:** "a person" → "a young woman with red hair, wearing..."
- **Overloading:** Too many concepts compete for attention
