# Caching Traps

- Request memoization solo dentro de UN request — no entre requests
- Solo GET memoiza — POST no, `cache: 'no-store'` desactiva todo
- Data cache persiste entre DEPLOYS — datos viejos sobreviven redeploy
- No hay forma de invalidar TODO el cache — solo por path/tag
- Rutas con `cookies()` o `headers()` NUNCA cachean — siempre dinámicas
- `searchParams` en page = ruta dinámica automáticamente
- Router cache 30s dinámicas, 5min estáticas — no configurable
- Back/forward SIEMPRE usa cache — aunque datos cambiaron
- `router.refresh()` no limpia router cache — solo re-fetch server components
- `revalidate: 60` fetch + `revalidate: 30` page = usa MENOR (30)
- Dev SIEMPRE no-cacheado — bugs de caché solo en producción
