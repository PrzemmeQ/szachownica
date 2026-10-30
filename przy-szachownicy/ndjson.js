// Czytanie strumieni ND-JSON (jedna linia = jeden obiekt JSON).
export async function readNdjson(response, onObject) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try { onObject(JSON.parse(line)); } catch (e) { console.warn('ndjson', e, line); }
      }
    }
  }
  const rest = buf.trim();
  if (rest) {
    try { onObject(JSON.parse(rest)); } catch (e) { console.warn('ndjson', e, rest); }
  }
}
