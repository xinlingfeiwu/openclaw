# Pattern Traps

- `{count && <X />}` renderiza "0" cuando count=0 — usar `count > 0 &&`
- `{cond ? <A /> : <B />}` mismo type = state preservado
- Key cambiada = unmount + mount — destruye state
- Key del index = bugs con reorder/filter
- Fragmentos con key necesitan `<React.Fragment key>`, no `<>`
- Spreading `{...props}` puede pasar props no deseados a DOM
- `disabled="false"` es truthy — usar `disabled={false}`
- className no class, htmlFor no for
- Ref en function component sin forwardRef = warning
- Refs no disponibles en primer render — useEffect para acceder
- Solo class components pueden ser error boundaries — no hooks
- Error en event handler no capturado por boundary — try/catch
- Portal events bubble en React tree, no DOM tree
