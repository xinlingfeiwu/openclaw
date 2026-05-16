# Hooks Traps

- `useState(expensiveInit)` ejecuta CADA render — usar `useState(() => expensiveInit)`
- `setState(obj)` no mergea — reemplaza completo, spread manual
- `setState(prev + 1)` con closure stale — usar `setState(p => p + 1)`
- Async function como effect = warning — crear async dentro y llamar
- `[]` deps vacío pero usa variables externas = closure stale
- Object/array en deps = loop infinito (nueva referencia cada render)
- `ref.current` cambio no triggerea re-render — a propósito
- Ref en conditional render = ref puede ser null — chequear
- useCallback sin deps = nueva función cada render — no sirve
- useMemo deps incompletos = valor memoizado stale
- Context change re-renderiza TODOS los consumers — aunque usen parte diferente
- Hook dentro de conditional = violation de rules of hooks
