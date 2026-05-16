# Data Fetching Traps

- `async` component que tarda bloquea TODO — envolver en Suspense
- Fetch sin error handling crashea página — usar error.tsx o try/catch
- `fetch` en loop es secuencial — usar Promise.all
- POST/DELETE no cachean pero GET después usa caché viejo
- `revalidate: 0` ≠ `cache: 'no-store'` — comportamiento sutil diferente
- `revalidatePath('/')` NO revalida recursivamente — solo esa ruta
- `revalidateTag` no afecta response actual — solo requests siguientes
- Server action en loop = N requests HTTP — no hay batching
- `redirect()` en try/catch NO funciona — se lanza como error
- Return de server action tiene límite — no devolver datasets grandes
- `loading.tsx` no funciona con `generateStaticParams`
- `useEffect` fetch = waterfall después de SSR
- Fetch en useEffect sin cleanup = race conditions
