# OpenAI (DALL-E 3 / GPT Image)

**Best for:** Text rendering, instruction following, editing

**API:** https://platform.openai.com/docs/guides/images

## Models

- `gpt-image-1` — Latest, multimodal, best instruction following
- `dall-e-3` — High quality, good text rendering
- `dall-e-2` — Faster, lower quality, supports editing

## Setup

```python
from openai import OpenAI
client = OpenAI()  # Uses OPENAI_API_KEY env var
```

## Text-to-Image (DALL-E 3)

```python
response = client.images.generate(
    model="dall-e-3",
    prompt="A white siamese cat wearing a beret",
    size="1024x1024",
    quality="hd",  # "standard" or "hd"
    n=1  # DALL-E 3 only supports n=1
)
image_url = response.data[0].url
```

## Image Editing (DALL-E 2)

```python
response = client.images.edit(
    model="dall-e-2",
    image=open("image.png", "rb"),
    mask=open("mask.png", "rb"),  # Transparent areas = edit zone
    prompt="A sunlit indoor lounge area with a pool",
    size="1024x1024",
    n=1
)
```

## Sizes

- DALL-E 3: 1024x1024, 1024x1792, 1792x1024
- DALL-E 2: 256x256, 512x512, 1024x1024

## Pricing

- DALL-E 3 HD 1024x1024: $0.080/image
- DALL-E 3 Standard: $0.040/image
- DALL-E 2 1024x1024: $0.020/image

## Tips

- DALL-E 3 rewrites prompts for safety — check `revised_prompt` in response
- Use `style="natural"` or `style="vivid"` to control output style
- For consistent characters, describe in extreme detail
