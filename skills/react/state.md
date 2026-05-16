# State Traps

- `array.push()` + `setState(array)` = no re-render — misma referencia
- `obj.prop = x` + `setState(obj)` = no re-render — misma referencia
- Nested mutation `obj.deep.value = x` — spread del outer no basta
- Multiple setState en event = batched, un solo re-render
- setState en setTimeout antes React 18 = múltiples renders
- useState(props) como initial — nunca se actualiza cuando props cambia
- State duplicando props = out of sync cuando props cambia
- Computar en render vs guardar en state — preferir computar
- useEffect para sync state con props = un render de delay
- key prop para resetear state cuando entidad cambia
- Controlled input sin onChange = readonly pero no parece
- Uncontrolled defaultValue después de mount = no actualiza
- File input solo puede ser uncontrolled — value readonly
