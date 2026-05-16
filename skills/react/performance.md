# Performance Traps

- Parent re-render = children re-render — aunque props no cambien (sin memo)
- Inline `style={{}}` = nueva referencia cada render
- Inline `onClick={() => {}}` = nueva referencia cada render
- Context value objeto = todos consumers re-renderizan
- memo con object props sin comparador = siempre re-renderiza
- memo no previene re-render si children cambian
- useMemo tiene overhead — no para operaciones triviales
- useCallback sin memoized children = desperdicio
- key={index} con reorder = bugs de estado, animaciones rotas
- key={Math.random()} = unmount/mount cada render
- lazy() de componente pequeño = overhead mayor que beneficio
- Dev mode es MUCHO más lento — profiler en production build
- StrictMode dobla effects — parece más lento de lo que es
