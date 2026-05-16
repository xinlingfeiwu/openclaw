# Deployment Traps

- `output: 'standalone'` no incluye `public/` — copiar manualmente
- `generateStaticParams` falla = build falla — no hay fallback
- ISR requiere filesystem writable — serverless read-only = ISR no funciona
- `NEXT_PUBLIC_*` baked en build time — cambiar después no tiene efecto
- `.env.local` no existe en CI — secrets de otra fuente
- `process.env.X` en client undefined — solo `NEXT_PUBLIC_X`
- `.next/cache` debe persistir entre builds — o rebuilds 10x más lentos
- Health check a `/` puede ser redirect 308 — usar `/api/health`
- Cold start con muchas rutas = lento — cada ruta es función
- Connection pooling DB no funciona en serverless — nueva conexión cada invocation
- 50MB limit Vercel — easy to hit con dependencies
- Edge runtime no soporta todos Node APIs — packages fallan
- Errores en Server Components no llegan a error tracking client
- Source maps producción requieren config — errores ilegibles sin ellos
