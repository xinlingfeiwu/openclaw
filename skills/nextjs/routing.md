# Routing Traps

- `loading.tsx` NO aplica al primer render — solo navegaciones subsecuentes
- `error.tsx` no captura errores en `layout.tsx` mismo nivel — un nivel arriba
- Renombrar carpeta no actualiza caché — borrar `.next` manualmente
- `@modal` sin `default.tsx` = crash en navegación directa
- Slots no matcheados devuelven `null` silenciosamente — no error
- `(.)photo` intercepta solo desde MISMO nivel — no subdirectorios
- Hard refresh siempre muestra ruta original, no interceptada
- `<Link>` prefetch en viewport por defecto — puede causar cientos de requests
- `prefetch={false}` no desactiva completamente — hover prefetcha
- `router.push` no espera navegación complete — fire-and-forget
- `router.refresh()` no recarga página — solo revalida server components
- `redirect()` en try/catch se captura como error — NEXT_REDIRECT
- `[...slug]` NO matchea ruta vacía — usar `[[...slug]]` opcional
- Params siempre strings — `[id]` recibe `"123"` no `123`
