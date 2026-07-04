import { useState, useEffect, useCallback } from 'react';

const BASE = '';

export function useApi(endpoint, params = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const query = new URLSearchParams(params).toString();
  const url = `${BASE}${endpoint}${query ? '?' + query : ''}`;

  const fetch_ = useCallback(() => {
    setLoading(true);
    fetch(url)
      .then(r => r.json().then(d => ({ ok: r.ok, status: r.status, d })))
      // A non-ok response's JSON body is still an object like { error: "..." }, not the
      // array/shape callers expect — treating it as data crashed every page that maps or
      // spreads over it (e.g. "e is not iterable") the moment the API returned any error.
      .then(({ ok, status, d }) => {
        if (!ok) throw new Error(d?.error || `Request failed: ${status}`);
        setData(d);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [url]);

  useEffect(() => { fetch_(); }, [fetch_]);

  return { data, loading, error, refetch: fetch_ };
}
