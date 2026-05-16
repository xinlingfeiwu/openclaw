# API Patterns (All Providers)

Common patterns for image generation APIs.

## Sync vs Async

**Synchronous (blocking):**

- OpenAI, some Replicate calls
- Returns image directly
- Simpler but can timeout on slow generations

**Asynchronous (polling):**

- Leonardo, most production APIs
- Submit job → get ID → poll until complete
- Required for reliability at scale

## Polling Pattern

```python
import time
import requests

def wait_for_image(job_id, api_key, max_wait=120):
    for _ in range(max_wait // 2):
        resp = requests.get(
            f"https://api.provider.com/generations/{job_id}",
            headers={"Authorization": f"Bearer {api_key}"}
        )
        result = resp.json()
        if result["status"] == "COMPLETE":
            return result["images"]
        if result["status"] == "FAILED":
            raise Exception(result.get("error", "Generation failed"))
        time.sleep(2)
    raise TimeoutError("Generation timed out")
```

## Webhook Pattern

```python
# Submit with webhook
response = requests.post(
    "https://api.provider.com/generate",
    json={
        "prompt": "...",
        "webhook_url": "https://your-server.com/callback"
    }
)

# Your webhook receives:
# POST /callback
# {"job_id": "xxx", "status": "complete", "images": [...]}
```

## Error Handling

```python
try:
    result = generate_image(prompt)
except RateLimitError:
    time.sleep(60)
    result = generate_image(prompt)
except ContentPolicyError:
    # Prompt was flagged
    result = generate_image(sanitize_prompt(prompt))
except TimeoutError:
    # Try with simpler prompt or different model
    pass
```

## Batch Processing

```python
import asyncio

async def generate_batch(prompts, max_concurrent=5):
    semaphore = asyncio.Semaphore(max_concurrent)

    async def generate_one(prompt):
        async with semaphore:
            return await async_generate(prompt)

    return await asyncio.gather(*[generate_one(p) for p in prompts])
```

## Caching Results

- Store images locally after generation
- Use content-hash as filename for deduplication
- Cache prompt → result mapping for identical prompts
- APIs may provide temporary URLs (download immediately)

## Cost Tracking

```python
# Track per-generation costs
costs = {
    "dalle3_hd": 0.08,
    "dalle3_standard": 0.04,
    "sdxl": 0.01,
    "flux_schnell": 0.003
}

def track_generation(model, count=1):
    cost = costs.get(model, 0.05) * count
    log_cost(model, cost)
    return cost
```

## Comparison Table

| Provider   | Sync/Async | Webhook | Batch | Avg Time |
| ---------- | ---------- | ------- | ----- | -------- |
| OpenAI     | Sync       | ❌      | ❌    | 10-20s   |
| Leonardo   | Async      | ✅      | ✅    | 15-30s   |
| Replicate  | Both       | ✅      | ✅    | 5-30s    |
| Midjourney | N/A        | ❌      | ❌    | 30-60s   |
| Flux API   | Async      | ✅      | ✅    | 5-15s    |
